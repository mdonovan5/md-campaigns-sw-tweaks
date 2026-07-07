/* globals Hooks, game, console */

// ============================================================
// MD Campaigns SW Tweaks — entry point
// ============================================================

import { rollGroupTrait } from "./group-trait-roll.js";

const MODULE_ID = "md-campaigns-sw-tweaks";
const LOG_PREFIX = `${MODULE_ID} |`;

Hooks.once("init", () => {
  console.log(LOG_PREFIX, "init");
  // Register game settings here:
  // game.settings.register(MODULE_ID, "settingKey", { ... });
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api = {
    rollGroupTrait,
  };
  console.log(LOG_PREFIX, `ready — v${mod?.version}`);
  // Anything that needs game data or other modules (e.g. game.brsw) goes here.
});
