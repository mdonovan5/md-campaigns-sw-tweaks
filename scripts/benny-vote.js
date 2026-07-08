/* globals game, ui, Hooks, ChatMessage, CONFIG, foundry, console, setInterval, clearInterval, setTimeout, clearTimeout */

// ============================================================
// Benny Vote — GM-toggled recurring peer-nomination polls.
//
// GM toggles the mode via game.modules.get(...).api.toggleBennyVote()
// (called from the "Benny Vote Toggle" world macro). While active,
// every N minutes each active non-GM user gets a dialog: a hand-raise
// reminder banner, a radio list of benny candidates (plus "Nobody",
// pre-selected), and an optional reason field. Results are whispered
// to the GM.
//
// Transport: core user queries (CONFIG.queries + User#query), which
// the Foundry server relays natively — no module socket flag needed.
// The GM client is the sole timer authority; the mode does not
// persist across a GM reload.
// ============================================================

const MODULE_ID = "md-campaigns-sw-tweaks";
const LOG_PREFIX = `${MODULE_ID} |`;

const QUERY_VOTE = "mdcswt.bennyVote";
const QUERY_CANCEL = "mdcswt.bennyVoteCancel";

const VOTE_TIMEOUT_MS = 3 * 60 * 1000; // player dialog lifetime
const GM_GRACE_MS = 15 * 1000; // GM-side safety margin past the dialog lifetime
const REASON_MAX = 200;
const NOBODY = "__nobody__";

/** GM-side mode state. In-memory only; a reload deactivates the mode. */
const state = {
  active: false,
  intervalId: null,
  lastMinutes: 15,
  currentPollId: null,
};

/** Player-side: the currently open vote dialog, if any. */
let openVoteDialog = null;
let openVoteTimeout = null;

const loc = (key) => game.i18n.localize(key);

/**
 * Registers settings and user-query handlers. Called from the module's
 * init hook on every client.
 */
export function registerBennyVote() {
  game.settings.register(MODULE_ID, "bennyVoteCandidates", {
    name: "MDCSWT.BennyVote.Candidates",
    hint: "MDCSWT.BennyVote.CandidatesHint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, "bennyVoteHandReminder", {
    name: "MDCSWT.BennyVote.HandReminder",
    hint: "MDCSWT.BennyVote.HandReminderHint",
    scope: "world",
    config: true,
    type: String,
    default:
      "If you know what you're doing this round, raise your hand so we can keep things moving!",
  });
  CONFIG.queries[QUERY_VOTE] = onVoteQuery;
  CONFIG.queries[QUERY_CANCEL] = onCancelQuery;
}

/**
 * Toggles benny-vote mode on or off. GM only. Exposed on the module API
 * and called from the Benny Vote Toggle macro.
 */
export async function toggleBennyVote() {
  if (!game.user.isGM) {
    ui.notifications.warn(loc("MDCSWT.BennyVote.GMOnly"));
    return;
  }
  if (state.active) {
    deactivate();
    return;
  }
  if (!parseCandidates().length) {
    ui.notifications.warn(loc("MDCSWT.BennyVote.NoCandidates"));
    return;
  }
  const choices = await showActivationDialog();
  if (!choices) return;
  state.lastMinutes = choices.minutes;
  state.active = true;
  state.intervalId = setInterval(() => runPoll(), choices.minutes * 60 * 1000);
  ui.notifications.info(
    game.i18n.format("MDCSWT.BennyVote.Activated", { minutes: choices.minutes }),
  );
  if (choices.startNow) runPoll();
}

/** Deactivates the mode, discarding any in-flight poll. GM client only. */
function deactivate() {
  if (state.intervalId !== null) clearInterval(state.intervalId);
  state.intervalId = null;
  state.active = false;
  const pollWasRunning = state.currentPollId !== null;
  state.currentPollId = null; // runPoll() checks this and discards its results
  for (const user of game.users.filter((u) => u.active && !u.isGM)) {
    user.query(QUERY_CANCEL, {}).catch(() => {});
  }
  ui.notifications.info(
    loc(
      pollWasRunning
        ? "MDCSWT.BennyVote.DeactivatedDiscard"
        : "MDCSWT.BennyVote.Deactivated",
    ),
  );
}

/** Parses the comma-delimited candidate setting into trimmed names. */
function parseCandidates() {
  return game.settings
    .get(MODULE_ID, "bennyVoteCandidates")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Shows the activation dialog. Resolves to {minutes, startNow} or null
 * on cancel.
 */
async function showActivationDialog() {
  const content = `
    <div class="form-group">
      <label>${loc("MDCSWT.BennyVote.Frequency")}</label>
      <input type="number" name="minutes" min="5" step="1" value="${state.lastMinutes}">
    </div>
    <div class="form-group">
      <label>${loc("MDCSWT.BennyVote.StartNow")}</label>
      <input type="checkbox" name="startNow" checked>
    </div>`;
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: loc("MDCSWT.BennyVote.ActivateTitle") },
    content: content,
    rejectClose: false,
    buttons: [
      {
        action: "activate",
        label: loc("MDCSWT.BennyVote.Activate"),
        default: true,
        callback: (event, button) => {
          const form = button.form.elements;
          const raw = Number(form.minutes.value);
          const minutes = Number.isFinite(raw) ? Math.max(5, Math.round(raw)) : 15;
          return { minutes: minutes, startNow: form.startNow.checked };
        },
      },
      {
        action: "cancel",
        label: loc("MDCSWT.BennyVote.Cancel"),
        callback: () => null,
      },
    ],
  });
  return result && typeof result === "object" ? result : null;
}

/**
 * Runs one poll: fans a vote query out to every active non-GM user,
 * waits for all answers (or timeouts), then whispers the summary to
 * the GM. Skips silently if a poll is already in flight.
 */
async function runPoll() {
  if (!state.active || state.currentPollId) return;
  const candidates = parseCandidates();
  if (!candidates.length) {
    ui.notifications.warn(loc("MDCSWT.BennyVote.NoCandidates"));
    return;
  }
  const voters = game.users.filter((u) => u.active && !u.isGM);
  if (!voters.length) {
    ui.notifications.info(loc("MDCSWT.BennyVote.NoPlayers"));
    return;
  }
  const pollId = foundry.utils.randomID();
  state.currentPollId = pollId;
  const payload = {
    pollId: pollId,
    candidates: candidates,
    reminder: game.combat?.started ? game.settings.get(MODULE_ID, "bennyVoteHandReminder") : "",
  };
  const results = await Promise.all(voters.map((u) => queryVoter(u, payload)));
  // Discard if the mode was toggled off (or re-toggled) mid-poll.
  if (!state.active || state.currentPollId !== pollId) return;
  state.currentPollId = null;
  await whisperSummary(voters, results);
}

/**
 * Queries one voter. Never rejects: disconnects, errors, and the
 * GM-side safety timeout all resolve as an unanswered vote.
 * @returns {Promise<{answered: boolean, choice: string|null, reason: string}>}
 */
async function queryVoter(user, payload) {
  const unanswered = { answered: false, choice: null, reason: "" };
  const safety = new Promise((resolve) =>
    setTimeout(() => resolve(unanswered), VOTE_TIMEOUT_MS + GM_GRACE_MS),
  );
  try {
    const answer = await Promise.race([user.query(QUERY_VOTE, payload), safety]);
    if (answer && typeof answer === "object") {
      return {
        answered: answer.answered === true,
        choice: typeof answer.choice === "string" ? answer.choice : null,
        reason:
          typeof answer.reason === "string" ? answer.reason.slice(0, REASON_MAX) : "",
      };
    }
  } catch (err) {
    console.warn(LOG_PREFIX, `benny vote query to ${user.name} failed:`, err);
  }
  return unanswered;
}

/** Builds and whispers the results summary to the GM. */
async function whisperSummary(voters, results) {
  const esc = foundry.utils.escapeHTML;
  const tally = new Map(); // candidate name -> [{voter, reason}]
  const nobody = [];
  const noAnswer = [];
  results.forEach((r, i) => {
    const voter = voters[i].name;
    if (!r.answered) noAnswer.push(voter);
    else if (r.choice === null) nobody.push(voter);
    else {
      if (!tally.has(r.choice)) tally.set(r.choice, []);
      tally.get(r.choice).push({ voter: voter, reason: r.reason });
    }
  });
  const voteCount = (n) => game.i18n.format("MDCSWT.BennyVote.VoteCount", { count: n });
  const parts = [`<h3>${loc("MDCSWT.BennyVote.ResultsTitle")}</h3>`];
  const ranked = [...tally.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [name, votes] of ranked) {
    const lines = votes
      .map(
        (v) =>
          `&mdash; ${esc(v.voter)}: ${
            v.reason
              ? `"${esc(v.reason)}"`
              : `<em>${loc("MDCSWT.BennyVote.NoReason")}</em>`
          }`,
      )
      .join("<br>");
    parts.push(
      `<p><strong>${esc(name)}</strong> &mdash; ${voteCount(votes.length)}<br>${lines}</p>`,
    );
  }
  if (nobody.length) {
    parts.push(
      `<p><strong>${loc("MDCSWT.BennyVote.Nobody")}</strong> &mdash; ${voteCount(
        nobody.length,
      )} (${nobody.map(esc).join(", ")})</p>`,
    );
  }
  if (noAnswer.length) {
    parts.push(
      `<p><strong>${loc("MDCSWT.BennyVote.NoAnswer")}</strong> ${noAnswer
        .map(esc)
        .join(", ")}</p>`,
    );
  }
  await ChatMessage.create({
    content: parts.join("\n"),
    speaker: { alias: loc("MDCSWT.BennyVote.PollTitle"), actor: null, token: null, scene: null },
    whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
  });
}

// ------------------------------------------------------------
// Player-side query handlers
// ------------------------------------------------------------

/**
 * Handles an incoming vote query: shows the vote dialog and resolves
 * with the player's answer. Timeout, Escape, and cancel all resolve as
 * unanswered.
 * @returns {Promise<{answered: boolean, choice: string|null, reason: string}>}
 */
async function onVoteQuery(data = {}) {
  closeOpenVoteDialog();
  const unanswered = { answered: false, choice: null, reason: "" };
  const candidates = Array.isArray(data.candidates)
    ? data.candidates.filter((c) => typeof c === "string" && c.length)
    : [];
  if (!candidates.length) return unanswered;
  const esc = foundry.utils.escapeHTML;
  const reminder = typeof data.reminder === "string" ? data.reminder.trim() : "";
  const reminderHtml = reminder
    ? `<div class="mdcswt-bv-reminder" style="border: 1px solid var(--color-border-light-primary); border-radius: 4px; padding: 6px 8px; margin-bottom: 8px;">&#9995; ${esc(reminder)}</div>`
    : "";
  const radios = candidates
    .map(
      (name) =>
        `<label class="mdcswt-bv-option" style="display: block;"><input type="radio" name="choice" value="${esc(name)}"> ${esc(name)}</label>`,
    )
    .join("\n      ");
  const content = `
    ${reminderHtml}
    <p>${loc("MDCSWT.BennyVote.Prompt")}</p>
    <div class="form-group stacked">
      ${radios}
      <label class="mdcswt-bv-option" style="display: block;"><input type="radio" name="choice" value="${NOBODY}" checked> ${loc("MDCSWT.BennyVote.Nobody")}</label>
    </div>
    <div class="form-group">
      <label>${loc("MDCSWT.BennyVote.ReasonLabel")}</label>
      <input type="text" name="reason" placeholder="${loc("MDCSWT.BennyVote.ReasonPlaceholder")}" disabled>
    </div>`;
  let result = null;
  try {
    result = await foundry.applications.api.DialogV2.wait({
      window: { title: loc("MDCSWT.BennyVote.PollTitle") },
      content: content,
      rejectClose: false,
      buttons: [
        {
          action: "send",
          label: loc("MDCSWT.BennyVote.Send"),
          default: true,
          callback: (event, button) => {
            const form = button.form.elements;
            const choice = form.choice.value;
            if (choice === NOBODY) return { answered: true, choice: null, reason: "" };
            const reason = String(form.reason.value ?? "")
              .trim()
              .slice(0, REASON_MAX);
            return { answered: true, choice: choice, reason: reason };
          },
        },
      ],
      render: (event, dialog) => {
        openVoteDialog = dialog;
        openVoteTimeout = setTimeout(() => dialog.close(), VOTE_TIMEOUT_MS);
        const reasonInput = dialog.element.querySelector('input[name="reason"]');
        if (reasonInput) reasonInput.maxLength = REASON_MAX;
        for (const radio of dialog.element.querySelectorAll('input[name="choice"]')) {
          radio.addEventListener("change", () => {
            if (reasonInput) reasonInput.disabled = radio.value === NOBODY;
          });
        }
      },
    });
  } finally {
    if (openVoteTimeout) clearTimeout(openVoteTimeout);
    openVoteTimeout = null;
    openVoteDialog = null;
  }
  return result && typeof result === "object" ? result : unanswered;
}

/** Handles a cancel query from the GM: closes any open vote dialog. */
function onCancelQuery() {
  closeOpenVoteDialog();
  return true;
}

/** Closes the currently open vote dialog, if any (player side). */
function closeOpenVoteDialog() {
  if (openVoteTimeout) {
    clearTimeout(openVoteTimeout);
    openVoteTimeout = null;
  }
  if (openVoteDialog) {
    const dialog = openVoteDialog;
    openVoteDialog = null;
    dialog.close();
  }
}
