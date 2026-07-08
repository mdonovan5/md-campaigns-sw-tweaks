/* globals Hooks, game, ui, console */

// ============================================================
// MD Campaigns SW Tweaks — entry point
// ============================================================

import { rollGroupTrait } from "./group-trait-roll.js";
import { MAJOR_EFFECTS, registerArcanaChatHook } from "./major-arcana.js";
import { registerArcanaHud } from "./arcana-hud.js";

const MODULE_ID = "md-campaigns-sw-tweaks";
const LOG_PREFIX = `${MODULE_ID} |`;

Hooks.once("init", () => {
  console.log(LOG_PREFIX, "init");
  registerArcanaHud(); // settings + combat hooks + HUD render hooks
  registerArcanaChatHook(); // effect text on card-draw chat cards
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api = {
    rollGroupTrait,
    majorEffects: MAJOR_EFFECTS,
  };
  console.log(LOG_PREFIX, `ready — v${mod?.version}`);
  // Carried over from the retired world script: collapse the nav bar.
  ui.nav?.collapse?.();
});
