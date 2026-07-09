/* globals game, ui, Dialog, WhisperBox, document */

// ============================================================
// MD Campaigns SW Tweaks — WhisperBox helpers
//
// Both functions require the WhisperBox module.
//
// whisper():     pick any user from a dialog, open a WhisperBox at them.
//                Works for players too.
// whisperToDM(): one click, no selector — opens a WhisperBox aimed straight
//                at the DM (active GM preferred, first GM user as fallback).
//
// Public API: game.modules.get(MODULE_ID).api.whisper()
//             game.modules.get(MODULE_ID).api.whisperToDM()
// ============================================================

export async function whisper() {
  if (typeof WhisperBox === "undefined") {
    return ui.notifications.warn("WhisperBox module is not active.");
  }

  var users = game.users.contents;
  var selectOptions = "";
  users.forEach(user => selectOptions += `<option value = "${user.id}">${user.name}</option>\n`);

  var dp = {
    title: "Create a WhisperBox",
    content: `Pick a user:<select id="users" name="users">${selectOptions}</select>`,
    buttons: {
      whisper: {
        label: "Whisper",
        callback: () => {
          let uid = document.getElementById("users").value;
          let user = game.users.find(user => user.id === uid);

          let name = user.name;
          if (game.settings.get('WhisperBox', 'showCharacterName')) {
            name = user?.character?.name ?? name;
          }

          WhisperBox.createWhisperBox({ name: name, targetUser: uid });
        }
      }
    }
  };
  let d = new Dialog(dp);
  d.render(true);
}

export async function whisperToDM() {
  if (typeof WhisperBox === "undefined") {
    return ui.notifications.warn("WhisperBox module is not active.");
  }

  // Prefer an active GM; fall back to the first GM user if none are currently online.
  let gm = game.users.activeGM ?? game.users.find(u => u.isGM);

  if (!gm) {
    ui.notifications.warn("No GM user found to whisper to.");
  } else {
    let name = gm.name;
    if (game.settings.get('WhisperBox', 'showCharacterName')) {
      name = gm?.character?.name ?? name;
    }
    WhisperBox.createWhisperBox({ name: name, targetUser: gm.id });
  }
}
