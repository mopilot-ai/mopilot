// Chrome's side panel following a chat live: each harness's raw events read as reply text or "the chat changed" for the chats a panel watches, and a chat's history turns as the panel's rows.
const { phoneItemIdentity } = require('../../../shared/phoneItemIdentity.mjs');
//
// The chat's history (read back from the harness, peerTranscript.cjs) is what the panel shows; the reply's text as it
// streams is only shown until a read holds it (chrome-extension/src/panelPreview.mjs). So main keeps no second copy of a transcript: it reads
// three event shapes for their text and signals a change for anything else that moves the turn on.
const { turnIdentity } = require('../../../shared/chatNotes.mjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { draftOf, draftLine } = require('../../../shared/momoDraft.mjs');
const { readSend } = require('../../../shared/momoDraftSend.mjs');
const { briefCardOf } = require('../../../shared/momoBriefNote.mjs');
const { withOptions } = require('../../../shared/momoOptions.mjs');
const { parseUserText, prettyCommand } = require('../../../shared/userText.mjs');
const { stepDetails } = require('../contract/chromePanelStep.cjs');
const { toolLine, stateOfCall, say, line } = require('./chromePanelToolLines.cjs');
const { stateOf } = require('../../remote/chatState.cjs');

/** @typedef {import('./chromePanelToolLines.cjs').StepState} StepState */
/** @typedef {{ role: 'user' | 'assistant' | 'step' | 'note', text: string, options?: string[], images?: number, state?: 'running' | 'failed', tab?: string, runId?: string, id?: string, phoneId?: string, detail?: string, thumbnail?: string, surface?: string, truncated?: boolean, limit?: boolean, refusal?: boolean, workedMs?: number, nudge?: PanelNudge, draft?: import('../../../shared/momoDraft.mjs').Draft, send?: import('../../../shared/momoDraftSend.mjs').Send, suggestion?: import('../../../shared/momoBriefNote.mjs').BriefCard }} PanelRow */
/** @typedef {{ loopId: string, title: string, quote?: string, saidAt?: number, trigger?: string, why?: string }} PanelNudge a MoMo nudge's loop and why it was sent (app/momoNudges.cjs nudgeNote), for its Done, Snooze and Dismiss */

/** How long a panel's watch lasts unless it reads the chat again (a panel closed without saying so). */
const WATCH_MS = 10 * 60_000;
/** At most one "changed" per chat in this long: a turn's burst of events is one read. */
const CHANGED_MS = 400;
const MAX_ROWS = 200;
/** Folded steps still create DOM nodes: bound their details separately from message blocks. */
const MAX_STEPS = 2000;
const MAX_TEXT = 20_000;
/** All the rows' text together: the recent end of a long chat, so one read stays small. */
const MAX_TOTAL = 400_000;
/** A command's line: its first line, cut to this many characters. */
const MAX_COMMAND = 80;
/** Files an edit names before "and N more". */
const NAMED_FILES = 2;

/** Codex notifications that move a turn on (anything else, deltas aside, changes nothing the panel shows). */
const CODEX_CHANGES = new Set(['item/started', 'item/completed', 'turn/started', 'turn/completed', 'thread/name/updated']);

/**
 * What one raw event means for the panel: reply text, a change to read, or nothing.
 * @param {'codex' | 'claude' | 'acp'} family @param {any} e the event as the controller received it
 * @param {(key: string) => string} chatOf the chat a native session or thread belongs to
 * @returns {{ chatId: string, text: string } | { chatId: string, changed: true } | null}
 */
function liveOf(family, e, chatOf) {
  if (e?.kind === 'threadName' && typeof e.chatId === 'string') return { chatId: e.chatId, changed: true };
  if (family === 'codex') {
    const p = e?.params ?? {};
    if (!p.threadId) return null;
    if (e.method === 'item/agentMessage/delta' && typeof p.delta === 'string') return { chatId: chatOf(p.threadId), text: p.delta };
    return CODEX_CHANGES.has(e.method) ? { chatId: chatOf(p.threadId), changed: true } : null;
  }
  if (family === 'claude') {
    const m = e?.kind === 'message' ? e.msg : null;
    // a sub-agent's messages are its own; the chat's reply is the main agent's
    if (!m || m.parent_tool_use_id) return null;
    if (m.type === 'stream_event') {
      const d = m.event?.type === 'content_block_delta' ? m.event.delta : null;
      return d?.type === 'text_delta' && typeof d.text === 'string' ? { chatId: chatOf(e.key), text: d.text } : null;
    }
    // a rate limit event moves no row but may bring the usage warning the next read carries
    return ['assistant', 'user', 'result', 'rate_limit_event'].includes(m.type) ? { chatId: chatOf(e.key), changed: true } : null;
  }
  if (e?.kind === 'update') {
    const u = e.update ?? {};
    if (u.sessionUpdate === 'agent_message_chunk')
      return u.content?.type === 'text' && typeof u.content.text === 'string' ? { chatId: chatOf(e.key), text: u.content.text } : null;
    return u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update' ? { chatId: chatOf(e.key), changed: true } : null;
  }
  return e?.kind === 'turnStart' || e?.kind === 'turnEnd' || e?.kind === 'question' ? { chatId: chatOf(e.key), changed: true } : null;
}

/** The chats panels watch, and what of their live events reaches the panel. */
class PanelWatch {
  /**
   * @param {{ chatOf: (key: string) => string, push: (event: object) => void, now?: () => number,
   *           timers?: { setTimeout: typeof setTimeout } }} o
   *   push: one update for the panels (the extension's connection)
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? globalThis;
    /** @type {Map<string, number>} chat id -> until when it is watched */
    this.watched = new Map();
    /** @type {Map<string, any>} chat id -> the "changed" waiting to go */
    this.pending = new Map();
    /** @type {Set<string>} chats whose turn moved on (a step, a finished message) since their last text: the next reply text is a new paragraph */
    this.broken = new Set();
  }

  /** A panel shows the chat: its live events go to the panel for WATCH_MS from now. */
  watch(/** @type {string} */ chatId) {
    const now = this.now();
    // the watches that lapsed go, so the map holds the chats panels show now
    this.watched = new Map([...this.watched].filter(([, until]) => until >= now));
    this.watched.set(chatId, now + WATCH_MS);
  }

  /** One raw event from the controller (ChatController.onLiveEvent). */
  event(/** @type {'codex' | 'claude' | 'acp'} */ family, /** @type {any} */ e) {
    const live = liveOf(family, e, this.o.chatOf);
    if (!live) return;
    const until = this.watched.get(live.chatId);
    if (until === undefined) return;
    if (until < this.now()) {
      this.watched.delete(live.chatId);
      this.broken.delete(live.chatId);
      return;
    }
    if ('text' in live) {
      // a reply streamed after the turn moved on is another message: a blank line keeps it apart (the panel's match
      // with the read's rows ignores whitespace, and a reply's leading blank line draws nothing)
      if (live.text)
        this.o.push({ kind: 'delta', chatId: live.chatId, text: this.broken.delete(live.chatId) ? `\n\n${live.text}` : live.text });
      return;
    }
    this.broken.add(live.chatId);
    if (this.pending.has(live.chatId)) return;
    this.pending.set(
      live.chatId,
      this.timers.setTimeout(() => {
        this.pending.delete(live.chatId);
        this.o.push({ kind: 'changed', chatId: live.chatId });
      }, CHANGED_MS),
    );
  }
}

/** What a user's message carries (text parts, joined), and the Chrome tab it was sent from. */
function userText(/** @type {any} */ item) {
  const parts = Array.isArray(item.content) ? item.content : [];
  // what the user typed, as the app shows it: no referenced chats' snapshots, handoff or memory blocks before it
  return parseUserText(
    parts
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n'),
  );
}

/**
 * A command in one short line: the model's own description of it (the same in every state: it is the model's wording),
 * else its first line, cut short: "Running npm test", "Ran npm test", "npm test failed" (a command that ran and failed is
 * not one that could not run).
 */
function commandLine(/** @type {any} */ item, /** @type {StepState} */ state) {
  if (typeof item.description === 'string' && item.description.trim()) {
    const description = item.description.trim().split('\n')[0];
    return description.length > MAX_COMMAND ? `${prefixUnits(description, MAX_COMMAND)}…` : description;
  }
  const command = typeof item.command === 'string' ? prettyCommand(item.command).trim() : '';
  if (!command) return say(line('Running a command', 'Ran a command', 'A command failed'), state);
  const [first] = command.split('\n');
  const cut = first.length > MAX_COMMAND ? `${prefixUnits(first, MAX_COMMAND)}…` : first !== command ? `${first} …` : first;
  return say(line(`Running ${cut}`, `Ran ${cut}`, `${cut} failed`), state);
}

/** An edit in one short line, naming its files: "Edited a.md, b.html and 2 more" ("Created" when every one is new). */
function editLine(/** @type {any} */ item, /** @type {StepState} */ state) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths = [...new Set(changes.map((c) => (typeof c?.path === 'string' ? c.path : '')).filter((p) => p && !/[\\/]$/.test(p)))];
  const bases = paths.map((p) => p.replace(/^.*[\\/]/, ''));
  const counts = new Map();
  for (const name of bases) counts.set(name, (counts.get(name) ?? 0) + 1);
  const names = paths.map((p, i) => (counts.get(bases[i]) > 1 ? p : bases[i]));
  const created = changes.length > 0 && changes.every((c) => c?.kind?.type === 'add');
  const [doing, done, failed] = created ? ['Creating', 'Created', 'Couldn’t create'] : ['Editing', 'Edited', 'Couldn’t edit'];
  const more = names.length - NAMED_FILES;
  const what = names.length ? `${names.slice(0, NAMED_FILES).join(', ')}${more > 0 ? ` and ${more} more` : ''}` : 'files';
  return say(line(`${doing} ${what}`, `${done} ${what}`, `${failed} ${what}`), state);
}

/**
 * A step the agent took, in one short line, as its state words it (a call with no status reads as done).
 * @param {any} item @param {boolean} [ended] the item's turn was stopped or failed: a call it left running runs no more
 */
function stepOf(item, ended = false) {
  const state = stateOfCall(item, ended);
  const query = typeof item.query === 'string' ? item.query : '';
  switch (item.type) {
    case 'commandExecution':
      return commandLine(item, state);
    case 'fileChange':
      return editLine(item, state);
    case 'webSearch':
      return say(
        query
          ? line(`Searching for ${query}`, `Searched for ${query}`, `Couldn’t search for ${query}`)
          : line('Searching the web', 'Searched the web', 'Couldn’t search the web'),
        state,
      );
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return toolLine(item, state);
    case 'collabAgentToolCall':
      return say(line('Running a sub-agent', 'Ran a sub-agent', 'Couldn’t run the sub-agent'), state);
    case 'plan':
      return say(line('Updating the plan', 'Updated the plan', 'Couldn’t update the plan'), state);
    default:
      return null;
  }
}

const clip = (/** @type {string} */ t) => (t.length > MAX_TEXT ? `${prefixUnits(t, MAX_TEXT)}…` : t);

/** A nudge note's loop and reasons, each field only when it is the type it should be; null without a loop id. @returns {PanelNudge | null} */
function nudgeOf(/** @type {any} */ n) {
  if (!n || typeof n !== 'object' || typeof n.loopId !== 'string' || !n.loopId) return null;
  const text = (/** @type {string} */ key) => (typeof n[key] === 'string' ? { [key]: clip(n[key]) } : {});
  return {
    loopId: n.loopId,
    title: typeof n.title === 'string' ? clip(n.title) : '',
    ...text('quote'),
    ...(Number.isFinite(n.saidAt) ? { saidAt: n.saidAt } : {}),
    ...text('trigger'),
    ...text('why'),
  };
}

/**
 * A chat's history turns as the panel's rows: what the user said (and the Chrome tab it was sent from), the agent's
 * replies, each step in one line, and the chat's notes that the account it runs on changed (shared/chatNotes.mjs put
 * them among the turns). Reasoning and anything without a short form are left out; the full chat is in MoPilot.
 * The recent end: at most MAX_ROWS displayed blocks (a folded step run counts once) and MAX_TOTAL characters.
 * `clipped` says rows before them were left out. `running`: main runs the chat's turn now, so its calls the harness still
 * reports in progress read as running; with it unsaid (an idle chat, an older page) nothing runs, whatever a stale history says.
 * @param {any[]} turns @param {{ running?: boolean }} [o]
 * @returns {{ rows: PanelRow[], clipped: boolean }}
 */
function rowsOf(turns, { running = false } = {}) {
  const { rows, clipped } = clipRows(allRowsOf(turns, running));
  return { rows, clipped };
}

/**
 * rowsOf, and whether a limit (MAX_ROWS blocks or MAX_TOTAL characters) ended the scan: the rows are then the same whatever earlier
 * history there is, so a reader of only the end of a history has read enough, however few rows that is.
 * `momo`: a MoMo chat, whose replies' `Options:` lines leave the text and come as `options` (a phone's answer chips).
 * @param {any[]} turns @param {{ running?: boolean, momo?: boolean }} [o]
 * @returns {{ rows: PanelRow[], clipped: boolean, limited: boolean }}
 */
function recentRowsOf(turns, { running = false, momo = false } = {}) {
  return clipRows(allRowsOf(turns, running, momo));
}

/** Every displayed row of a conversation, in order and unclipped. @param {any[]} turns @param {boolean} [running] @returns {PanelRow[]} */
function allRowsOf(turns, running = false, momo = false) {
  /** @type {PanelRow[]} */
  const rows = [];
  /** @type {string | null} */
  let runId = null;
  const all = Array.isArray(turns) ? turns : [];
  for (const [at, turn] of all.entries()) {
    // the turn's steps, and how many runs of them it has: a turn that worked in one run says how long it worked
    /** @type {PanelRow[]} */
    const turnSteps = [];
    let runs = 0;
    let inRun = false;
    // a call runs only in the turn main runs now: not in a chat that is idle, a turn that was stopped or failed under it, or one
    // another follows (a sub-agent of an earlier turn that settles later reads as the finished call it was)
    const ended = !running || turn?.status === 'interrupted' || turn?.status === 'failed' || at < all.length - 1;
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (!item || typeof item !== 'object') continue;
      const phoneId = phoneItemIdentity(turn.sourceSession, turn.id, item);
      const identity =
        typeof turn.id === 'string' && typeof item.id === 'string'
          ? { id: JSON.stringify([turn.sourceSession, turnIdentity(turn.id), item.id]), phoneId }
          : {};
      if (['userMessage', 'agentMessage', 'statusNote'].includes(item.type)) (runId = null), (inRun = false);
      if (item.type === 'userMessage') {
        const { text, chromeTab } = userText(item);
        // the pictures it came with: how many (a phone fetches each by its place, messages.image); history leaves their bytes out
        const images = (Array.isArray(item.content) ? item.content : []).filter(
          (/** @type {any} */ c) => c?.type === 'image' || c?.type === 'localImage',
        ).length;
        if (text || images)
          rows.push({
            role: 'user',
            text: clip(text),
            ...(images ? { images } : {}),
            ...(typeof item.clientId === 'string' ? { clientId: item.clientId } : {}),
            ...identity,
            ...(text.length > MAX_TEXT ? { truncated: true } : {}),
            ...(chromeTab ? { tab: prefixUnits(chromeTab, 2048) } : {}),
          });
      } else if (item.type === 'agentMessage') {
        if (typeof item.text === 'string' && item.text.trim()) {
          // MoMo's reply with its `Options:` line out of the text and its labels beside it (shared/momoOptions.mjs); no `options` when it has none
          const shown = momo ? withOptions(item) : item;
          rows.push({
            role: 'assistant',
            text: clip(shown.text),
            ...('options' in shown ? { options: shown.options } : {}),
            ...identity,
            ...(shown.text.length > MAX_TEXT ? { truncated: true } : {}),
          });
        }
      } else if (item.type === 'statusNote' && item.kind === 'nudge') {
        // a MoMo nudge: its line, and the loop its buttons act on (a phone's momo.loops.act)
        const nudge = nudgeOf(item.nudge);
        if (nudge && typeof item.text === 'string' && item.text) rows.push({ role: 'note', text: clip(item.text), nudge, ...identity });
      } else if (item.type === 'statusNote' && item.kind === 'draft') {
        // a draft MoMo wrote: its one line, and the words its card shows (Edit, Copy, Open in Mail); a note that is not a draft is not shown
        const draft = draftOf(item.draft);
        // and how far the user's Send got (the card's receipt), which the phone shows read only
        const send = readSend(item.send);
        if (draft) rows.push({ role: 'note', text: draftLine(draft), draft, ...(send ? { send } : {}), ...identity });
      } else if (item.type === 'statusNote' && item.kind === 'brief') {
        // a line of MoMo's morning brief, or its suggestion card (Hide, Start on the phone)
        const card = briefCardOf(item.suggestion);
        if (typeof item.text === 'string' && item.text)
          rows.push({ role: 'note', text: clip(item.text), ...(card ? { suggestion: card } : {}), ...identity });
      } else if (item.type === 'statusNote') {
        // the account moved, the account ran out of usage, the harness's safety filter paused the chat, or the chat moved to another agent: the panel says so where the turn stopped
        if (['account', 'limit', 'refusal', 'switch'].includes(item.kind) && typeof item.text === 'string' && item.text)
          rows.push({
            role: 'note',
            text: clip(item.text),
            ...(item.kind === 'limit' ? { limit: true } : item.kind === 'refusal' ? { refusal: true } : {}),
            ...identity,
          });
      } else {
        const step = stepOf(item, ended);
        if (step) {
          if (runId === null && typeof turn.id === 'string' && typeof item.id === 'string')
            runId = JSON.stringify([
              ...(typeof turn.sourceSession === 'string' ? [turn.sourceSession] : []),
              turnIdentity(turn.id),
              item.id,
            ]);
          if (!inRun) (inRun = true), runs++;
          const state = stateOfCall(item, ended);
          /** @type {PanelRow} */
          const row = {
            role: 'step',
            text: clip(step),
            ...(state === 'done' ? {} : { state }),
            ...stepDetails(item),
            ...(runId ? { runId } : {}),
            ...identity,
          };
          turnSteps.push(row);
          rows.push(row);
        }
      }
    }
    // "Worked for 11s", as ChatGPT's panel folds a turn's work: a completed turn (not one stopped or failed, which the app words otherwise) with one run of steps and a measured duration
    if (runs === 1 && turn?.status === 'completed' && Number.isFinite(turn?.durationMs) && turn.durationMs >= 1000)
      for (const row of turnSteps) row.workedMs = Math.round(turn.durationMs);
  }
  return rows;
}

/** The rows without a message of pictures alone: a phone draws its pictures, the side panel has nothing to draw for it. @param {PanelRow[]} rows */
function withoutPictureOnlyRows(rows) {
  return rows.filter((row) => row.role !== 'user' || row.text);
}

/** The recent end of the rows (see rowsOf). @param {PanelRow[]} rows @returns {{ rows: PanelRow[], clipped: boolean, limited: boolean }} */
function clipRows(rows) {
  let total = 0;
  let blocks = 0;
  let steps = 0;
  let clipped = false;
  let limited = false;
  const recent = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'step' && ++steps > MAX_STEPS) {
      clipped = true;
      continue;
    }
    total += rows[i].text.length + (rows[i].tab?.length ?? 0) + (rows[i].detail?.length ?? 0) + (rows[i].draft?.body.length ?? 0);
    if (rows[i].role !== 'step' || recent.at(-1)?.role !== 'step') blocks++;
    if (total > MAX_TOTAL || blocks > MAX_ROWS) {
      clipped = true;
      limited = true;
      break;
    }
    recent.push(rows[i]);
  }
  let screenshotKept = false;
  let currentTurn = true;
  for (const row of recent) {
    if (row.role === 'user') currentTurn = false;
    if (row.thumbnail) {
      if (!currentTurn || screenshotKept) delete row.thumbnail;
      else screenshotKept = true;
    }
  }
  return { rows: recent.reverse(), clipped, limited };
}

/** What a page of older rows may weigh, so its reply fits one sealed frame (256 KB) with room for the envelope. */
const PAGE_BYTES = 150_000;

/**
 * The page of rows just before the row named `before`: at most `limit` rows and PAGE_BYTES, and whether any are still earlier. The page
 * starts at a row that has an id, which is where the next page ends. Null when no row has the id asked for (the history changed since the
 * phone read it).
 * @param {any[]} turns @param {string} before @param {number} limit @param {boolean} [momo] a MoMo chat: its replies' Options lines become `options`
 * @returns {{ rows: PanelRow[], more: boolean } | null}
 */
function olderRowsOf(turns, before, limit, momo = false) {
  return pageOfRows(allRowsOf(turns, false, momo), before, limit);
}

/**
 * olderRowsOf over rows already made (a reader that holds a chat's rows between pages, electron/app/panelRowsCache.cjs): the same page, found by
 * the id of the row it ends before. `rows` is not changed.
 * @param {PanelRow[]} rows @param {string} before @param {number} limit
 * @returns {{ rows: PanelRow[], more: boolean } | null}
 */
function pageOfRows(rows, before, limit) {
  const at = rows.findIndex((r) => r.id === before);
  if (at < 0) return null;
  let start = at;
  let bytes = 0;
  while (start > 0 && at - start < limit) {
    bytes += JSON.stringify(rows[start - 1]).length;
    // always at least one row, however long
    if (bytes > PAGE_BYTES && start < at) break;
    start--;
  }
  // the next page asks for the rows before this page's first row, so that row must be nameable
  while (start > 0 && rows[start].id === undefined) start--;
  // a screenshot belongs to the live end of the chat
  const page = rows.slice(start, at).map(({ thumbnail: _thumbnail, ...row }) => row);
  return { rows: page, more: start > 0 };
}

/** The turn statuses every harness's translator writes (core/crates/translate, codexTurns, core/crates/translate). */
const TURN_STATUS = new Set(['inProgress', 'completed', 'interrupted', 'failed']);
/** A turn that is not `inProgress` may still be the one running (Claude's transcript replays it as completed): when its last message is this recent (seconds). */
const RECENT_S = 120;

/**
 * How the chat's last history turn ended and when it began (seconds), for the panel's progress line: "Stopped" for an
 * `interrupted` turn, "Failed" for a `failed` one, and the start the elapsed counter counts from. A turn with no
 * known status (or no turns) gives null: the panel keeps its plain line. The start is given only for a turn that can be
 * the one running (`inProgress`, or written to a moment ago): a turn from long before is the one the running turn has
 * not been written after yet. A start the harness has not written is left out.
 * @param {any[]} turns
 * @param {number} [now] seconds
 * @returns {{ status: string, startedAt?: number } | null}
 */
function lastTurnOf(turns, now = Date.now() / 1000) {
  const turn = Array.isArray(turns) ? turns.at(-1) : null;
  if (!TURN_STATUS.has(turn?.status)) return null;
  const current = turn.status === 'inProgress' || (Number.isFinite(turn.completedAt) && now - turn.completedAt <= RECENT_S);
  return {
    status: turn.status,
    ...(current && Number.isFinite(turn.startedAt) && turn.startedAt > 0 ? { startedAt: turn.startedAt } : {}),
  };
}

/** The chat's turn as a read says it: its state (running, waiting, idle) and its last history turn (left out when it has none). */
const turnState = (/** @type {string | undefined} */ turn, /** @type {any[]} */ turns) => {
  const last = lastTurnOf(turns);
  return { state: stateOf(turn), ...(last ? { turn: last } : {}) };
};

module.exports = {
  turnState,
  lastTurnOf,
  liveOf,
  PanelWatch,
  rowsOf,
  withoutPictureOnlyRows,
  recentRowsOf,
  olderRowsOf,
  pageOfRows,
  allRowsOf,
  stepOf,
  WATCH_MS,
  CHANGED_MS,
  MAX_ROWS,
  MAX_TOTAL,
  MAX_COMMAND,
};
