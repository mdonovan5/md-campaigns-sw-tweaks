/* globals Hooks, document */

// ============================================================
// MD Campaigns SW Tweaks — Major Arcana effect table + chat hook
//
// Single source of truth for Major Arcana effect text, shared by:
//   - the chat-card append on every Action-Deck draw (this file)
//   - the on-scene card placement (arcana-on-scene.js)
//
// Moved here from the world script. Curate freely: each value is
// the text shown. Keys should match the card document names; the
// lookup is tolerant of a missing/present "The " prefix and case.
//
// Public API: game.modules.get(MODULE_ID).api.majorEffects
// ============================================================

export const MAJOR_EFFECTS = {
  "The Fool":           `Beginner's Luck — the first natural 1 on a Trait die this round explodes as an Ace.`,
  "The Magician":       `Focused Will — +2 to one Trait roll this turn.`,
  "The High Priestess": `Intuition — re-roll one failed Notice or Smarts roll this round (free).`,
  "The Empress":        `Nurture — you or an adjacent ally removes Shaken or one Fatigue.`,
  "The Emperor":        `Command — free Support action to one ally (+1, or +2 with a raise).`,
  "The Hierophant":     `Blessing — one ally re-rolls a single failed Trait roll this round.`,
  "The Lovers":         `Perfect Pair — you and one ally each get +2 to Gang Up on a shared target.`,
  "The Chariot":        `Momentum — +2 Pace; move through one enemy's space this round.`,
  "Strength":           `Inner Fortitude — +2 to Soak rolls this round, or ignore one Wound penalty.`,
  "The Hermit":         `Lantern's Light — you and adjacent allies ignore Illumination penalties this round.`,
  "Wheel of Fortune":   `Spin the Wheel — gain one Benny now; lost if unused by end of round.`,
  "Justice":            `Retribution — the first time you're hit this round, free counterattack if adjacent.`,
  "The Hanged Man":     `New Perspective — +2 to your next Notice, Smarts (Tactics), or Test roll.`,
  "Death":              `Reaper's Mark — +2 damage vs Shaken or Wounded enemies this round.`,
  "Temperance":         `Equilibrium — remove one Wound or Fatigue from yourself or an adjacent ally.`,
  "The Devil":          `Temptation's Power — one reckless attack at +2/+2, no defense penalty.`,
  "The Tower":          `Shockwave — adjacent foes roll Agility/Strength or be knocked back 1" and Distracted.`,
  "The Star":           `Beacon of Hope — one ally removes Shaken; you gain +1 to your next roll.`,
  "The Moon":           `Lunar Fear — one enemy in sight rolls Spirit or becomes Shaken.`,
  "The Sun":            `Radiance — +2 to one Trait roll and +1 to damage this turn.`,
  "Judgment":           `Absolution — cancel one negative status on you or an ally; grant +1 to their next roll.`,
  "The World":          `Wholeness — you and all allies who can see you each remove one Shaken or Fatigue.`,
};

// Normalized lookup: strips a leading "The " and lowercases, so the
// table matches whether or not the deck's document names carry the
// article (the deck builder dropped the prefix on some majors).
const NORMALIZED_EFFECTS = Object.entries(MAJOR_EFFECTS).reduce(
  (acc, [name, text]) => {
    acc[normalizeArcanaName(name)] = { name, text };
    return acc;
  },
  {}
);

/**
 * Normalizes a card name for Major Arcana lookup.
 * @param {string} name
 * @returns {string}
 */
function normalizeArcanaName(name) {
  return (name ?? "").toLowerCase().replace(/^the\s+/, "").trim();
}

/**
 * Looks up the Major Arcana effect for a card name.
 * @param {string} name                        Card document name.
 * @returns {{name: string, text: string}|undefined}  Canonical name + effect
 *                                             text, or undefined for minors.
 */
export function getMajorEffect(name) {
  return NORMALIZED_EFFECTS[normalizeArcanaName(name)];
}

/**
 * Appends the Major Arcana effect text to a SWADE card-draw chat message.
 * Message flags verified in SWADE source: `flags.swade.pickedCard` (card id)
 * and `flags.swade.cards` (drawn card objects) — see CardMessage data model.
 * @param {ChatMessage} message
 * @param {HTMLElement} htmlEl
 */
function appendTarotEffect(message, htmlEl) {
  const f = message.flags?.swade;
  if (!f?.pickedCard) return; // not a card-draw message
  const picked = (f.cards ?? []).find((c) => c._id === f.pickedCard);
  const effect = getMajorEffect(picked?.name);
  if (!effect) return; // minors are skipped
  if (htmlEl.querySelector?.(".tarot-major-effect")) return; // no double-append
  const div = document.createElement("div");
  div.className = "tarot-major-effect";
  div.style.cssText =
    "margin-top:.4em;padding-top:.4em;border-top:1px solid var(--color-border-light-tertiary,#7a7971);font-size:.95em;";
  div.innerHTML = `<i class="fa-solid fa-wand-sparkles"></i> <strong>${effect.name}</strong> — ${effect.text}`;
  (htmlEl.querySelector?.(".message-content") ?? htmlEl).appendChild(div);
}

/**
 * Registers the chat-append hook. v14-only: renderChatMessageHTML passes an
 * HTMLElement (the jQuery renderChatMessage fallback from the world script
 * was v12 compat and is dropped).
 */
export function registerArcanaChatHook() {
  Hooks.on("renderChatMessageHTML", (msg, html) => appendTarotEffect(msg, html));
}
