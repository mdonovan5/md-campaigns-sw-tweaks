/* globals game, canvas, ui, foundry */

// ============================================================
// Token tools — untrained skill roller & PC token selector
// ============================================================

const ATTRIBUTES = ["agility", "smarts", "spirit", "strength", "vigor"];

/**
 * True if a token represents a player character.
 * @param {Token} token
 * @returns {boolean}
 */
function isPlayerCharacterToken(token) {
  return token.actor?.type === "character";
}

/**
 * Select every player-character token on the current scene.
 * Releases the current selection first.
 * @returns {Token[]} the tokens that were selected
 */
export function selectPlayerCharacterTokens() {
  const pcs = canvas.tokens.placeables.filter(isPlayerCharacterToken);
  if (!pcs.length) {
    ui.notifications.warn("No player-character tokens on this scene.");
    return [];
  }
  canvas.tokens.releaseAll();
  for (const token of pcs) token.control({ releaseOthers: false });
  return pcs;
}

/**
 * Dialog that lets the user pick which character tokens to roll for,
 * used when nothing is selected. Offers the player-character tokens
 * on the current scene as checkboxes (all checked by default).
 * @returns {Promise<Token[]|null>} chosen tokens, or null if cancelled
 */
async function promptForTokens() {
  const pcs = canvas.tokens.placeables.filter(isPlayerCharacterToken);
  if (!pcs.length) {
    ui.notifications.warn(
      "No tokens selected and no player-character tokens on this scene.",
    );
    return null;
  }
  const rows = pcs
    .map(
      (t) =>
        `<label style="display:flex;align-items:center;gap:0.5em;margin:0.2em 0;">
          <input type="checkbox" name="token" value="${t.id}" checked>
          <img src="${t.document.texture.src}" width="28" height="28"
               style="border:none;object-fit:cover;">
          <span>${foundry.utils.escapeHTML(t.name)}</span>
        </label>`,
    )
    .join("");
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: "Select Characters" },
    content: `<p>No tokens are selected. Choose who rolls:</p>${rows}`,
    buttons: [
      {
        action: "ok",
        label: "Roll",
        default: true,
        callback: (event, button) =>
          Array.from(
            button.form.querySelectorAll("input[name=token]:checked"),
          ).map((el) => el.value),
      },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  });
  if (!Array.isArray(result) || !result.length) return null;
  return result
    .map((id) => canvas.tokens.get(id))
    .filter((t) => t?.actor);
}

/**
 * Show an attribute-picker dialog ("Untrained Agility Skill", ...) and
 * create a BR2 untrained-skill card for each selected character token.
 * If no tokens are selected, prompts the user to pick some.
 * Requires the BR2 fork's untrained-skill API.
 */
export async function rollUntrainedSkill() {
  if (!game.brsw?.create_untrained_skill_card) {
    ui.notifications.error(
      "Better Rolls 2 untrained-skill support is not available.",
    );
    return;
  }
  let tokens = canvas.tokens.controlled.filter((t) => t.actor);
  if (!tokens.length) {
    tokens = await promptForTokens();
    if (!tokens) return;
  }
  const attribute = await foundry.applications.api.DialogV2.wait({
    window: { title: "Untrained Skill Roll" },
    content: "<p>Choose the linked attribute:</p>",
    buttons: ATTRIBUTES.map((key) => ({
      action: key,
      label: `Untrained ${key.charAt(0).toUpperCase() + key.slice(1)} Skill`,
    })),
    rejectClose: false,
  });
  if (!attribute || !ATTRIBUTES.includes(attribute)) return;
  const skillName = `Untrained ${
    attribute.charAt(0).toUpperCase() + attribute.slice(1)
  } Skill`;
  for (const token of tokens) {
    await game.brsw.create_untrained_skill_card(token, attribute, {
      skill_name: skillName,
    });
  }
}
