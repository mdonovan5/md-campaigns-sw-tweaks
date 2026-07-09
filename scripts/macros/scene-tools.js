/* globals game, ui, console, foundry, CONFIG */

// ============================================================
// MD Campaigns SW Tweaks — scene tools
//
// placePresetTemplate(): presents the six SWADE template presets (Cone,
//   Small Cone, Stream, SBT, MBT, LBT) and starts the same interactive
//   placement the power-sheet buttons use. Requires SWADE 6.x on v14.
//
// convertSceneTokens(): "Scene Conversion" — converts 5e tokens in a scene
//   compendium (v13 pack) into neutral, unlinked tokens usable in the SWADE
//   v14 world. Keeps name, position, image, size, vision, light,
//   disposition… Strips the 5e ActorDelta, actor link, 5e bars, and dnd5e
//   flags. Run in the SWADE world, as GM. (UI is in French, as authored.)
//
// Public API: game.modules.get(MODULE_ID).api.placePresetTemplate()
//             game.modules.get(MODULE_ID).api.convertSceneTokens()
// ============================================================

export async function placePresetTemplate() {
  const presets = CONFIG.SWADE.regionPresets; // same array the sheet buttons and toolbar are built from

  const buttons = presets.map((p) => ({
    action: p.button.name, // 'swcone' | 'swscone' | 'stream' | 'sbt' | 'mbt' | 'lbt'
    label: game.i18n.localize(p.button.title),
    icon: p.button.icon,
  }));
  buttons.push({ action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" });

  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: "Place Template Region" },
    content: "<p>Choose a template to place, then click on the canvas to drop it.</p>",
    buttons,
    rejectClose: false, // closing the dialog returns null instead of throwing
  });

  if (choice && choice !== "cancel") {
    // Exact same call the power sheet makes (minus the item link, which is optional)
    game.swade.util.createRegionFromPreset(choice);
  }
}

export async function convertSceneTokens() {
  // --- 1. Dialog : choix du pack + scène (ID ou nom exact, vide = toutes) ---
  const scenePacks = game.packs.filter(p => p.documentName === "Scene");
  if (!scenePacks.length) return ui.notifications.error("Aucun compendium de scènes trouvé.");

  const packOptions = scenePacks
    .map(p => `<option value="${p.collection}">${p.title} — ${p.collection}</option>`)
    .join("");

  const choice = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Convertir les tokens 5e → neutres" },
    content: `
      <div class="form-group">
        <label>Compendium de scènes</label>
        <select name="packId" style="width:100%">${packOptions}</select>
      </div>
      <div class="form-group">
        <label>Scène : ID ou nom exact (vide = toutes les scènes)</label>
        <input type="text" name="scene" placeholder="k9Vr8SYCLWDgm5Ax ou La Crypte" style="width:100%">
      </div>`,
    ok: {
      label: "Convertir",
      callback: (event, button) => ({
        packId: button.form.elements.packId.value,
        scene:  button.form.elements.scene.value.trim()
      })
    },
    rejectClose: false
  });
  if (!choice) return; // annulé

  const pack = game.packs.get(choice.packId);
  if (!pack) return ui.notifications.error(`Compendium introuvable : ${choice.packId}`);

  // --- 2. Résolution des scènes via l'index (pas de construction de documents) ---
  const index = await pack.getIndex();
  let targetIds;
  if (choice.scene) {
    const entry = index.get(choice.scene) ?? index.find(e => e.name === choice.scene);
    if (!entry) return ui.notifications.error(`Scène « ${choice.scene} » introuvable (ni par ID ni par nom).`);
    targetIds = [entry._id];
  } else {
    targetIds = index.map(e => e._id);
  }

  // --- 3. Nettoyage d'un token (données SOURCE, déjà migrées v14) ---
  function sanitizeToken(src) {
    const t = src;                      // déjà un clone via scene.toObject()
    delete t.delta;                     // ActorDelta = schéma 5e embarqué → cause de l'échec d'import
    t.actorId   = null;                 // non lié — à relier plus tard
    t.actorLink = false;
    t.bar1 = { attribute: null };       // "attributes.hp" etc. : chemins 5e invalides en SWADE
    t.bar2 = { attribute: null };
    if (t.flags) delete t.flags.dnd5e;
    delete t._movementHistory;          // v14 : historique de déplacement du monde 5e, obsolète
    delete t._regions;                  // v14 : recalculé par le serveur à la création
    return t;
  }

  // --- 4. Traitement ---
  const wasLocked = pack.locked;
  if (wasLocked) await pack.configure({ locked: false });

  let done = 0, totalTokens = 0;
  const failures = [];
  try {
    for (const id of targetIds) {
      const scene = await pack.getDocument(id);
      if (!scene) { failures.push(id); continue; }

      // Snapshot SOURCE : contient TOUS les tokens, même ceux que le client
      // SWADE juge invalides (exclus de scene.tokens). Rien n'est perdu.
      const srcTokens = scene.toObject().tokens ?? [];
      if (!srcTokens.length) { done++; continue; }

      if (scene.tokens.size !== srcTokens.length) {
        console.warn(`« ${scene.name} » : ${srcTokens.length - scene.tokens.size} token(s) invalides côté client — récupérés via les données source.`);
      }

      const ids = srcTokens.map(t => t._id);
      const cleaned = srcTokens.map(sanitizeToken);

      try {
        await scene.deleteEmbeddedDocuments("Token", ids);
        await scene.createEmbeddedDocuments("Token", cleaned, { keepId: true });
        totalTokens += ids.length;
        done++;
        console.log(`Scène « ${scene.name} » : ${ids.length} token(s) convertis.`);
      } catch (err) {
        failures.push(scene.name);
        console.error(`Échec sur « ${scene.name} » :`, err);
      }
    }
  } finally {
    if (wasLocked) await pack.configure({ locked: true });  // re-verrouille même en cas d'erreur
  }

  if (failures.length) {
    ui.notifications.warn(`${done} scène(s) OK, ${totalTokens} token(s) convertis. Échecs : ${failures.join(", ")} — voir console (F12).`);
  } else {
    ui.notifications.info(`${done} scène(s) traitée(s), ${totalTokens} token(s) convertis (neutres, non liés).`);
  }
}
