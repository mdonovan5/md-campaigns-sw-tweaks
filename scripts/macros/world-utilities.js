/* globals game, canvas, ui, console, Dialog, CSS, document */

// ============================================================
// MD Campaigns SW Tweaks — small world utilities
//
// syncVision():           copies the selected token's sight config to every
//                         token of the same actor name on the scene.
// clearMovement():        GM only — clears combat movement history for the
//                         selected tokens across all scene combats.
// fixStaleAuthors():      strips ownership entries pointing at deleted users
//                         from every world actor.
// toggleSceneNavigation(): show/hide the scene nav bar via an injected
//                         CSS rule (client-side, per-user).
// deleteRecentMessages(): GM only — deletes chat messages from the last
//                         X seconds after a preview + confirm.
//
// Public API: game.modules.get(MODULE_ID).api.<functionName>()
// ============================================================

export async function syncVision() {
  const token = canvas.tokens.controlled[0];
  if (!token) return ui.notifications.warn("Select a token first.");

  const sight = token.document.toObject().sight;
  const updates = canvas.scene.tokens.reduce((acc, t) => {
    if (t.actor?.name === token.actor.name) acc.push({ _id: t.id, sight: sight });
    return acc;
  }, []);
  await canvas.scene.updateEmbeddedDocuments("Token", updates);
}

export async function clearMovement() {
  if (!game.user.isGM) return ui.notifications.warn("GM only.");

  const sel = canvas.tokens.controlled;
  if (!sel.length) return ui.notifications.warn("Select one or more tokens first.");

  // Gather combatants for each selected token across all scene combats.
  const byCombat = new Map(); // Map<Combat, Combatant[]>
  for (const combat of game.combats.combats ?? []) { // combats for the current scene
    for (const t of sel) {
      const ct = combat.combatants.find(c => c.tokenId === t.document.id);
      if (ct) {
        const arr = byCombat.get(combat) ?? [];
        arr.push(ct);
        byCombat.set(combat, arr);
      }
    }
  }

  if (!byCombat.size) return ui.notifications.info("No selected tokens are in any combat.");

  // Clear histories per-encounter
  let n = 0;
  for (const [combat, combatants] of byCombat) {
    await combat.clearMovementHistories(combatants);
    n += combatants.length;
  }
  ui.notifications.info(`Cleared movement history for ${n} token(s).`);
}

export async function fixStaleAuthors() {
  const valid = new Set(game.users.map(u => u.id));
  for (const actor of game.actors) {
    const stale = Object.keys(actor.ownership).filter(k => k !== "default" && !valid.has(k));
    if (!stale.length) continue;
    const update = {};
    for (const id of stale) update[`ownership.-=${id}`] = null;
    await actor.update(update);
    console.log(`Cleaned ${actor.name}:`, stale);
  }
}

export async function toggleSceneNavigation() {
  const id = ui.nav.id;                     // the actual element ID, not assumed
  const esc = CSS?.escape ?? (s => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
  const STYLE_ID = "toggle-hide-scene-nav-v13";
  let tag = document.getElementById(STYLE_ID);

  if (tag) {
    tag.remove();
    ui.notifications.info("Scene Navigation: shown");
  } else {
    tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = `#${esc(id)} { display: none !important; }`;
    document.head.appendChild(tag);
    ui.notifications.info("Scene Navigation: hidden");
  }
}

export async function deleteRecentMessages() {
  if (!game.user.isGM) return ui.notifications.warn("GM only.");

  const seconds = Number(await Dialog.prompt({
    title: "Delete Recent Chat",
    content: `<p>Delete messages from the last <input id="secs" type="number" min="1" value="60" style="width:6em"> seconds?</p>`,
    label: "Preview",
    callback: html => html.find("#secs").val()
  }));

  if (!Number.isFinite(seconds) || seconds <= 0) return;

  const cutoff = Date.now() - seconds * 1000;
  const recent = game.messages.filter(m => m.timestamp >= cutoff);

  if (!recent.length) return ui.notifications.info("No chat messages in that window.");

  const go = await Dialog.confirm({
    title: "Confirm Deletion",
    content: `<p>This will permanently delete <b>${recent.length}</b> message(s) from the last <b>${seconds}</b> seconds.</p>`
  });
  if (!go) return;

  // Delete them (iterate to keep it compatible across versions)
  for (const msg of recent) {
    try { await msg.delete(); } catch (e) { console.warn("Delete failed for", msg, e); }
  }

  ui.notifications.info(`Deleted ${recent.length} recent chat message(s).`);
}
