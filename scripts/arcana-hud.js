/* globals Hooks, game, ui, foundry, document, window, console */

// ============================================================
// MD Campaigns SW Tweaks — Major Arcana HUD
//
// A screen-fixed, draggable HUD panel visible to ALL clients,
// showing every Major Arcana currently KEPT as an initiative card:
// the card art (click to enlarge), who drew it, and the effect
// text (from major-arcana.js). The panel is exactly as wide as its
// cards (wrapping to a new row after MAX_PER_ROW), collapsible to
// its title bar, and hidden entirely when no majors are out.
//
// Architecture:
//   - The PRIMARY GM client owns state: updateCombatant /
//     deleteCombatant hooks maintain a self-contained ledger in
//     flags.<MODULE_ID>.arcana on the Combat document — one entry
//     per combatant: {combatantName, cardName, img, effect, slot}.
//   - Combat flag updates replicate to every client automatically,
//     so ALL clients re-render the HUD from the ledger on
//     updateCombat / deleteCombat. No sockets, no documents beyond
//     the flag. Reload-safe: rendered again on ready.
//
// Interception point (verified in SWADE source): every kept-card
// assignment and every reset converges on a Combatant update
// writing system.cardValue — covering manual draws, automatic
// initiative, redraws, Level Headed picks, herder draws, resetAll,
// and previousRound. Holding combatants get no reset update
// (SWADE keeps their card), so their entry persists — intended.
//
// Per-client state (settings, config: false): panel position
// (dragged via the grip, clamped to the viewport) and collapsed.
// ============================================================

import { getMajorEffect } from "./major-arcana.js";

const MODULE_ID = "md-campaigns-sw-tweaks";
const LOG_PREFIX = `${MODULE_ID} |`;
const ARCANA_FLAG = "arcana"; // flags.<MODULE_ID>.arcana on the Combat doc
const HUD_ID = "mdcswt-arcana-hud";

// --- Configurable constants -------------------------------------------------

const CELL_WIDTH_PX = 168; // one card column, art + caption
const CARD_ASPECT = "530 / 920"; // the tarot scans' native ratio
const CELL_GAP_PX = 10;
const MAX_PER_ROW = 5; // wrap to a new row past this many cards
const DEFAULT_POS = { left: 120, top: 80 }; // first-run panel position

// -----------------------------------------------------------------------------

/**
 * Registers settings and hooks. Called from the module's init hook.
 */
export function registerArcanaHud() {
  game.settings.register(MODULE_ID, "arcanaHudEnabled", {
    name: "MDCSWT.Arcana.Enable",
    hint: "MDCSWT.Arcana.EnableHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => renderArcanaHud(),
  });
  game.settings.register(MODULE_ID, "arcanaHudPos", {
    scope: "client",
    config: false,
    type: Object,
    default: DEFAULT_POS,
  });
  game.settings.register(MODULE_ID, "arcanaHudCollapsed", {
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
  });

  // GM-side: maintain the ledger.
  Hooks.on("updateCombatant", onUpdateCombatant);
  Hooks.on("deleteCombatant", onDeleteCombatant);

  // All clients: re-render from the replicated ledger.
  Hooks.on("updateCombat", (combat, changed) => {
    if (foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`)) {
      renderArcanaHud();
    }
  });
  Hooks.on("deleteCombat", () => renderArcanaHud());
  Hooks.once("ready", () => {
    injectStyles();
    renderArcanaHud();
  });
}

/* ============================================================
 * GM-side ledger maintenance
 * ============================================================ */

/**
 * Is this client responsible for ledger writes?
 * @returns {boolean}
 */
function isPrimaryGM() {
  return game.users.activeGM === game.user;
}

/**
 * Finds the dealt card's ORIGINAL in the action deck by value + suit.
 * The original persists there after the deal (dealForInitiative discards a
 * copy to the pile and marks the deck original drawn: true — verified in
 * SWADE source; SWADE's own findCard makes the same assumption). No type
 * filter (unlike SWADE's findCard) so the custom tarot deck's card type
 * doesn't matter.
 * @param {number} cardValue
 * @param {number} suitValue
 * @returns {Card|undefined}
 */
function findDeckCard(cardValue, suitValue) {
  const deck = game.cards.get(game.settings.get("swade", "actionDeck"));
  return deck?.cards.find(
    (c) => c.value === cardValue && c.system?.suit === suitValue
  );
}

/**
 * The card's face art. Deck originals default to face: null (core schema),
 * which makes Card#img fall back to the card BACK — so read faces[0]
 * directly and only fall back to img. The Card document is never modified.
 * @param {Card} card
 * @returns {string}
 */
function cardFaceImg(card) {
  return card.faces?.[0]?.img || card.img;
}

/**
 * Smallest slot index not currently in use, so replacements fill gaps
 * left-to-right instead of drifting rightward all combat.
 * @param {object} ledger
 * @returns {number}
 */
function nextFreeSlot(ledger) {
  const used = new Set(Object.values(ledger).map((e) => e.slot));
  let slot = 0;
  while (used.has(slot)) slot += 1;
  return slot;
}

/**
 * The single interception point: fires for every kept-card assignment
 * (new system.cardValue) and every clear (cardValue: null from resetAll /
 * previousRound / resetInitiative).
 * @param {Combatant} combatant
 * @param {object} changed
 */
async function onUpdateCombatant(combatant, changed) {
  if (!isPrimaryGM()) return;
  if (!foundry.utils.hasProperty(changed, "system.cardValue")) return;
  if (!game.settings.get(MODULE_ID, "arcanaHudEnabled")) return;
  const combat = combatant.parent;
  if (!combat) return;

  try {
    const ledger = combat.getFlag(MODULE_ID, ARCANA_FLAG) ?? {};
    const hadEntry = combatant.id in ledger;
    const cardValue = combatant.system.cardValue;

    // Cleared (round reset) — drop the entry if there was one.
    if (cardValue === null || cardValue === undefined) {
      if (hadEntry) {
        await combat.update({
          [`flags.${MODULE_ID}.${ARCANA_FLAG}.-=${combatant.id}`]: null,
        });
      }
      return;
    }

    const card = findDeckCard(cardValue, combatant.system.suitValue);
    if (!card) {
      console.warn(
        LOG_PREFIX,
        `dealt card not found in action deck (value ${cardValue}, suit ${combatant.system.suitValue})`
      );
      return;
    }

    const effect = getMajorEffect(card.name);
    if (!effect) {
      // Redrew a major into a minor — clear the stale entry.
      if (hadEntry) {
        await combat.update({
          [`flags.${MODULE_ID}.${ARCANA_FLAG}.-=${combatant.id}`]: null,
        });
      }
      return;
    }

    // New or replacement entry; a redraw reuses the combatant's slot.
    const slot = hadEntry ? ledger[combatant.id].slot : nextFreeSlot(ledger);
    await combat.update({
      [`flags.${MODULE_ID}.${ARCANA_FLAG}.${combatant.id}`]: {
        combatantName: combatant.name,
        cardName: effect.name,
        img: cardFaceImg(card),
        effect: effect.text,
        slot,
      },
    });
  } catch (err) {
    console.error(LOG_PREFIX, "arcana ledger update failed", err);
  }
}

/**
 * A combatant removed mid-fight takes its entry with it.
 * @param {Combatant} combatant
 */
async function onDeleteCombatant(combatant) {
  if (!isPrimaryGM()) return;
  const combat = combatant.parent;
  if (!combat) return;
  const ledger = combat.getFlag(MODULE_ID, ARCANA_FLAG) ?? {};
  if (combatant.id in ledger) {
    await combat.update({
      [`flags.${MODULE_ID}.${ARCANA_FLAG}.-=${combatant.id}`]: null,
    });
  }
}

/* ============================================================
 * Rendering (all clients)
 * ============================================================ */

/**
 * Injects the HUD stylesheet once. The module ships no CSS file (no
 * module.json change), so styles are installed from here.
 */
function injectStyles() {
  if (document.getElementById(`${HUD_ID}-style`)) return;
  const maxRowWidth =
    MAX_PER_ROW * CELL_WIDTH_PX + (MAX_PER_ROW - 1) * CELL_GAP_PX;
  const style = document.createElement("style");
  style.id = `${HUD_ID}-style`;
  style.textContent = `
#${HUD_ID} {
  position: fixed;
  z-index: 60;
  background: rgba(16, 14, 20, 0.88);
  border: 1px solid rgba(201, 168, 106, 0.55);
  border-radius: 10px;
  padding: 0 10px 10px;
  color: #d6d2c8;
  font-family: var(--font-primary, sans-serif);
  user-select: none;
}
#${HUD_ID} .mdcswt-arcana-grip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 5px 4px;
  cursor: grab;
  color: #c9a86a;
  font-size: 11px;
  letter-spacing: 0.14em;
}
#${HUD_ID} .mdcswt-arcana-grip:active { cursor: grabbing; }
#${HUD_ID} .mdcswt-arcana-collapse {
  background: none;
  border: none;
  color: #c9a86a;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
  width: auto;
}
#${HUD_ID} .mdcswt-arcana-cards {
  display: flex;
  flex-wrap: wrap;
  gap: ${CELL_GAP_PX}px;
  align-items: stretch;
  max-width: ${maxRowWidth}px;
}
#${HUD_ID}.collapsed .mdcswt-arcana-cards { display: none; }
#${HUD_ID}.collapsed { padding-bottom: 0; }
#${HUD_ID} .mdcswt-arcana-cell {
  width: ${CELL_WIDTH_PX}px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
#${HUD_ID} .mdcswt-arcana-cell img {
  width: 100%;
  aspect-ratio: ${CARD_ASPECT};
  object-fit: cover;
  border: 1px solid rgba(201, 168, 106, 0.4);
  border-radius: 6px;
  cursor: pointer;
}
#${HUD_ID} .mdcswt-arcana-caption {
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(201, 168, 106, 0.25);
  border-radius: 6px;
  padding: 6px 8px;
  flex: 1;
}
#${HUD_ID} .mdcswt-arcana-caption .name {
  color: #e8d5a8;
  font-size: 12px;
  font-weight: 600;
}
#${HUD_ID} .mdcswt-arcana-caption .card-name {
  color: #c9a86a;
  font-size: 11px;
  font-style: italic;
  margin-bottom: 3px;
}
#${HUD_ID} .mdcswt-arcana-caption .effect {
  color: #d6d2c8;
  font-size: 11px;
  line-height: 1.45;
}`;
  document.head.appendChild(style);
}

/**
 * Renders (or removes) the HUD from the viewed combat's ledger. Runs on
 * every client. The panel exists only while it has entries.
 */
export function renderArcanaHud() {
  const existing = document.getElementById(HUD_ID);
  const combat = game.combats?.viewed ?? null;
  const enabled = game.settings.get(MODULE_ID, "arcanaHudEnabled");
  const ledger = (enabled && combat?.getFlag(MODULE_ID, ARCANA_FLAG)) || {};
  const entries = Object.values(ledger).sort((a, b) => a.slot - b.slot);

  if (!entries.length) {
    existing?.remove();
    return;
  }

  const hud = existing ?? buildShell();
  const cards = hud.querySelector(".mdcswt-arcana-cards");
  cards.replaceChildren(
    ...entries.map((entry) => {
      const cell = document.createElement("div");
      cell.className = "mdcswt-arcana-cell";

      const img = document.createElement("img");
      img.src = entry.img;
      img.alt = entry.cardName;
      img.addEventListener("click", () => {
        new foundry.applications.apps.ImagePopout({
          src: entry.img,
          window: { title: entry.cardName },
        }).render({ force: true });
      });

      const caption = document.createElement("div");
      caption.className = "mdcswt-arcana-caption";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = entry.combatantName;
      const cardName = document.createElement("div");
      cardName.className = "card-name";
      cardName.textContent = entry.cardName;
      const effect = document.createElement("div");
      effect.className = "effect";
      effect.textContent = entry.effect;
      caption.append(name, cardName, effect);

      cell.append(img, caption);
      return cell;
    })
  );

  hud.classList.toggle(
    "collapsed",
    game.settings.get(MODULE_ID, "arcanaHudCollapsed")
  );
  applyPosition(hud);
}

/**
 * Builds the panel shell (grip bar + collapse chevron + card row) once
 * and wires drag + collapse. Appended to document.body so it never
 * fights the canvas.
 * @returns {HTMLElement}
 */
function buildShell() {
  const hud = document.createElement("div");
  hud.id = HUD_ID;

  const grip = document.createElement("div");
  grip.className = "mdcswt-arcana-grip";
  const title = document.createElement("span");
  title.textContent = game.i18n.localize("MDCSWT.Arcana.HudTitle");
  const chevron = document.createElement("button");
  chevron.className = "mdcswt-arcana-collapse";
  chevron.type = "button";
  chevron.innerHTML = '<i class="fas fa-chevron-up"></i>';
  chevron.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const collapsed = !game.settings.get(MODULE_ID, "arcanaHudCollapsed");
    await game.settings.set(MODULE_ID, "arcanaHudCollapsed", collapsed);
    hud.classList.toggle("collapsed", collapsed);
    chevron.innerHTML = `<i class="fas fa-chevron-${collapsed ? "down" : "up"}"></i>`;
  });
  grip.append(title, chevron);
  wireDrag(hud, grip);

  const cards = document.createElement("div");
  cards.className = "mdcswt-arcana-cards";

  hud.append(grip, cards);
  document.body.appendChild(hud);

  if (game.settings.get(MODULE_ID, "arcanaHudCollapsed")) {
    chevron.innerHTML = '<i class="fas fa-chevron-down"></i>';
  }
  return hud;
}

/**
 * Applies the stored per-client position, clamped to the viewport so a
 * resolution change can't strand the panel off-screen.
 * @param {HTMLElement} hud
 */
function applyPosition(hud) {
  const pos = game.settings.get(MODULE_ID, "arcanaHudPos") ?? DEFAULT_POS;
  const rect = hud.getBoundingClientRect();
  const left = Math.max(
    0,
    Math.min(pos.left ?? DEFAULT_POS.left, window.innerWidth - Math.max(rect.width, 60))
  );
  const top = Math.max(
    0,
    Math.min(pos.top ?? DEFAULT_POS.top, window.innerHeight - 40)
  );
  hud.style.left = `${left}px`;
  hud.style.top = `${top}px`;
}

/**
 * Plain pointer-event drag on the grip; final position persists to the
 * per-client setting.
 * @param {HTMLElement} hud
 * @param {HTMLElement} grip
 */
function wireDrag(hud, grip) {
  grip.addEventListener("pointerdown", (down) => {
    if (down.target.closest(".mdcswt-arcana-collapse")) return;
    down.preventDefault();
    const startLeft = hud.offsetLeft;
    const startTop = hud.offsetTop;
    const originX = down.clientX;
    const originY = down.clientY;

    const onMove = (move) => {
      hud.style.left = `${startLeft + move.clientX - originX}px`;
      hud.style.top = `${startTop + move.clientY - originY}px`;
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      await game.settings.set(MODULE_ID, "arcanaHudPos", {
        left: hud.offsetLeft,
        top: hud.offsetTop,
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}
