/* globals game, canvas, ui, foundry */

// ============================================================
// MD Campaigns SW Tweaks — Step Up Weapon Damage
//
// Toggles a "modifier"-type Active Effect on a chosen weapon that overrides
// system.damage with a die-stepped copy of the weapon's SOURCE formula.
//   d4 -> d6 -> d8 -> d10 -> d12 -> d12+1 -> d12+2 ...
// Run once to apply, run again on the same weapon to remove/restore.
//
// Requires: an actor (selected token, or your assigned character) owning
// weapons. Works for players on their own weapons (embedded-document
// permissions).
//
// Version compatibility: change objects carry BOTH the v13 numeric `mode` (5)
// and the v14 string `type` ('override'). Each version's schema keeps its own
// key and silently drops the other, so the same payload is an Override on
// both. (On v13, `type` alone is dropped and mode defaults to ADD -> string
// concat bug.)
//
// Public API: game.modules.get(MODULE_ID).api.stepUpWeaponDamage()
// ============================================================

/* ----------------------- configurable constants ----------------------- */
const STEPS = 1;                    // die categories to step up per application
const DIE_CHAIN = [4, 6, 8, 10, 12];
const STEP_ALL_DICE = true;         // false = only the first dice term in the formula
const EFFECT_NAME = `Damage Die +${STEPS}`;
const EFFECT_IMG = 'icons/svg/upgrade.svg';
const FLAG_SCOPE = 'world';
const FLAG_KEY = 'damageStepUp';
/* ---------------------------------------------------------------------- */

export async function stepUpWeaponDamage() {
  const actor = canvas.tokens.controlled[0]?.actor ?? game.user.character;
  if (!actor) return ui.notifications.warn('Select a token or assign a character.');

  const weapons = actor.itemTypes.weapon;
  if (!weapons.length) return ui.notifications.warn(`${actor.name} has no weapons.`);

  const options = weapons
    .map((w) => {
      const stepped = w.effects.find(
        (e) => e.type === 'modifier' && e.getFlag(FLAG_SCOPE, FLAG_KEY)
      );
      const tag = stepped ? ' [stepped]' : '';
      const dmg = w._source.system.damage || '—';
      return `<option value="${w.id}">${w.name} (${dmg})${tag}</option>`;
    })
    .join('');

  const content = `
    <div class="form-group">
      <label>Weapon</label>
      <select name="weaponId" style="width:100%">${options}</select>
    </div>`;

  // v14 renamed DialogV2 -> Dialog; fall back for v13.
  const DialogCls = foundry.applications.api.Dialog ?? foundry.applications.api.DialogV2;

  const weaponId = await DialogCls.wait({
    window: { title: 'Damage Die Step-Up' },
    content,
    buttons: [
      {
        action: 'toggle',
        label: 'Toggle Step-Up',
        icon: '<i class="fas fa-dice"></i>',
        default: true,
        callback: (event, button) => button.form.elements.weaponId.value,
      },
      { action: 'cancel', label: 'Cancel' },
    ],
    rejectClose: false,
  });
  if (!weaponId || weaponId === 'cancel') return;

  const weapon = actor.items.get(weaponId);
  if (!weapon) return;

  // Toggle off: remove our effect if present.
  const existing = weapon.effects.find(
    (e) => e.type === 'modifier' && e.getFlag(FLAG_SCOPE, FLAG_KEY)
  );
  if (existing) {
    await existing.delete();
    return ui.notifications.info(
      `${weapon.name}: damage restored to ${weapon._source.system.damage}.`
    );
  }

  // Parse the SOURCE formula (not the prepared one) and step the dice.
  const source = weapon._source.system.damage ?? '';
  if (!source.trim()) return ui.notifications.warn(`${weapon.name} has no damage formula.`);

  const { formula, changed } = stepFormula(source, STEPS);
  if (!changed) {
    return ui.notifications.warn(
      `No die terms found to step in "${source}" on ${weapon.name}.`
    );
  }

  await weapon.createEmbeddedDocuments('ActiveEffect', [
    {
      name: EFFECT_NAME,
      type: 'modifier',
      img: EFFECT_IMG,
      disabled: false,
      transfer: false, // enforced by the system for modifiers anyway
      changes: [
        {
          key: 'system.damage',
          mode: 5,            // v13: CONST.ACTIVE_EFFECT_MODES.OVERRIDE (numeric)
          type: 'override',   // v14: string change type (v13 drops this key)
          value: formula,
        },
      ],
      description: `<p>Steps weapon damage dice up ${STEPS} categor${STEPS === 1 ? 'y' : 'ies'} (was: <code>${source}</code>).</p>`,
      flags: { [FLAG_SCOPE]: { [FLAG_KEY]: true } },
    },
  ]);
  ui.notifications.info(`${weapon.name}: damage ${source} → ${formula}.`);
}

/**
 * Steps every dice term (or only the first, per STEP_ALL_DICE) in a formula.
 * Beyond d12, appends +1 per remaining step (SWADE convention).
 * Leaves @references, flat modifiers, and everything else untouched.
 */
function stepFormula(formula, steps) {
  let changed = false;
  let first = true;
  const out = formula.replace(/(\d*)d(\d+)/gi, (match, count, sidesStr) => {
    if (!STEP_ALL_DICE && !first) return match;
    first = false;
    changed = true;
    const { sides, extra } = stepDie(Number(sidesStr), steps);
    const term = `${count}d${sides}`;
    return extra > 0 ? `${term}+${extra}` : term;
  });
  return { formula: out, changed };
}

function stepDie(sides, steps) {
  let idx = DIE_CHAIN.indexOf(sides);
  if (idx === -1) {
    // Non-standard die (e.g. d5): step numerically by +2, then follow the cap rule.
    const capped = Math.min(sides + steps * 2, 12);
    const overflow = Math.max(0, (sides + steps * 2 - 12) / 2);
    return { sides: capped, extra: Math.ceil(overflow) };
  }
  const target = idx + steps;
  if (target < DIE_CHAIN.length) return { sides: DIE_CHAIN[target], extra: 0 };
  return { sides: 12, extra: target - (DIE_CHAIN.length - 1) };
}

/* ------------------------- verification snippet -------------------------
 * Paste in F12 after applying to a weapon (adjust names):
 *
 * const w = canvas.tokens.controlled[0].actor.itemTypes.weapon
 *   .find(i => i.effects.some(e => e.type === 'modifier' && e.getFlag('world','damageStepUp')));
 * console.log('source :', w._source.system.damage);
 * console.log('prepared:', w.system.damage);          // should show stepped formula
 * console.log('overrides:', w.overrides);             // should contain system.damage
 * ----------------------------------------------------------------------- */
