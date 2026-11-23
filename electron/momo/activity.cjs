// MoMo's activity (a phone's Activity list, momo.activity.list): its routine runs and its errands (turns of its own chats that used the browser or the computer), each with its steps, newest first and bounded; and which items changed once a chat it watches moved, so phones re-fetch them. It reads, never writes, so it answers while MoMo is paused.
const { parseUserText } = require('../../shared/userText.mjs');
const { userMessageText } = require('./turnItems.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { prefixUnits } = require('../../shared/textPrefix.mjs');

/** At most this many items, and none started before KEEP_MS ago. */
const MAX_ITEMS = 50;
const KEEP_MS = 7 * 86_400_000;
/** An item's newest steps, at most this many. */
const MAX_STEPS = 20;
const MAX_TITLE = 120;
const MAX_STEP = 160;
/** MoMo's own chats whose turns are read for errands: the ones written to most recently. */
const MAX_ERRAND_CHATS = 20;
/** A chat that moved is compared again at most this often, so a busy turn tells phones once in a while, not on every step. */
const CHANGE_MS = 3000;
/** A chat's items are read again after this long even when nothing main holds changed: a harness may write its history after the turn's last patch. */
const CACHE_MS = 30_000;
/** Histories read at once for a list. */
const READ_AT_ONCE = 8;

/** @typedef {'running' | 'needs-you' | 'done' | 'failed'} ActivityState */
/** @typedef {{ text: string, state: 'running' | 'done' | 'failed', at: number }} ActivityStep */
/** @typedef {{ id: string, kind: 'routine' | 'errand', title: string, state: ActivityState, chatId: string, startedAt: number, steps: ActivityStep[] }} ActivityItem */
/** @typedef {{ chatId: string, taskId: string, startedAt: number, endedAt?: number, outcome?: string }} RunRecord */

/** One line, cut to `n` characters. */
const clip = (/** @type {string} */ t, /** @type {number} */ n) => {
  const s = String(t).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${prefixUnits(s, n - 1)}…` : s;
};

/** A turn's start (unix seconds in history) in ms, or `fallback`. */
const startOf = (/** @type {any} */ turn, /** @type {number} */ fallback) =>
  Number.isFinite(turn?.startedAt) && turn.startedAt > 0 ? Math.round(turn.startedAt * 1000) : fallback;

/** Whether a history item is a call of a browser or computer tool, whichever harness wrote its name. */
function isControlCall(/** @type {any} */ item) {
  if (item?.type !== 'mcpToolCall' && item?.type !== 'dynamicToolCall') return false;
  return /browser|chrome|desktop|computer/i.test(`${item.server ?? ''}/${item.tool ?? ''}`);
}

/** What the user (or MoMo, for an input it authored) asked in a turn, as the chat shows it; '' when it has none. */
function askOf(/** @type {any} */ turn) {
  const item = turn.items.find((/** @type {any} */ i) => i?.type === 'userMessage');
  const raw = userMessageText(item);
  return raw ? clip(parseUserText(raw).text, MAX_TITLE) : '';
}

/**
 * Where a chat's turn is now, from the state main holds: waiting on the user, running, or neither (idle, or its harness quit).
 * @returns {ActivityState | null}
 */
function liveOf(/** @type {any} */ s) {
  if (!s) return null;
  const pending = (s.approvals?.length ?? 0) > 0 || !!s.questions?.some((/** @type {any} */ q) => q?.status === 'pending');
  if (s.turn === 'awaitingUser' || (s.turn === 'running' && pending)) return 'needs-you';
  return s.turn === 'running' ? 'running' : null;
}

/**
 * @param {object} o
 * @param {(since: number) => RunRecord[]} o.runs MoMo's routine runs started since then (RoutineStore.routineRunsSince)
 * @param {(taskId: string) => string | null} o.routineName the routine's name, or null once it was removed
 * @param {(since: number) => { chatId: string, updatedAt: number }[]} o.chats MoMo's own chats that may hold errands (not its data-only ones), written to since then
 * @param {(chatId: string, running: boolean) => Promise<any[]>} o.turns the chat's history turns (`running`: main runs its turn now)
 * @param {(chatId: string) => any} o.chatState the chat's session state main holds, or null
 * @param {(chatId: string) => string} o.version changes whenever the chat's history may have (its revision)
 * @param {(item: any, ended: boolean) => string | null} o.stepOf a history item as one step line, or null when it is no step
 * @param {(item: any, ended: boolean) => 'running' | 'done' | 'failed'} o.stateOfCall how far a step got
 * @param {(id: string) => void} o.changed tells phones the item with this id changed (or appeared, or went)
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => unknown} [o.schedule]
 */
function createMomoActivity({
  runs,
  routineName,
  chats,
  turns,
  chatState,
  version,
  stepOf,
  stateOfCall,
  changed,
  now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms).unref(),
}) {
  /** @type {Map<string, { key: string, at: number, items: ActivityItem[] }>} each chat's items, as last read */
  const cache = new Map();
  /** @type {Map<string, Map<string, string>>} each chat's items as phones last heard of them, by id */
  const told = new Map();
  /** @type {Set<string>} chats a comparison is waiting for */
  const due = new Set();

  /** A chat's steps, the newest MAX_STEPS. `ended`: no call of it still runs (the chat is idle, or its run is over). */
  function stepsOf(/** @type {any[]} */ list, /** @type {boolean} */ ended, /** @type {number} */ fallback) {
    /** @type {ActivityStep[]} */
    const steps = [];
    for (const [i, turn] of list.entries()) {
      const over = ended || i < list.length - 1 || turn?.status === 'failed' || turn?.status === 'interrupted';
      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        const text = item && typeof item === 'object' ? stepOf(item, over) : null;
        if (text) steps.push({ text: clip(text, MAX_STEP), state: stateOfCall(item, over), at: startOf(turn, fallback) });
      }
    }
    return steps.slice(-MAX_STEPS);
  }

  /** A routine run as one item: its chat's every step. */
  function routineItem(/** @type {RunRecord} */ run, /** @type {any[]} */ list, /** @type {ActivityState | null} */ live) {
    const open = run.endedAt === undefined;
    /** @type {ActivityState} */
    const state = open ? (live ?? 'running') : run.outcome === 'completed' ? 'done' : 'failed';
    return {
      id: `routine:${run.chatId}`,
      kind: /** @type {const} */ ('routine'),
      title: clip(routineName(run.taskId) || 'Routine', MAX_TITLE),
      state,
      chatId: run.chatId,
      startedAt: run.startedAt,
      steps: stepsOf(list, !open || !live, run.startedAt),
    };
  }

  /** A chat's errands: each turn that called a browser or computer tool, with that turn's steps. */
  function errandItems(/** @type {string} */ chatId, /** @type {any[]} */ list, /** @type {any} */ s, /** @type {number} */ updatedAt) {
    const live = liveOf(s);
    /** @type {ActivityItem[]} */
    const items = [];
    for (const [i, turn] of list.entries()) {
      if (!(Array.isArray(turn?.items) && turn.items.some(isControlCall))) continue;
      const last = i === list.length - 1;
      /** @type {ActivityState} */
      let state = 'done';
      if (last && live) state = live;
      else if (turn.status === 'failed' || turn.status === 'interrupted' || (last && s?.turn === 'crashed')) state = 'failed';
      const startedAt = startOf(turn, updatedAt);
      items.push({
        // its start names it: a running turn's id can differ from the one its saved history gives it once it ends (Claude Code)
        id: `errand:${chatId}:${Number.isFinite(turn.startedAt) && turn.startedAt > 0 ? `t${startedAt}` : typeof turn.id === 'string' && turn.id ? turn.id : i}`,
        kind: /** @type {const} */ ('errand'),
        title: askOf(turn) || 'Errand',
        state,
        chatId,
        startedAt,
        steps: stepsOf([turn], !(last && live), startedAt),
      });
    }
    return items;
  }

  /** A chat's items, read again only once its history, its run or its live state changed. */
  async function itemsOf(/** @type {{ chatId: string, run?: RunRecord, updatedAt?: number }} */ c) {
    const s = chatState(c.chatId);
    const live = liveOf(s);
    const key = JSON.stringify([version(c.chatId), live, s?.turn ?? null, c.run?.endedAt ?? null, c.run?.outcome ?? null]);
    const hit = cache.get(c.chatId);
    if (hit?.key === key && now() - hit.at < CACHE_MS) return hit.items;
    let list = [];
    try {
      list = await turns(c.chatId, live !== null);
    } catch (error) {
      // a chat whose history can't be read (deleted, its harness gone) still lists, with no steps
      noteIgnored("read a MoMo chat's history for its activity", error);
    }
    const items = c.run ? [routineItem(c.run, list, live)] : errandItems(c.chatId, list, s, /** @type {number} */ (c.updatedAt));
    cache.set(c.chatId, { key, at: now(), items });
    return items;
  }

  /** The chats the list is read from: each routine run's, and MoMo's own chats (the ones written to last). */
  function sources(/** @type {number} */ since) {
    const recorded = runs(since);
    const runChats = new Set(recorded.map((r) => r.chatId));
    const own = chats(since)
      .filter((c) => !runChats.has(c.chatId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ERRAND_CHATS);
    return { recorded, own };
  }

  /** Remembers what phones now know of a chat's items. */
  const remember = (/** @type {string} */ chatId, /** @type {ActivityItem[]} */ items) =>
    told.set(chatId, new Map(items.map((i) => [i.id, JSON.stringify(i)])));

  /** Compares a chat's items with what phones last heard, and tells them each one that changed, appeared or went. */
  async function compare(/** @type {string} */ chatId) {
    const since = now() - KEEP_MS;
    const { recorded, own } = sources(since);
    const run = recorded.find((r) => r.chatId === chatId);
    const mine = own.find((c) => c.chatId === chatId);
    const items = run || mine ? (await itemsOf(run ? { chatId, run } : /** @type {any} */ (mine))).filter((i) => i.startedAt >= since) : [];
    const before = told.get(chatId) ?? new Map();
    remember(chatId, items);
    const after = /** @type {Map<string, string>} */ (told.get(chatId));
    for (const id of new Set([...before.keys(), ...after.keys()])) if (before.get(id) !== after.get(id)) changed(id);
    if (!items.length) {
      told.delete(chatId);
      cache.delete(chatId);
    }
  }

  return {
    /** The newest MAX_ITEMS items of the last KEEP_MS, newest first. */
    async list() {
      const since = now() - KEEP_MS;
      const { recorded, own } = sources(since);
      /** @type {ActivityItem[]} */
      const items = [];
      for (const list of await Promise.all(own.map((c) => itemsOf(c)))) items.push(...list);
      // a run is one item: only the newest MAX_ITEMS runs can make the list, read a few at a time
      const newest = [...recorded].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_ITEMS);
      for (let i = 0; i < newest.length; i += READ_AT_ONCE)
        for (const list of await Promise.all(newest.slice(i, i + READ_AT_ONCE).map((run) => itemsOf({ chatId: run.chatId, run }))))
          items.push(...list);
      const kept = items.filter((i) => i.startedAt >= since).sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1));
      const shown = kept.slice(0, MAX_ITEMS);
      // what phones now know, so a later change is told against it; chats no longer read are forgotten
      const listed = new Set([...recorded.map((r) => r.chatId), ...own.map((c) => c.chatId)]);
      for (const id of cache.keys()) if (!listed.has(id)) cache.delete(id);
      const byChat = new Map();
      for (const i of kept) byChat.set(i.chatId, [...(byChat.get(i.chatId) ?? []), i]);
      for (const [chatId, list] of byChat) remember(chatId, list);
      return { items: shown };
    },
    /** A chat MoMo works in moved (a turn started, a step, a card, its end): its items are compared once it has had a moment. */
    touched(/** @type {string} */ chatId) {
      if (typeof chatId !== 'string' || !chatId || due.has(chatId)) return;
      due.add(chatId);
      schedule(() => {
        due.delete(chatId);
        compare(chatId).catch((error) => noteIgnored("tell phones of MoMo's activity", error));
      }, CHANGE_MS);
    },
  };
}

module.exports = {
  createMomoActivity,
  isControlCall,
  liveOf,
  MAX_ITEMS,
  KEEP_MS,
  MAX_STEPS,
  MAX_TITLE,
  MAX_STEP,
  MAX_ERRAND_CHATS,
  CHANGE_MS,
  CACHE_MS,
  READ_AT_ONCE,
};
