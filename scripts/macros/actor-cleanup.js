/* globals game, ui, console, foundry */

// ============================================================
// MD Campaigns SW Tweaks — actor cleanup
//
// cleanupActors(): GM only. Three jobs across all world actors
// and unlinked scene token actors:
//  1. Remove Untrained-style skill items (superseded by the BR2
//     fork's untrained-attempt house rule).
//  2. Strip "Wild Attack" entries from items' inner action lists
//     (system.actions.additional) — the SWPF-added macros. The
//     action items themselves are kept.
//  3. Dedupe action-type items: several action items with the
//     same name keep one copy and delete the rest. The keeper is
//     the copy with the most inner actions left after job 2's
//     stripping; ties keep the first in actor order.
// Scans first and logs every match to the console, then shows a
// confirmation dialog with counts before deleting anything.
//
// Public API: game.modules.get(MODULE_ID).api.cleanupActors()
// ============================================================

// --- Configurable constants -------------------------------------------------

const DRY_RUN = false; // true = scan and report only, never delete
const WILD_ATTACK_MATCH = /^wild attack$/i; // inner action name match
// true = strip EVERY inner action from every item, regardless of name.
// Destructive: also removes legitimate hand-built item actions.
const REMOVE_ALL_ADDITIONAL_ACTIONS = false;
const DEDUPE_ACTION_ITEMS = true; // job 3 on/off
// Untrained-style skill names (BR2's UNTRAINED_SKILLS list)
const UNTRAINED_NAMES = [
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
 * True if a skill item's name marks it as an untrained-style skill.
 * @param {Item} item
 * @returns {boolean}
 */
function isUntrainedSkill(item) {
  return (
    item.type === "skill" &&
    UNTRAINED_NAMES.some((n) => item.name.toLowerCase().includes(n))
  );
}

/**
 * Main entry point: scan, confirm, delete.
 * @returns {Promise<void>}
 */
export async function cleanupActors() {
  if (!game.user.isGM) {
    ui.notifications.warn("GM only.");
    return;
  }

  // Collect world actors + unlinked token actors (linked tokens ARE the
  // world actor; including them would double-process).
  const actors = [...game.actors];
  for (const scene of game.scenes) {
    for (const tokenDoc of scene.tokens) {
      if (!tokenDoc.isLinked && tokenDoc.actor) {
        actors.push(tokenDoc.actor);
      }
    }
  }

  // ---- Pass 1: scan ----
  const work = []; // { actor, deleteIds: [], actionUpdates: [] }
  let skillCount = 0;
  let actionCount = 0;
  let dupCount = 0;
  for (const actor of actors) {
    const entry = { actor, deleteIds: [], actionUpdates: [] };
    // effective inner-action count per action item, after stripping
    const actionItems = []; // { item, remaining }
    for (const item of actor.items) {
      if (isUntrainedSkill(item)) {
        entry.deleteIds.push(item.id);
        skillCount++;
        console.log(
          `cleanup | untrained skill "${item.name}" on ${actor.name}`,
        );
        continue;
      }
      const additional = item.system.actions?.additional ?? {};
      const update = { _id: item.id };
      let hits = 0;
      for (const [key, action] of Object.entries(additional)) {
        const nameMatch =
          action?.name && WILD_ATTACK_MATCH.test(action.name.trim());
        if (REMOVE_ALL_ADDITIONAL_ACTIONS || nameMatch) {
          update[`system.actions.additional.-=${key}`] = null;
          hits++;
          actionCount++;
          console.log(
            `cleanup | inner action "${action?.name ?? "(unnamed)"}" ` +
              `(type: ${action?.type}) on ${actor.name} > ${item.name} [${key}]`,
          );
        }
      }
      if (hits) {
        entry.actionUpdates.push(update);
      }
      if (item.type === "action") {
        actionItems.push({
          item,
          remaining: Object.keys(additional).length - hits,
        });
      }
    }

    // Dedupe action items by normalized name.
    if (DEDUPE_ACTION_ITEMS) {
      const groups = new Map();
      for (const info of actionItems) {
        const name = info.item.name.toLowerCase().trim();
        if (!groups.has(name)) {
          groups.set(name, []);
        }
        groups.get(name).push(info);
      }
      for (const group of groups.values()) {
        if (group.length < 2) {
          continue;
        }
        // Keeper: most inner actions remaining after stripping; tie keeps
        // the first in actor order.
        let keeper = group[0];
        for (const info of group) {
          if (info.remaining > keeper.remaining) {
            keeper = info;
          }
        }
        for (const info of group) {
          if (info === keeper) {
            continue;
          }
          entry.deleteIds.push(info.item.id);
          dupCount++;
          console.log(
            `cleanup | duplicate action item "${info.item.name}" on ` +
              `${actor.name} [${info.item.id}] (keeping ${keeper.item.id})`,
          );
        }
      }
    }

    // Never send updates for items scheduled for deletion.
    const deleteSet = new Set(entry.deleteIds);
    entry.actionUpdates = entry.actionUpdates.filter(
      (u) => !deleteSet.has(u._id),
    );
    if (entry.deleteIds.length || entry.actionUpdates.length) {
      work.push(entry);
    }
  }

  if (!work.length) {
    ui.notifications.info("Cleanup: nothing to remove.");
    return;
  }

  const summary =
    `<p>Found <b>${skillCount}</b> Untrained skill item(s), ` +
    `<b>${actionCount}</b> "Wild Attack" inner action(s) and ` +
    `<b>${dupCount}</b> duplicate action item(s) across ` +
    `<b>${work.length}</b> actor(s).</p>` +
    `<p>Details are in the console (F12).</p>` +
    (DRY_RUN ? "<p><b>DRY RUN — nothing will be deleted.</b></p>" : "");
  const go = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Cleanup: Untrained / Wild Attack / Duplicates" },
    content: summary,
    rejectClose: false,
  });
  if (!go || DRY_RUN) {
    ui.notifications.info("Cleanup: no changes made.");
    return;
  }

  // ---- Pass 2: execute (deletions first, then updates) ----
  let failures = 0;
  for (const { actor, deleteIds, actionUpdates } of work) {
    try {
      if (deleteIds.length) {
        await actor.deleteEmbeddedDocuments("Item", deleteIds);
      }
      if (actionUpdates.length) {
        await actor.updateEmbeddedDocuments("Item", actionUpdates);
      }
    } catch (error) {
      failures++;
      console.error(`cleanup | failed on ${actor.name}`, error);
    }
  }
  ui.notifications.info(
    `Cleanup done: ${skillCount} skill(s), ${actionCount} inner action(s), ` +
      `${dupCount} duplicate(s) removed` +
      (failures ? ` — ${failures} actor(s) FAILED, see console.` : "."),
  );
}
