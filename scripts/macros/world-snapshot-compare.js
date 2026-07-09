/* globals game, ui, console, foundry, Dialog, Blob, URL */

// ============================================================
// MD Campaigns SW Tweaks — SWADE World Snapshot Compare (v3)
//
// Run in the TARGET world. Prompts for a snapshot JSON (produced by the
// companion EXPORT function) and reports every discrepancy, grouped by
// category, in a dialog + browser console + optional CSV.
//
// It changes NOTHING — the report is a checklist for manual fixes.
//
// Comparison notes:
//   - Setting values are parsed and compared canonically (recursive key
//     sort), so key-order differences in stored JSON are NOT false positives.
//   - User colors are normalized to "#rrggbb" strings on both sides.
//   - All values are HTML-escaped before rendering.
//
// Public API: game.modules.get(MODULE_ID).api.worldSnapshotCompare()
// ============================================================

export async function worldSnapshotCompare() {
  try {

  // ── Helpers ──────────────────────────────────────────────────────────────

  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const truncate = (s, max = 120) => {
    if (s === null || s === undefined || s === "") return "(empty)";
    s = String(s);
    return s.length > max ? s.substring(0, max) + "…" : s;
  };

  // Render any value (raw JSON string OR live object) safely for display.
  const display = (v, max = 120) => {
    if (v === null || v === undefined || v === "") return "(empty)";
    if (typeof v !== "string") {
      try { v = JSON.stringify(v); } catch { v = String(v); }
    }
    return truncate(v, max);
  };

  // Recursively sort object keys so serialization is order-independent.
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.keys(v)
        .sort()
        .reduce((o, k) => { o[k] = canonical(v[k]); return o; }, {});
    }
    return v;
  };

  // Serialize any value (raw JSON string or live value) into a canonical string.
  const canonicalString = (x) => {
    let val = x;
    if (typeof x === "string") {
      try { val = JSON.parse(x); }
      catch { return x; } // not JSON — compare as plain string
    }
    try { return JSON.stringify(canonical(val)); }
    catch { return String(x); }
  };

  const jsonEqual = (a, b) => canonicalString(a) === canonicalString(b);

  const colorToString = (c) => {
    if (c === null || c === undefined) return null;
    if (typeof c === "string") return c.toLowerCase();
    try { return c.toString().toLowerCase(); } catch { return String(c); }
  };

  // ── Prompt for file (handles cancel) ─────────────────────────────────────

  const file = await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", () => resolve(input.files[0] ?? null));
    input.addEventListener("cancel", () => resolve(null)); // modern browsers
    input.click();
  });

  if (!file) {
    ui.notifications.warn("No file selected — comparison cancelled.");
    return;
  }

  let snap;
  try {
    snap = JSON.parse(await file.text());
  } catch (e) {
    ui.notifications.error("Could not parse snapshot JSON.");
    console.error(e);
    return;
  }

  if (!snap._snapshotVersion || !Array.isArray(snap.worldSettings)) {
    ui.notifications.error("This does not look like a world snapshot file.");
    return;
  }

  // ── System-mismatch guard ────────────────────────────────────────────────

  if (snap._systemId !== game.system.id) {
    const proceed = confirm(
      `Snapshot is from system "${snap._systemId}" but this world runs ` +
      `"${game.system.id}". The comparison will be mostly noise. Continue anyway?`
    );
    if (!proceed) return;
  }

  // ── Diff engine ──────────────────────────────────────────────────────────

  const diffSections = [];
  const addSection = (title, rows) => {
    if (rows.length) diffSections.push({ title, rows });
  };

  // 1. World Settings
  {
    const rows = [];
    // Prefer live Setting documents; fall back to handshake data.
    const liveWorldSettings = game.settings.storage.get("world")?.contents;
    const localEntries = liveWorldSettings?.length
      ? liveWorldSettings.map((d) => [d.key, d._source?.value ?? d.value])
      : game.data.settings.filter((s) => s.key).map((s) => [s.key, s.value]);
    const localSettingsMap = new Map(localEntries);
    const snapKeys = new Set(snap.worldSettings.map((s) => s.key));

    for (const s of snap.worldSettings) {
      const localVal = localSettingsMap.get(s.key);
      if (localVal === undefined) {
        rows.push({ key: s.key, status: "MISSING", source: display(s.value), local: "(not set)" });
      } else if (!jsonEqual(localVal, s.value)) {
        rows.push({ key: s.key, status: "DIFFERENT", source: display(s.value), local: display(localVal) });
      }
    }
    for (const [key, val] of localSettingsMap) {
      if (!snapKeys.has(key)) {
        rows.push({ key, status: "EXTRA (local only)", source: "(not in snapshot)", local: display(val) });
      }
    }

    rows.sort((a, b) => a.key.localeCompare(b.key));
    addSection("World Settings", rows);
  }

  // 2. Active Modules
  {
    const rows = [];
    const localMods = new Map(
      game.modules.filter((m) => m.active).map((m) => [m.id, m.version])
    );
    const snapIds = new Set(snap.activeModules.map((m) => m.id));

    for (const mod of snap.activeModules) {
      const localVer = localMods.get(mod.id);
      if (localVer === undefined) {
        rows.push({ key: `${mod.id} (${mod.title})`, status: "MISSING", source: `v${mod.version}`, local: "(not active / not installed)" });
      } else if (localVer !== mod.version) {
        rows.push({ key: mod.id, status: "VERSION MISMATCH", source: `v${mod.version}`, local: `v${localVer}` });
      }
    }
    for (const [id, ver] of localMods) {
      if (!snapIds.has(id)) {
        rows.push({ key: id, status: "EXTRA (local only)", source: "(not in snapshot)", local: `v${ver}` });
      }
    }

    rows.sort((a, b) => a.key.localeCompare(b.key));
    addSection("Active Modules", rows);
  }

  // 2b. Compendium Packs (availability only — pack contents are not compared)
  {
    const rows = [];
    // foundry Collections iterate VALUES — use Collection#map, key from pack.collection.
    const localPacks = new Set(
      game.packs.map((p) => p.collection ?? p.metadata?.id).filter(Boolean)
    );
    const snapPacks = snap.compendiumPacks ?? [];
    const snapKeys = new Set(snapPacks.map((p) => p.key));

    for (const p of snapPacks) {
      if (!localPacks.has(p.key)) {
        rows.push({ key: `${p.key} (${p.label})`, status: "MISSING", source: `${p.type} pack from ${p.packageName}`, local: "(not available)" });
      }
    }
    for (const key of localPacks) {
      if (!snapKeys.has(key)) {
        rows.push({ key, status: "EXTRA (local only)", source: "(not in snapshot)", local: "available" });
      }
    }

    rows.sort((a, b) => a.key.localeCompare(b.key));
    addSection("Compendium Packs (availability)", rows);
  }

  // 3. Card Stacks
  {
    const rows = [];
    const localStacks = new Map(game.cards.map((s) => [s.name, s]));
    const snapNames = new Set(snap.cardStacks.map((s) => s.name));

    for (const stack of snap.cardStacks) {
      const local = localStacks.get(stack.name);
      if (!local) {
        rows.push({ key: stack.name, status: "MISSING", source: `${stack.type} — ${stack.cards?.length ?? 0} cards`, local: "(not found)" });
        continue;
      }
      if (local.type !== stack.type) {
        rows.push({ key: `${stack.name} [type]`, status: "DIFFERENT", source: stack.type, local: local.type });
      }
      const snapCount = stack.cards?.length ?? 0;
      const localCount = local.cards.size;
      if (snapCount !== localCount) {
        rows.push({ key: `${stack.name} [card count]`, status: "DIFFERENT", source: String(snapCount), local: String(localCount) });
      }
      const localCardNames = new Set(local.cards.map((c) => c.name));
      const snapCardNames = new Set((stack.cards ?? []).map((c) => c.name));
      for (const cn of snapCardNames) {
        if (!localCardNames.has(cn)) {
          rows.push({ key: `${stack.name} → card "${cn}"`, status: "MISSING card", source: "present", local: "(not found)" });
        }
      }
      for (const cn of localCardNames) {
        if (!snapCardNames.has(cn)) {
          rows.push({ key: `${stack.name} → card "${cn}"`, status: "EXTRA card (local only)", source: "(not in snapshot)", local: "present" });
        }
      }
      if (!jsonEqual(stack.flags ?? {}, local.toObject().flags ?? {})) {
        rows.push({
          key: `${stack.name} [flags]`,
          status: "DIFFERENT",
          source: truncate(canonicalString(stack.flags ?? {})),
          local: truncate(canonicalString(local.toObject().flags ?? {})),
        });
      }
    }
    for (const [name, local] of localStacks) {
      if (!snapNames.has(name)) {
        rows.push({ key: name, status: "EXTRA (local only)", source: "(not in snapshot)", local: `${local.type} — ${local.cards.size} cards` });
      }
    }

    addSection("Card Stacks (Decks / Hands / Piles)", rows);
  }

  // 4. Roll Tables
  {
    const rows = [];
    const localTables = new Map(game.tables.map((t) => [t.name, t]));
    const snapNames = new Set(snap.rollTables.map((t) => t.name));

    for (const table of snap.rollTables) {
      const local = localTables.get(table.name);
      if (!local) {
        rows.push({ key: table.name, status: "MISSING", source: `${table.results?.length ?? 0} results`, local: "(not found)" });
        continue;
      }
      const snapCount = table.results?.length ?? 0;
      const localCount = local.results.size;
      if (snapCount !== localCount) {
        rows.push({ key: `${table.name} [result count]`, status: "DIFFERENT", source: String(snapCount), local: String(localCount) });
      }
      if ((table.formula ?? "") !== (local.formula ?? "")) {
        rows.push({ key: `${table.name} [formula]`, status: "DIFFERENT", source: table.formula || "(none)", local: local.formula || "(none)" });
      }
    }
    for (const [name] of localTables) {
      if (!snapNames.has(name)) {
        rows.push({ key: name, status: "EXTRA (local only)", source: "(not in snapshot)", local: "present" });
      }
    }

    addSection("Roll Tables", rows);
  }

  // 5. World Macros
  {
    const rows = [];
    const localMacros = new Map(game.macros.map((m) => [m.name, m]));
    const snapNames = new Set(snap.macros.map((m) => m.name));

    for (const macro of snap.macros) {
      const local = localMacros.get(macro.name);
      if (!local) {
        rows.push({ key: macro.name, status: "MISSING", source: truncate(macro.command, 60), local: "(not found)" });
        continue;
      }
      if ((local.command ?? "") !== (macro.command ?? "")) {
        rows.push({ key: `${macro.name} [command]`, status: "DIFFERENT", source: truncate(macro.command, 60), local: truncate(local.command, 60) });
      }
      if (local.type !== macro.type) {
        rows.push({ key: `${macro.name} [type]`, status: "DIFFERENT", source: macro.type, local: local.type });
      }
    }
    for (const [name] of localMacros) {
      if (!snapNames.has(name)) {
        rows.push({ key: name, status: "EXTRA (local only)", source: "(not in snapshot)", local: "present" });
      }
    }

    addSection("World Macros", rows);
  }

  // 5b. Folders (matched by type + name; hierarchy is not compared)
  {
    const rows = [];
    const folderKey = (f) => `${f.type}::${f.name}`;
    const localFolders = new Map(game.folders.map((f) => [folderKey(f), f]));
    const snapFolders = snap.folders ?? [];
    const snapKeys = new Set(snapFolders.map(folderKey));

    for (const f of snapFolders) {
      if (!localFolders.has(folderKey(f))) {
        rows.push({ key: `${f.name} [${f.type}]`, status: "MISSING", source: "present", local: "(not found)" });
      }
    }
    for (const [k, f] of localFolders) {
      if (!snapKeys.has(k)) {
        rows.push({ key: `${f.name} [${f.type}]`, status: "EXTRA (local only)", source: "(not in snapshot)", local: "present" });
      }
    }

    rows.sort((a, b) => a.key.localeCompare(b.key));
    addSection("Folders", rows);
  }

  // 6. Users
  {
    const rows = [];
    for (const u of snap.users) {
      const local = game.users.getName(u.name);
      if (!local) {
        rows.push({ key: u.name, status: "MISSING", source: `role=${u.role}`, local: "(not found)" });
        continue;
      }
      if (local.role !== u.role) {
        rows.push({ key: `${u.name} [role]`, status: "DIFFERENT", source: String(u.role), local: String(local.role) });
      }
      const localColor = colorToString(local.color);
      const snapColor = colorToString(u.color);
      if (localColor !== snapColor) {
        rows.push({ key: `${u.name} [color]`, status: "DIFFERENT", source: snapColor ?? "(none)", local: localColor ?? "(none)" });
      }
      if (u.character && local.character?.name !== u.character) {
        rows.push({ key: `${u.name} [character]`, status: "DIFFERENT", source: u.character, local: local.character?.name ?? "(none)" });
      }
      if (!jsonEqual(u.flags ?? {}, local.toObject().flags ?? {})) {
        rows.push({
          key: `${u.name} [flags]`,
          status: "DIFFERENT",
          source: truncate(canonicalString(u.flags ?? {})),
          local: truncate(canonicalString(local.toObject().flags ?? {})),
        });
      }
    }
    addSection("Users", rows);
  }

  // 7. Core Permissions
  {
    const rows = [];
    let localPerms = {};
    try { localPerms = game.settings.get("core", "permissions") ?? {}; } catch { /* noop */ }
    const snapPerms = snap.permissions ?? {};

    for (const key of [...new Set([...Object.keys(snapPerms), ...Object.keys(localPerms)])].sort()) {
      const inSnap = key in snapPerms;
      const inLocal = key in localPerms;
      if (inSnap && inLocal) {
        if (!jsonEqual(snapPerms[key], localPerms[key])) {
          rows.push({ key, status: "DIFFERENT", source: truncate(canonicalString(snapPerms[key])), local: truncate(canonicalString(localPerms[key])) });
        }
      } else if (inSnap) {
        rows.push({ key, status: "MISSING", source: truncate(canonicalString(snapPerms[key])), local: "(not set)" });
      } else {
        rows.push({ key, status: "EXTRA (local only)", source: "(not in snapshot)", local: truncate(canonicalString(localPerms[key])) });
      }
    }
    addSection("Core Permissions", rows);
  }

  // 8. Version info
  {
    const rows = [];
    if (snap._coreVersion !== game.version) {
      rows.push({ key: "Foundry Core", status: "VERSION MISMATCH", source: snap._coreVersion, local: game.version });
    }
    if (snap._systemVersion !== game.system.version) {
      rows.push({ key: `System (${snap._systemId})`, status: "VERSION MISMATCH", source: snap._systemVersion, local: game.system.version });
    }
    addSection("Version Info", rows);
  }

  // ── Report ───────────────────────────────────────────────────────────────

  const totalDiffs = diffSections.reduce((sum, s) => sum + s.rows.length, 0);

  if (totalDiffs === 0) {
    ui.notifications.info("No discrepancies found — worlds appear identical.");
    return;
  }

  // Console dump (copy-paste friendly)
  console.log("=== WORLD SNAPSHOT DIFF ===");
  for (const section of diffSections) {
    console.log(`\n── ${section.title} (${section.rows.length}) ──`);
    for (const row of section.rows) {
      console.log(`  [${row.status}] ${row.key}`);
      console.log(`    Source: ${row.source}`);
      console.log(`    Local:  ${row.local}`);
    }
  }

  // HTML report — explicit text colors so it's readable on light AND dark themes
  const statusStyle = (status) => {
    if (status.startsWith("MISSING")) return "background:#5c2626; color:#f5dcdc;";
    if (status.startsWith("EXTRA")) return "background:#2e4a26; color:#e2f2dc;";
    if (status === "VERSION MISMATCH") return "background:#5c4a16; color:#f5eccf;";
    return "background:#2c3454; color:#dde3f5;"; // DIFFERENT
  };

  let html = `<div style="max-height:60vh; overflow-y:auto; font-size:12px;">`;
  html += `<p style="margin-bottom:8px;"><strong>Snapshot:</strong> ${esc(snap._worldTitle)} (${esc(snap._worldId)})<br>`;
  html += `<strong>Exported:</strong> ${esc(snap._exportedAt)}<br>`;
  html += `<strong>Total discrepancies:</strong> ${totalDiffs}</p>`;

  for (const section of diffSections) {
    html += `<details style="margin-bottom:6px;">`;
    html += `<summary style="cursor:pointer; font-weight:bold; font-size:13px; padding:4px 0;">${esc(section.title)} (${section.rows.length})</summary>`;
    html += `<table style="width:100%; border-collapse:collapse; font-size:11px; margin-top:4px;">`;
    html += `<thead><tr style="background:#333; color:#fff;">`;
    html += `<th style="text-align:left; padding:3px 4px;">Key</th>`;
    html += `<th style="text-align:left; padding:3px 4px;">Status</th>`;
    html += `<th style="text-align:left; padding:3px 4px;">Source</th>`;
    html += `<th style="text-align:left; padding:3px 4px;">Local</th>`;
    html += `</tr></thead><tbody>`;
    for (const row of section.rows) {
      html += `<tr style="${statusStyle(row.status)} border-bottom:1px solid #555;">`;
      html += `<td style="padding:3px 4px; word-break:break-all;">${esc(row.key)}</td>`;
      html += `<td style="padding:3px 4px; white-space:nowrap;">${esc(row.status)}</td>`;
      html += `<td style="padding:3px 4px; word-break:break-all; max-width:220px;">${esc(row.source)}</td>`;
      html += `<td style="padding:3px 4px; word-break:break-all; max-width:220px;">${esc(row.local)}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table></details>`;
  }
  html += `</div>`;

  const downloadCSV = () => {
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    let csv = "Section,Key,Status,Source Value,Local Value\n";
    for (const section of diffSections) {
      for (const row of section.rows) {
        csv += `${q(section.title)},${q(row.key)},${q(row.status)},${q(row.source)},${q(row.local)}\n`;
      }
    }
    const filename = `world-diff-${game.world.id}.csv`;
    const save = foundry?.utils?.saveDataToFile ?? globalThis.saveDataToFile;
    if (typeof save === "function") {
      save(csv, "text/csv", filename);
    } else {
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const title = `World Snapshot Comparison — ${totalDiffs} discrepancies`;
  const width = Math.min(900, window.innerWidth - 100);

  // Prefer DialogV2 (v12+); fall back to AppV1 Dialog on older cores.
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2) {
    await DialogV2.wait({
      window: { title },
      position: { width },
      content: html,
      buttons: [
        {
          action: "csv",
          label: "Download as CSV",
          icon: "fas fa-download",
          callback: () => { downloadCSV(); return "csv"; },
        },
        { action: "close", label: "Close", icon: "fas fa-times", default: true },
      ],
      rejectClose: false,
    });
  } else {
    new Dialog({
      title,
      content: html,
      buttons: {
        csv: { icon: '<i class="fas fa-download"></i>', label: "Download as CSV", callback: downloadCSV },
        close: { icon: '<i class="fas fa-times"></i>', label: "Close" },
      },
      default: "close",
    }, { width, resizable: true }).render(true);
  }

  } catch (err) {
    console.error("World Snapshot | FATAL compare error:", err);
    ui.notifications.error(
      `World snapshot comparison failed: ${err.message} — see console (F12) for details.`,
      { permanent: true }
    );
  }
}
