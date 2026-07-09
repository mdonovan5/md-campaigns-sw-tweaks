/* globals game, canvas, ui, Hooks, ChatMessage, foundry, console */

// ============================================================
// MD Campaigns SW Tweaks — Group Trait Roll
//
// GM-only. Rolls a trait (attribute or skill) on all selected
// tokens through the BR2 card pipeline. Skills an actor lacks
// roll as untrained attempts per the house rule via the BR2
// fork's create_untrained_skill_card API (d4, modifier of half
// the linked attribute die minus 5 capped at +1, wild die d4;
// no item is created on the actor). The linked attribute is
// resolved from an embedded skill on another selected actor,
// then from BR2's cached skill data, then by asking the GM.
// Five "<Attribute> Skill" entries cover skills nobody has.
//
// Requires the BR2 fork with game.brsw.create_untrained_skill_card.
//
// Public API: game.modules.get(MODULE_ID).api.rollGroupTrait()
// ============================================================

const MODULE_ID = "md-campaigns-sw-tweaks";
const LOG_PREFIX = `${MODULE_ID} |`;

// --- Configurable constants -------------------------------------------------

// Attribute order for the dialog (also BR2's canonical list).
const ATTRIBUTES = ["agility", "smarts", "spirit", "strength", "vigor"];
const ATTRIBUTE_I18N = {
  agility: "SWADE.AttrAgi",
  smarts: "SWADE.AttrSma",
  spirit: "SWADE.AttrSpr",
  strength: "SWADE.AttrStr",
  vigor: "SWADE.AttrVig",
};

// Mirror of BRSW2_CONST.UNTRAINED_SKILLS (betteroll-swade2 brsw2-const.js),
// used to recognize an existing untrained-style skill item by name.
const UNTRAINED_SKILL_NAMES = [
  "untrained",
  "untrainiert",
  "desentrenada",
  "non entraine",
  "non entrainé",
  "unskilled",
  "unskilled attempt",
  "(unskilled)",
];

// -----------------------------------------------------------------------------

/**
 * Normalizes a skill name the same way BR2's traitFromString does:
 * lowercase and strip the core-skill star prefix.
 * @param {string} name
 * @returns {string}
 */
function normalizeSkillName(name) {
  return name.toLowerCase().replace("★ ", "").trim();
}

/**
 * Finds a skill item on an actor by normalized name (exact match).
 * @param {Actor} actor
 * @param {string} normalizedName
 * @returns {Item|undefined}
 */
function findSkillByName(actor, normalizedName) {
  return actor.items.find(
    (item) =>
      item.type === "skill" &&
      normalizeSkillName(item.name) === normalizedName,
  );
}

/**
 * True if a skill item's name marks it as an untrained-style skill,
 * using the same includes-match BR2's findFirstSkillInActor uses.
 * @param {Item} item
 * @returns {boolean}
 */
function isUntrainedSkillItem(item) {
  if (item.type !== "skill") {
    return false;
  }
  const names = [
    ...UNTRAINED_SKILL_NAMES,
    game.i18n.localize("BRSW.SkillName.UnskilledAttempt").toLowerCase(),
  ];
  const itemName = item.name.toLowerCase();
  return names.some((n) => itemName.includes(n));
}

/**
 * Resolves a skill's linked attribute from BR2's cached skill data
 * (skill compendia plus world items, built by BR2 at ready). Mirrors
 * the fork's Utils.attributeForSkillName lookup order.
 * @param {string} normalizedName
 * @returns {string} attribute key or ""
 */
function attributeFromSkillsData(normalizedName) {
  const data = game.brsw?.SKILLS_DATA;
  if (!normalizedName || !data) {
    return "";
  }
  const swid = game.swade.util.slugify(normalizedName);
  if (data[normalizedName]) {
    return data[normalizedName].attribute;
  }
  if (data[swid]) {
    return data[swid].attribute;
  }
  for (const skillData of Object.values(data)) {
    if (skillData.name.toLowerCase() === normalizedName) {
      return skillData.attribute;
    }
  }
  return "";
}

/**
 * Resolves a skill's linked attribute from an embedded skill item on any
 * of the selected tokens' actors (the best source: whoever has the skill
 * defines its attribute at this table).
 * @param {Token[]} tokens
 * @param {string} normalizedName
 * @returns {string} attribute key or ""
 */
function attributeFromSelectedTokens(tokens, normalizedName) {
  for (const token of tokens) {
    const skill = findSkillByName(token.actor, normalizedName);
    if (skill?.system.attribute) {
      return skill.system.attribute;
    }
  }
  return "";
}

/**
 * Asks the GM which attribute an unknown skill is linked to.
 * @param {string} skillLabel Display name of the skill being resolved
 * @returns {Promise<string|null>} attribute key or null on cancel
 */
async function showAttributeDialog(skillLabel) {
  const loc = (key) => game.i18n.localize(key);
  return foundry.applications.api.DialogV2.wait({
    window: { title: `${loc("MDCSWT.GroupRoll.Title")} — ${skillLabel}` },
    content: `<p>${loc("MDCSWT.GroupRoll.Attributes")}?</p>`,
    rejectClose: false,
    buttons: ATTRIBUTES.map((a) => ({
      action: a,
      label: loc(ATTRIBUTE_I18N[a]),
    })),
  });
}

/**
 * Builds the union of skill names across the given tokens' actors.
 * Untrained-style skills are excluded (the dialog has an explicit entry).
 * @param {Token[]} tokens
 * @returns {{value: string, label: string}[]} sorted skill options
 */
function buildSkillUnion(tokens) {
  const seen = new Map(); // normalized name -> display name (first seen)
  for (const token of tokens) {
    for (const item of token.actor.items) {
      if (item.type !== "skill" || isUntrainedSkillItem(item)) {
        continue;
      }
      const normalized = normalizeSkillName(item.name);
      if (!seen.has(normalized)) {
        seen.set(normalized, item.name.replace("★ ", "").trim());
      }
    }
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Shows the main dialog. Resolves to the user's choices or null on cancel.
 * @param {{value: string, label: string}[]} skillOptions
 * @returns {Promise<{trait: string, modifier: number,
 *   privateRoll: boolean, autoRoll: boolean}|null>}
 */
async function showTraitDialog(skillOptions) {
  const loc = (key) => game.i18n.localize(key);
  const attributeOptions = ATTRIBUTES.map(
    (a) => `<option value="attribute:${a}">${loc(ATTRIBUTE_I18N[a])}</option>`,
  ).join("");
  const skillOptionsHtml = skillOptions
    .map((s) => `<option value="skill:${s.value}">${s.label}</option>`)
    .join("");
  // Untrained attempts keyed directly on an attribute, for skills nobody
  // in the selection has: "Agility Skill", "Smarts Skill", ...
  const skillWord = loc("TYPES.Item.skill");
  const untrainedOptions = ATTRIBUTES.map(
    (a) =>
      `<option value="untrained:${a}">${loc(ATTRIBUTE_I18N[a])} ${skillWord}</option>`,
  ).join("");
  const content = `
    <div class="form-group">
      <label>${loc("MDCSWT.GroupRoll.Trait")}</label>
      <select name="trait" autofocus>
        <optgroup label="${loc("MDCSWT.GroupRoll.Attributes")}">
          ${attributeOptions}
        </optgroup>
        <optgroup label="${loc("MDCSWT.GroupRoll.Skills")}">
          ${skillOptionsHtml}
        </optgroup>
        <optgroup label="${loc("MDCSWT.GroupRoll.Special")}">
          ${untrainedOptions}
          <option value="other">${loc("MDCSWT.GroupRoll.Other")}</option>
        </optgroup>
      </select>
    </div>
    <div class="form-group">
      <label>${loc("MDCSWT.GroupRoll.Modifier")}</label>
      <input type="number" name="modifier" step="1" placeholder="0">
    </div>
    <div class="form-group">
      <label>${loc("MDCSWT.GroupRoll.PrivateRoll")}</label>
      <input type="checkbox" name="privateRoll">
    </div>
    <div class="form-group">
      <label>${loc("MDCSWT.GroupRoll.AutoRoll")}</label>
      <input type="checkbox" name="autoRoll" checked>
    </div>`;
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: loc("MDCSWT.GroupRoll.Title") },
    content: content,
    rejectClose: false,
    buttons: [
      {
        action: "roll",
        label: loc("MDCSWT.GroupRoll.Roll"),
        default: true,
        callback: (event, button) => {
          const form = button.form.elements;
          const rawModifier = Number(form.modifier.value);
          return {
            trait: form.trait.value,
            modifier: Number.isFinite(rawModifier) ? rawModifier : 0,
            privateRoll: form.privateRoll.checked,
            autoRoll: form.autoRoll.checked,
          };
        },
      },
      {
        action: "cancel",
        label: loc("MDCSWT.GroupRoll.Cancel"),
        callback: () => null,
      },
    ],
  });
  return result && typeof result === "object" ? result : null;
}

/**
 * Shows the "Other..." dialog. Resolves to the entered skill name or null.
 * @returns {Promise<string|null>}
 */
async function showOtherDialog() {
  const loc = (key) => game.i18n.localize(key);
  const content = `
    <div class="form-group">
      <label>${loc("MDCSWT.GroupRoll.OtherLabel")}</label>
      <input type="text" name="skillName" autofocus>
    </div>`;
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: loc("MDCSWT.GroupRoll.OtherTitle") },
    content: content,
    rejectClose: false,
    buttons: [
      {
        action: "ok",
        label: loc("MDCSWT.GroupRoll.Roll"),
        default: true,
        callback: (event, button) => button.form.elements.skillName.value,
      },
      {
        action: "cancel",
        label: loc("MDCSWT.GroupRoll.Cancel"),
        callback: () => null,
      },
    ],
  });
  return typeof result === "string" && result.trim() ? result.trim() : null;
}

/**
 * Creates the BR2 card for one token and the chosen trait. Actors who
 * lack the chosen skill make an untrained attempt per the house rule via
 * the fork API (detached trait data, no item touched).
 * @param {Token} token
 * @param {{kind: string, name: string, label: string,
 *   attribute: string}} selection
 * @returns {Promise<object>} the BrCommonCard
 */
async function createCardForToken(token, selection) {
  if (selection.kind === "attribute") {
    return game.brsw.create_attribute_card_from_id(
      token.id,
      token.actor.id,
      selection.name,
    );
  }
  if (selection.kind === "skill") {
    const skill = findSkillByName(token.actor, selection.name);
    if (skill) {
      return game.brsw.create_skill_card(token, skill.id);
    }
    // Untrained attempt named after the attempted skill, so blind traits
    // and name-keyed global actions keep matching.
    return game.brsw.create_untrained_skill_card(token, selection.attribute, {
      skill_name: selection.label,
    });
  }
  // kind === "untrained": attribute-based attempt named like the dialog
  // entry ("Agility Skill", ...).
  return game.brsw.create_untrained_skill_card(token, selection.attribute, {
    skill_name: selection.label,
  });
}

/**
 * Main entry point: dialog, then one BR2 card per selected token.
 * @returns {Promise<void>}
 */
export async function rollGroupTrait() {
  const loc = (key) => game.i18n.localize(key);
  if (!game.user.isGM) {
    ui.notifications.warn(loc("MDCSWT.GroupRoll.GMOnly"));
    return;
  }
  if (!game.brsw?.create_skill_card || !game.brsw?.create_untrained_skill_card) {
    ui.notifications.error(loc("MDCSWT.GroupRoll.NoBR2"));
    return;
  }

  const tokens = [];
  for (const token of canvas.tokens.controlled) {
    if (!token.actor) {
      ui.notifications.warn(
        `${loc("MDCSWT.GroupRoll.NoActor")}: ${token.name}`,
      );
    } else if (token.actor.type === "vehicle") {
      ui.notifications.warn(
        `${loc("MDCSWT.GroupRoll.VehicleSkipped")}: ${token.name}`,
      );
    } else {
      tokens.push(token);
    }
  }
  if (!tokens.length) {
    ui.notifications.warn(loc("MDCSWT.GroupRoll.NoTokens"));
    return;
  }

  const skillUnion = buildSkillUnion(tokens);
  const choices = await showTraitDialog(skillUnion);
  if (!choices) {
    return;
  }

  // Resolve the selection into {kind, name, label, attribute}.
  let selection;
  if (choices.trait === "other") {
    const otherName = await showOtherDialog();
    if (!otherName) {
      return;
    }
    selection = {
      kind: "skill",
      name: normalizeSkillName(otherName),
      label: otherName.replace("★ ", "").trim(),
      attribute: "",
    };
  } else {
    const [kind, ...rest] = choices.trait.split(":");
    const name = rest.join(":");
    selection = { kind: kind, name: name, label: name, attribute: "" };
    if (kind === "untrained") {
      selection.attribute = name;
      selection.label = `${loc(ATTRIBUTE_I18N[name])} ${loc("TYPES.Item.skill")}`;
    } else if (kind === "skill") {
      const union = skillUnion.find((s) => s.value === name);
      if (union) {
        selection.label = union.label;
      }
    }
  }

  // For skill selections, pre-resolve the linked attribute once so any
  // actor lacking the skill can make an untrained attempt: an embedded
  // skill on a selected actor wins, then BR2's cached skill data, then
  // the GM is asked.
  if (selection.kind === "skill") {
    const everyoneHasIt = tokens.every((token) =>
      findSkillByName(token.actor, selection.name),
    );
    if (!everyoneHasIt) {
      selection.attribute =
        attributeFromSelectedTokens(tokens, selection.name) ||
        attributeFromSkillsData(selection.name) ||
        (await showAttributeDialog(selection.label));
      if (!selection.attribute) {
        return;
      }
    }
  }

  // Phase 1 — create all cards. If privateRoll is set, a scoped
  // preCreateChatMessage hook stamps GM-whisper on our cards so they are
  // born private (never flip the global core messageMode setting).
  const cards = [];
  let hookId = null;
  if (choices.privateRoll) {
    const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
    const tokenIds = new Set(tokens.map((t) => t.id));
    const actorIds = new Set(tokens.map((t) => t.actor.id));
    hookId = Hooks.on("preCreateChatMessage", (doc, data) => {
      const speaker = data.speaker || {};
      if (tokenIds.has(speaker.token) || actorIds.has(speaker.actor)) {
        doc.updateSource({ whisper: gmIds });
      }
    });
  }
  try {
    for (const token of tokens) {
      try {
        const card = await createCardForToken(token, selection);
        if (choices.modifier) {
          // BR2's own manual-modifiers channel: persisted in the card flags,
          // consumed by get_roll_options at roll time (auto or manual).
          card.manual_mods ??= {};
          card.manual_mods.trait_mods = [String(choices.modifier)];
          await card.save();
        }
        cards.push(card);
      } catch (error) {
        console.error(LOG_PREFIX, `card creation failed for ${token.name}`, error);
        ui.notifications.error(
          `${loc("MDCSWT.GroupRoll.CardFailed")}: ${token.name}`,
        );
      }
    }
  } finally {
    if (hookId !== null) {
      Hooks.off("preCreateChatMessage", hookId);
    }
  }

  // Phase 2 — roll, if requested.
  if (choices.autoRoll) {
    for (const card of cards) {
      try {
        if (card.attribute_name) {
          await game.brsw.roll_attribute(card, false);
        } else {
          await game.brsw.roll_skill(card, false);
        }
      } catch (error) {
        console.error(LOG_PREFIX, "roll failed", error);
      }
    }
  }
}
