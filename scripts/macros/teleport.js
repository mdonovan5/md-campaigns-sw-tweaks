/* globals game, canvas, ui, console, Sequencer, Sequence */

// ============================================================
// MD Campaigns SW Tweaks — Click-to-Teleport
//
// Foundry v14 / SWADE 6 / Sequencer (crosshair + FX only).
// Select a token, run, click destination. Free placement (no grid snap).
// GM use: uses direct document updates (no sockets needed).
//
// Public API: game.modules.get(MODULE_ID).api.teleport()
// ============================================================

// --- Configurable constants -------------------------------------------------
const FX_IN   = "jb2a.misty_step.01.blue";   // origin effect
const FX_OUT  = "jb2a.misty_step.02.blue";   // destination effect (swap to 01 if preferred)
const FADE_MS = 500;                          // fade duration each way
// -----------------------------------------------------------------------------

export async function teleport() {
  const token = canvas.tokens.controlled[0];
  if (!token) return ui.notifications.warn("Select a token first.");
  if (!game.modules.get("sequencer")?.active)
    return ui.notifications.error("Sequencer isn't active.");

  const doc = token.document;
  const originalAlpha = doc.alpha ?? 1;

  const location = await Sequencer.Crosshair.show({
    location: { obj: token },
    snap: { position: 0 },                      // free placement
    gridHighlight: false,
    icon: { texture: doc.texture.src },
    label: { text: "Teleport here" }
  });
  if (!location) return;                        // Esc / right-click cancels

  // Crosshair returns a center point; convert to token top-left.
  const dest = {
    x: location.x - token.w / 2,
    y: location.y - token.h / 2
  };

  // Await the *visual* fade, not just the DB commit.
  const waitForFade = () =>
    token.animationContexts.get(token.animationName)?.promise ?? Promise.resolve();

  try {
    // Vanish at origin
    new Sequence().effect().file(FX_IN).atLocation(token).scaleToObject(2).play();
    await doc.update({ alpha: 0 }, { animation: { duration: FADE_MS } });
    await waitForFade();                        // fully invisible before the move

    // Instant move while hidden — "displace" movement action:
    // teleport:true, ignores walls, unmeasured, no ruler, no pathing.
    await doc.update({ x: dest.x, y: dest.y, action: "displace" });

    // Reappear at destination
    new Sequence().effect().file(FX_OUT).atLocation(location).scaleToObject(2).play();
    await doc.update({ alpha: originalAlpha }, { animation: { duration: FADE_MS } });
    await waitForFade();
  } catch (err) {
    console.error("Teleport |", err);
    ui.notifications.error("Teleport failed — restoring token visibility.");
  } finally {
    // Everything above is awaited, so this check is no longer racing socket updates.
    if (doc.alpha !== originalAlpha) {
      await doc.update({ alpha: originalAlpha }, { animate: false });
    }
  }
}
