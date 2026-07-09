/* globals game, ui, console, foundry, Blob, URL */

// ============================================================
// MD Campaigns SW Tweaks — SWADE World Snapshot (EXPORT, v4)
//
// Run in the source/master world (as GM).
// Captures: all world settings (raw DB, including values matching defaults),
// registered setting metadata, card stacks with full card data, roll tables,
// world macros, compendium configuration + pack list, active modules, users,
// folders, and the core permission matrix.
//
// v4 fixes:
//   - game.packs is a foundry Collection whose iterator yields VALUES, not
//     [key, value] entries — the v3 destructuring crashed on pack.metadata.
//   - Every section is now individually wrapped: a failing section is
//     recorded in the snapshot's _errors list and logged, instead of
//     silently killing the whole export.
//   - Fatal errors surface as a red UI notification, never a silent stall.
//
// Public API: game.modules.get(MODULE_ID).api.worldSnapshot()
// ============================================================

export async function worldSnapshot() {
  try {
    const SNAPSHOT_VERSION = 4;
    const errors = [];

    // Run one capture section in isolation; on failure, log + record + return fallback.
    const capture = (name, fn, fallback = []) => {
      try {
        const result = fn();
        console.log(`World Snapshot | captured: ${name}`);
        return result;
      } catch (e) {
        console.error(`World Snapshot | FAILED section "${name}":`, e);
        errors.push({ section: name, error: `${e.constructor?.name}: ${e.message}` });
        return fallback;
      }
    };

    const colorToString = (c) => {
      if (c === null || c === undefined) return null;
      if (typeof c === "string") return c.toLowerCase();
      try { return c.toString().toLowerCase(); } catch { return String(c); }
    };

    ui.notifications.info("Exporting world snapshot…");
    console.log("World Snapshot | export starting");

    // ── 1. ALL world-scope settings, bypassing default filtering ──
    const worldSettings = capture("worldSettings", () => {
      const live = game.settings.storage.get("world")?.contents;
      const entries = live?.length
        ? live.map((d) => ({ key: d.key, value: d._source?.value ?? d.value }))
        : game.data.settings.map((s) => ({ key: s.key, value: s.value }));
      return entries.filter((s) => s.key).sort((a, b) => a.key.localeCompare(b.key));
    });

    // ── 2. Registered world-setting metadata ──
    // game.settings.settings is a standard Map — entry destructuring is correct here.
    const registeredSettings = capture("registeredSettings", () =>
      Array.from(game.settings.settings)
        .filter(([k, v]) => v.scope === "world")
        .map(([k, v]) => ({
          key: k,
          namespace: v.namespace,
          settingKey: v.key,
          name: v.name,
          scope: v.scope,
          type: v.type?.name ?? (v.type?.constructor?.name ?? typeof v.type),
          hasDefault: v.default !== undefined,
          default: (() => {
            try { return JSON.stringify(v.default); } catch { return undefined; }
          })(),
        }))
        .sort((a, b) => a.key.localeCompare(b.key))
    );

    // ── 3. Card stacks (toObject includes the embedded cards array) ──
    const cardStacks = capture("cardStacks", () =>
      game.cards.map((stack) => stack.toObject())
    );

    // ── 4. Roll tables ──
    const rollTables = capture("rollTables", () =>
      game.tables.map((t) => t.toObject())
    );

    // ── 5. World macros (compared by name + content, so _id is stripped) ──
    const macros = capture("macros", () =>
      game.macros.map((m) => {
        const obj = m.toObject();
        return {
          name: obj.name,
          type: obj.type,
          command: obj.command,
          img: obj.img,
          scope: obj.scope,
          flags: obj.flags,
          ownership: obj.ownership,
        };
      })
    );

    // ── 6. Compendium configuration + installed pack list ──
    const compendiumConfig = capture("compendiumConfig", () =>
      game.settings.get("core", "compendiumConfiguration"), {});

    // FIXED: foundry Collections iterate VALUES — use Collection#map, key from pack.collection.
    const compendiumPacks = capture("compendiumPacks", () =>
      game.packs
        .map((pack) => ({
          key: pack.collection ?? pack.metadata?.id,
          label: pack.metadata?.label,
          type: pack.metadata?.type,
          system: pack.metadata?.system,
          packageType: pack.metadata?.packageType,
          packageName: pack.metadata?.packageName,
        }))
        .filter((p) => p.key)
        .sort((a, b) => a.key.localeCompare(b.key))
    );

    // ── 7. Active modules ──
    const activeModules = capture("activeModules", () =>
      game.modules
        .filter((m) => m.active)
        .map((m) => ({ id: m.id, version: m.version, title: m.title }))
        .sort((a, b) => a.id.localeCompare(b.id))
    );

    // ── 8. Users (color normalized to "#rrggbb" string) ──
    const users = capture("users", () =>
      game.users.map((u) => ({
        name: u.name,
        role: u.role,
        color: colorToString(u.color),
        avatar: u.avatar,
        character: u.character?.name ?? null,
        flags: u.flags,
        permissions: u.permissions,
      }))
    );

    // ── 9. Folders (all types) ──
    const folders = capture("folders", () =>
      game.folders.map((f) => f.toObject())
    );

    // ── 10. Core permission matrix ──
    const permissions = capture("permissions", () =>
      game.settings.get("core", "permissions"), {});

    // ── Build snapshot ──
    const snapshot = {
      _snapshotVersion: SNAPSHOT_VERSION,
      _exportedAt: new Date().toISOString(),
      _worldId: game.world.id,
      _worldTitle: game.world.title,
      _systemId: game.system.id,
      _systemVersion: game.system.version,
      _coreVersion: game.version,
      _errors: errors,
      worldSettings,
      registeredSettings,
      cardStacks,
      rollTables,
      macros,
      compendiumConfig,
      compendiumPacks,
      activeModules,
      users,
      folders,
      permissions,
    };

    // ── Download ──
    const filename = `world-snapshot-${game.world.id}-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    const jsonStr = JSON.stringify(snapshot, null, 2);

    const save = foundry?.utils?.saveDataToFile ?? globalThis.saveDataToFile;
    if (typeof save === "function") {
      save(jsonStr, "application/json", filename);
    } else {
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    if (errors.length) {
      ui.notifications.warn(
        `Snapshot exported with ${errors.length} failed section(s): ` +
        `${errors.map((e) => e.section).join(", ")} — see console (F12).`,
        { permanent: true }
      );
    } else {
      ui.notifications.info(`Snapshot exported: ${filename}`, { permanent: true });
    }
    console.log("World Snapshot | export complete", { filename, errors });

  } catch (err) {
    console.error("World Snapshot | FATAL export error:", err);
    ui.notifications.error(
      `World snapshot export failed: ${err.message} — see console (F12) for details.`,
      { permanent: true }
    );
  }
}
