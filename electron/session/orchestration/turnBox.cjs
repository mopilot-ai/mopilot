// A chat's own task list and its wrap-up box, set by the agent on any harness (update_task_list, wrap_up): the list
// stays pinned under the latest message, and the wrap-up's recap, one question and up to two answers show at the end
// of the turn. A linked session's recap is what its parent's note quotes. A new turn clears the box; the user's next
// message leaves the list stale (from before that message) until the agent updates it (a turn that ends without the agent touching it drops it: dropStaleList, #4927),
// and wrap_up refuses to close a turn over a stale list with steps left. wrap_up checks off the step in progress when it is the last one open.

const { isMomoMeta } = require('../../../shared/momoChat.mjs');

/** The task list's limits: how many steps, and how long each may be. */
const MAX_STEPS = 20;
const STEP_CHARS = 200;
const RECAP_CHARS = 600;
const ASK_CHARS = 200;
const LABEL_CHARS = 24;
const MESSAGE_CHARS = 300;
const STATUSES = ['pending', 'in_progress', 'completed'];

/**
 * @param {string} code
 * @param {string} [message]
 * @returns {never}
 */
function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

/** A text argument within `max` characters, trimmed, or null when absent. */
function text(v, max, name) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !v.trim() || [...v.trim()].length > max)
    fail(`invalid_${name}`, `${name} is text of at most ${max} characters`);
  return v.trim();
}

/** A 1-based step number of `items`, as a 0-based index. */
function stepIndex(n, items) {
  if (!Number.isInteger(n) || n < 1 || n > items.length) fail('invalid_step', `steps are numbered 1 to ${items.length}`);
  return n - 1;
}

/**
 * update_task_list: the whole list (`items`), or a change to the one there, as Claude Code's turn box applies it:
 * `done` completes the steps it numbers; `start` puts one step in progress; `advance` completes the first step in
 * progress and starts the next pending one after it (or the first pending one). Steps need not finish in order: a step
 * left for another stays in progress until `done` or `advance` completes it, so two can be in progress at once.
 * @param {any} orch the Orchestrator
 * @param {string} chatId
 * @param {{ items?: { content: string, status: string }[], advance?: boolean, done?: number[], start?: number }} a
 */
function updateTaskList(orch, chatId, a) {
  const { journal } = orch;
  let items;
  if (a.items !== undefined) {
    if (!Array.isArray(a.items) || !a.items.length || a.items.length > MAX_STEPS)
      fail('invalid_items', `items is a list of 1 to ${MAX_STEPS} steps`);
    items = a.items.map((s) => {
      if (!s || !STATUSES.includes(s.status)) fail('invalid_status', 'a step’s status is pending, in_progress or completed');
      return {
        content: text(s.content, STEP_CHARS, 'content') ?? fail('invalid_content', 'each step needs its content'),
        status: s.status,
      };
    });
  } else {
    const current = journal.data.plans[chatId];
    if (!current) fail('no_task_list', 'There is no task list yet: send the whole list with items first');
    items = current.items.map((s) => ({ ...s }));
    for (const n of Array.isArray(a.done) ? a.done : []) items[stepIndex(n, items)].status = 'completed';
    if (a.start !== undefined) items[stepIndex(a.start, items)].status = 'in_progress';
    if (a.advance) {
      const running = items.findIndex((s) => s.status === 'in_progress');
      if (running >= 0) items[running].status = 'completed';
      const after = items.findIndex((s, i) => i > running && s.status === 'pending');
      const next = after >= 0 ? after : items.findIndex((s) => s.status === 'pending');
      if (next >= 0) items[next].status = 'in_progress';
    }
  }
  // any update is the agent's plan for the user's latest message again: it is no longer stale
  journal.change((d) => (d.plans[chatId] = { turn: orch.turnOf(chatId), items, at: orch.o.now() }));
  const now = items.find((s) => s.status === 'in_progress');
  return {
    steps: items.length,
    completed: items.filter((s) => s.status === 'completed').length,
    in_progress: now?.content ?? null,
    next: items.every((s) => s.status === 'completed')
      ? 'All listed steps are completed. Verify the outcome and close the turn.'
      : 'Continue the unfinished work and keep this list current. A list does not schedule execution: before ending a turn waiting for CI or a PR merge, save set_pr_monitor.continuation with the condition and already-authorized next steps. Never mark unperformed work completed.',
  };
}

/**
 * Whether the user's message (a new turn or a word steered into the running one) changes a chat's task list: one the
 * agent kept since the last such message becomes the plan from before it (Claude Desktop's "Plan from before your last
 * message") until the agent updates it again. Automatic turns (a wake-up, a family message) carry on with it.
 */
function listToAge(data, chatId) {
  const plan = data.plans[chatId];
  return !!plan && !plan.stale;
}

/**
 * Ages the list in a journal draft: stale (the plan from before the message, carried through the turn it starts), or
 * gone when every step is done (no plan to follow). In MoMo's chats it is gone at once: the thread shows nothing
 * of an earlier plan after an unrelated message (#4927): MoMo's one chat takes unrelated requests.
 * `orch`: the Orchestrator, which knows the chat's meta.
 */
function ageTaskList(d, chatId, orch) {
  const momo = isMomoMeta(orch?.o?.chats?.records?.get(chatId)?.meta);
  if (momo || d.plans[chatId].items.every((s) => s.status === 'completed')) delete d.plans[chatId];
  else d.plans[chatId].stale = true;
}

/**
 * A turn ended (finished, stopped, failed or its harness quit): a list still from before the user's message was carried
 * through this one turn and the agent did not touch it, so it is dropped (#4927). Without this a list the user moved on
 * from is drawn before every later turn for ever, most visibly in MoMo's main chat.
 * @param {any} orch @param {string} chatId
 */
function dropStaleList(orch, chatId) {
  if (!orch.journal.data.plans[chatId]?.stale) return;
  orch.safely('drop the plan the user moved on from', () => orch.journal.change((d) => void delete d.plans[chatId]));
}

/**
 * At start no turn is running anywhere, so every list still stale belongs to a turn that is over (it was left by a version
 * before dropStaleList, or by a quit mid-turn): they are all dropped in one journal write, so a chat nobody opens again
 * does not keep its record for ever (#4927). Cost: one pass over the journal's lists, one write when any was stale.
 * @param {any} orch
 */
function sweepStaleLists(orch) {
  if (orch.unavailable) return;
  const stale = Object.keys(orch.journal.data.plans).filter((id) => orch.journal.data.plans[id].stale);
  if (!stale.length) return;
  orch.safely('drop the plans left stale by an earlier run', () =>
    orch.journal.change((d) => {
      for (const id of stale) delete d.plans[id];
    }),
  );
}

/** The turn each chat's wrap_up was last refused in for a stale list, per Orchestrator. */
const refusals = new WeakMap();
/** @returns {Map<string, unknown>} */
function refusedIn(orch) {
  if (!refusals.has(orch)) refusals.set(orch, new Map());
  return refusals.get(orch);
}

/**
 * wrap_up: the recap of the turn (what is now true and where it stands), and when the next move is the user's, one
 * question with one or two answers they can click. As Claude Desktop's wrap_up, it checks off the task list: the step
 * in progress is completed when it is the only one left open (the closing `advance`); a list with other steps open
 * keeps them, so unperformed work is never marked completed. A list from before the user's latest message that still
 * has steps open is refused once a turn: the agent sends the list for this message first, so the pinned list never
 * shows a plan the user has moved on from; one that keeps its harness's own plan instead is let through after that.
 * @param {any} orch
 * @param {string} chatId
 * @param {{ recap: string, ask?: string, actions?: { label: string, message?: string }[] }} a
 */
function wrapUp(orch, chatId, a) {
  const plan = orch.journal.data.plans[chatId];
  const open = plan ? plan.items.filter((s) => s.status !== 'completed') : [];
  // once per turn: an agent that keeps its harness's own plan instead is let through on its second call
  const refused = refusedIn(orch);
  const turn = orch.turnOf(chatId);
  if (plan?.stale && open.length && refused.get(chatId) !== turn) {
    refused.set(chatId, turn);
    fail('stale_task_list', STALE);
  }
  const recap = text(a.recap, RECAP_CHARS, 'recap') ?? fail('invalid_recap', 'recap is required');
  const ask = text(a.ask, ASK_CHARS, 'ask');
  let actions = [];
  if (a.actions !== undefined) {
    if (!ask) fail('actions_need_ask', 'actions answer the ask: pass ask with them');
    if (!Array.isArray(a.actions) || !a.actions.length || a.actions.length > 2) fail('invalid_actions', 'actions are 1 or 2 answers');
    actions = a.actions.map((x) => ({
      label: text(x?.label, LABEL_CHARS, 'label') ?? fail('invalid_label', 'each answer needs its label'),
      message: text(x?.message, MESSAGE_CHARS, 'message'),
    }));
  }
  orch.journal.change((d) => {
    d.wrapUps[chatId] = { turn, recap, ask, actions, at: orch.o.now() };
    // the closing advance: the last open step, the one in progress, is what this turn finished
    const last = open.length === 1 && open[0].status === 'in_progress' ? plan.items.indexOf(open[0]) : -1;
    if (last >= 0) d.plans[chatId].items[last].status = 'completed';
  });
  const shown = boxed({ ask, actions });
  // the box ends the turn (the registry passes endsTurn on to the harness, and the text says it to any harness)
  return {
    shown,
    ...(ask ? { asked: ask } : {}),
    next: shown ? ENDS_TURN : ask ? ASK_IN_CLOSING : CLOSING,
    ...(shown ? { endsTurn: true } : {}),
  };
}

/**
 * Whether a wrap-up draws the box: only a question with answers to click, as in Claude Desktop. A recap alone is the
 * session's status (its parent's report), and the closing message is the answer.
 * @param {{ ask?: string | null, actions?: unknown[] }} w
 */
function boxed(w) {
  return !!w.ask && !!w.actions?.length;
}

// why wrap_up refused: the list is the plan from before the user's latest message (listToAge), with steps left
const STALE =
  'Not shown: your task list is still the plan from before the user’s latest message, with steps left open. Call update_task_list first with the whole list for this message ({"items": [...]}: steps you finished "completed", the one you are on "in_progress", work still waiting "pending"), then call wrap_up again. If the plan the user sees is your own plan tool’s, call wrap_up again as it is.';

// what the agent is told to do after the call (Claude Desktop's wording): the box is the turn's end, or the closing
// message comes after it, never both, so nothing says the same thing twice or points at a box that is not there
const ENDS_TURN = 'The box ends your turn: write no text after this call, since the recap and question already say what the user needs.';
const CLOSING =
  'The app draws no box for this call; the recap is the session’s status. Your closing message is your answer to the user: write it now, as the last thing you say this turn.';
const ASK_IN_CLOSING =
  'A question with no answers to click draws no box. Write your closing message now, as the last thing you say this turn, and put your question to the user there.';

/** The recap a chat's wrap_up gave in the turn that `inputToken` started, or null: what its parent's note quotes. */
function recapOf(journal, chatId, inputToken) {
  const w = journal.data.wrapUps[chatId];
  return w && inputToken && w.turn === inputToken ? w.recap : null;
}

module.exports = { updateTaskList, wrapUp, boxed, recapOf, listToAge, ageTaskList, dropStaleList, sweepStaleLists, MAX_STEPS, RECAP_CHARS };
