// ============================================================
// MD Campaigns SW Tweaks — macro API aggregator
//
// Every function ported from the "General SW" world-macro folder,
// gathered into one map that init.js spreads onto module.api.
// The companion compendium ("MD Campaigns SW Tweaks Macros") contains
// one thin macro per entry that just calls the API function.
// ============================================================

import { stepUpWeaponDamage } from "./step-up-weapon-damage.js";
import { createSpiritualWeapon } from "./create-spiritual-weapon.js";
import { worldSnapshot } from "./world-snapshot.js";
import { worldSnapshotCompare } from "./world-snapshot-compare.js";
import { teleport } from "./teleport.js";
import { whisper, whisperToDM } from "./whisper.js";
import {
  syncVision,
  clearMovement,
  fixStaleAuthors,
  toggleSceneNavigation,
  deleteRecentMessages,
} from "./world-utilities.js";
import { placePresetTemplate, convertSceneTokens } from "./scene-tools.js";
import { cleanupActors } from "./actor-cleanup.js";

export const macroApi = {
  stepUpWeaponDamage,
  createSpiritualWeapon,
  worldSnapshot,
  worldSnapshotCompare,
  teleport,
  whisper,
  whisperToDM,
  syncVision,
  clearMovement,
  fixStaleAuthors,
  toggleSceneNavigation,
  deleteRecentMessages,
  placePresetTemplate,
  convertSceneTokens,
  cleanupActors,
};
