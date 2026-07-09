/* globals game, canvas, ui, console, CONST, foundry, Actor */

// ============================================================
// MD Campaigns SW Tweaks — Spiritual Weapon
//
// Summon / dismiss / refresh (Foundry v14, SWADE 6 / SWPF, BR2).
//
// Run with the CASTER'S TOKEN selected.
//  - No summon on scene  -> creates/refreshes the "Spiritual Weapon (<token
//    name>)" actor and lets you click the map to place its token.
//  - Summon already on scene -> dismisses it (actor is kept for reuse).
//
// The summon's Faith skill and Spirit die are copied from the caster at each
// cast, so the weapon's @spi+d4 damage always reflects the creator's Spirit.
// The invoking player (or the caster's owner, when a GM runs it) gets OWNER
// permission on the summon.
//
// Player-run requires the "Create New Actors" and "Create New Tokens"
// permissions (Configure Settings -> User Permissions); otherwise a GM runs
// it.
//
// Public API: game.modules.get(MODULE_ID).api.createSpiritualWeapon()
// ============================================================

// ---------------------------- configuration --------------------------------
const ARCANE_SKILL_NAME = "Faith";          // caster skill copied to the summon
const WEAPON_NAME = "Spiritual Weapon";     // weapon item on the summon
const ACTOR_PREFIX = "Spiritual Weapon";    // actor named `${ACTOR_PREFIX} (${tokenName})`
const DAMAGE_FORMULA = "@spi+d4";           // power damage (summon's Spirit = caster's)
const RAISE_DAMAGE_FORMULA = "@spi+d6";     // damage when the power was cast with a raise
const TOKEN_IMG =
    "https://assets.forge-vtt.com/62ca1f94b42ee77570ebdc79/moulinette-v2/cloud/venatusmaps/spell-assets-pt.3/Spiritual%20Weapon_hammer.webp";
const TOKEN_DISPOSITION = 1;                // friendly
const SUMMON_PACE = 5;
// ----------------------------------------------------------------------------

export async function createSpiritualWeapon() {
    try {
        await spiritualWeaponMain();
    } catch (err) {
        console.error("Spiritual Weapon |", err);
        ui.notifications.error(`Spiritual Weapon: ${err.message}`);
    }
}

async function spiritualWeaponMain() {
    const casterToken = canvas.tokens.controlled[0];
    if (canvas.tokens.controlled.length !== 1 || !casterToken?.actor) {
        return ui.notifications.warn(
            "Select the caster's token (exactly one) before running this macro.",
        );
    }
    const caster = casterToken.actor;
    const summonName = `${ACTOR_PREFIX} (${casterToken.name})`;

    // ---------------- dismiss: a summon token is already on the scene -------
    const placed = canvas.scene.tokens.find((t) => t.name === summonName);
    if (placed) {
        await canvas.scene.deleteEmbeddedDocuments("Token", [placed.id]);
        return ui.notifications.info(`${summonName} dismissed.`);
    }

    // ---------------- gather the caster's stats -----------------------------
    const casterSkill = caster.items.find(
        (i) =>
            i.type === "skill" &&
            i.name.toLowerCase() === ARCANE_SKILL_NAME.toLowerCase(),
    );
    if (!casterSkill) {
        return ui.notifications.warn(
            `${caster.name} has no "${ARCANE_SKILL_NAME}" skill — nothing to attack with.`,
        );
    }
    const faithDie = {
        sides: casterSkill.system.die.sides,
        modifier: casterSkill.system.die.modifier || 0,
    };
    const spiritDie = {
        sides: caster.system.attributes.spirit.die.sides,
        modifier: caster.system.attributes.spirit.die.modifier || 0,
    };
    // Character-type actors are always wild cards (system getter);
    // NPCs carry a stored boolean. isWildcard covers both.
    const casterIsWildcard = caster.isWildcard;

    // Owner: the invoking player, or (when a GM runs it) the caster's player owner
    let ownerUserId = game.user.id;
    if (game.user.isGM) {
        const playerOwner = game.users.find(
            (u) =>
                !u.isGM &&
                caster.testUserPermission(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER),
        );
        if (playerOwner) ownerUserId = playerOwner.id;
    }
    const ownership = { default: 0, [ownerUserId]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };

    // ---------------- cast dialog: was the power cast with a raise? ---------
    const castWithRaise = await foundry.applications.api.DialogV2.wait({
        window: { title: summonName },
        content: `<label style="display:flex;gap:0.5em;align-items:center;">
            <input type="checkbox" name="raise">
            Cast with a raise (damage ${RAISE_DAMAGE_FORMULA})
        </label>`,
        buttons: [
            {
                action: "summon",
                label: "Summon",
                default: true,
                callback: (event, button, dialog) =>
                    dialog.element.querySelector("input[name=raise]").checked,
            },
            { action: "cancel", label: "Cancel", callback: () => null },
        ],
        rejectClose: false,
    });
    if (castWithRaise === null || castWithRaise === undefined) {
        return; // cancelled
    }
    const damageFormula = castWithRaise ? RAISE_DAMAGE_FORMULA : DAMAGE_FORMULA;

    // ---------------- find or create the summon actor -----------------------
    let summon = game.actors.find((a) => a.name === summonName);
    if (!summon) {
        if (!game.user.can("ACTOR_CREATE")) {
            return ui.notifications.warn(
                "You lack the 'Create New Actors' permission — ask the GM to run this once.",
            );
        }
        summon = await Actor.create({
            name: summonName,
            type: "npc",
            img: TOKEN_IMG,
            ownership,
            system: {
                wildcard: casterIsWildcard,
                attributes: { spirit: { die: spiritDie } },
                stats: { speed: { value: SUMMON_PACE } },
            },
            prototypeToken: {
                name: summonName,
                actorLink: true,
                disposition: TOKEN_DISPOSITION,
                width: 1,
                height: 1,
                texture: { src: TOKEN_IMG },
            },
            items: [
                {
                    name: ARCANE_SKILL_NAME,
                    type: "skill",
                    system: { die: faithDie, attribute: "spirit" },
                },
                {
                    name: WEAPON_NAME,
                    type: "weapon",
                    img: TOKEN_IMG,
                    system: {
                        damage: damageFormula,
                        range: "",
                        rangeType: 0, // melee: the fork patch resolves it vs Parry at melee range
                        equipStatus: 4,
                        bonusDamageDie: 6,
                        actions: {
                            trait: ARCANE_SKILL_NAME,
                        },
                    },
                },
            ],
        });
    } else {
        // -------- refresh: re-sync with the caster's current stats ----------
        await summon.update({
            ownership,
            "system.attributes.spirit.die": spiritDie,
            "system.wildcard": casterIsWildcard,
        });
        const summonSkill = summon.items.find(
            (i) =>
                i.type === "skill" &&
                i.name.toLowerCase() === ARCANE_SKILL_NAME.toLowerCase(),
        );
        if (summonSkill) {
            await summonSkill.update({ "system.die": faithDie });
        }
        const summonWeapon = summon.items.find(
            (i) => i.type === "weapon" && i.name === WEAPON_NAME,
        );
        if (summonWeapon) {
            await summonWeapon.update({ "system.damage": damageFormula });
        }
    }

    // ---------------- place the token with one map click --------------------
    if (!game.user.can("TOKEN_CREATE")) {
        return ui.notifications.warn(
            `${summonName} is ready, but you lack the 'Create New Tokens' permission — ask the GM to place it.`,
        );
    }
    ui.notifications.info(`Click on the map to place ${summonName}.`);
    canvas.stage.once("pointerdown", async (event) => {
        try {
            const point = event.getLocalPosition(canvas.stage);
            const topLeft = canvas.grid.getTopLeftPoint(point);
            const tokenData = (
                await summon.getTokenDocument({ x: topLeft.x, y: topLeft.y })
            ).toObject();
            await canvas.scene.createEmbeddedDocuments("Token", [tokenData]);
            ui.notifications.info(`${summonName} summoned.`);
        } catch (err) {
            console.error("Spiritual Weapon |", err);
            ui.notifications.error(`Spiritual Weapon placement: ${err.message}`);
        }
    });
}
