// What the Mac tells the relay for a phone's Live Activity: a snapshot of its chats as counts (waiting for the user, running), the kind of the newest event, when the longest-busy chat began and up to three rows (a kind, a start time, an opaque chat handle and, only when chat titles in push are on, the title sealed for that phone). It follows the session store's turn changes on every harness, waits a moment so a burst is one message, sends a pair only what changed, repeats it now and then while chats are busy (the relay forgets a quiet Mac after 30 minutes, and the phone then shows "Computer offline"), and ends with an empty snapshot when nothing runs or waits any more.
'use strict';
const { noteIgnored } = require('../ignored.cjs');
const { chatRef } = require('../../shared/remote/ref.mjs');
const { ACTIVITY_MAX_ROWS } = require('../../shared/remote/activity.mjs');

/** How long a change waits for the next before it is sent: a chat starting and the next one starting are one message. */
const DELAY_MS = 3000;
/** While chats are busy the snapshot is sent again this often even if nothing changed. */
const HEARTBEAT_MS = 10 * 60_000;
/** How long a failed send, or a title still waiting for its key, waits for another try. */
const RETRY_MS = 30_000;

/**
 * @param {object} o
 * @param {{ all(): string[], get(chatId: string): { turn?: string } } | null} o.state the session store: one turn per chat, on every harness (none: nothing is busy)
 * @param {(chatId: string) => boolean} o.owns whether the chat is one a phone lists (MoMo's own chats and unknown ones are not)
 * @param {(chatId: string) => string | null} o.titleOf
 * @param {() => ({ devices: { list(): { pairId: string }[] } | null, pushTitles?: { enabled?: boolean, seal(pair: string, ref: string, title: string): string | null } | null, activityUpdate(req: { pair: string, state: object }): Promise<string> }) | null | undefined} o.remote the live Mobile Remote
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => unknown} [o.setTimer]
 * @param {(timer: unknown) => void} [o.clearTimer]
 */
function createActivityBridge({
  state,
  owns,
  titleOf,
  remote,
  now = Date.now,
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (t) => clearTimeout(/** @type {any} */ (t)),
}) {
  /** @type {Map<string, { kind: 'needs' | 'running', since: number }>} the busy chats */
  const busy = new Map();
  /** @type {{ kind: 'needs' | 'running' | 'done', at: number } | null} the newest event */
  let last = null;
  /** @type {Map<string, string>} per pair, what the relay was last told (without the event time) */
  const told = new Map();
  /** @type {unknown} */
  let wait = null;
  /** @type {{ beat: unknown, retry: unknown }} the repeat while busy, and the new try after a failure */
  const timers = { beat: null, retry: null };
  /** @type {Map<string, number>} per pair, the newest send's number */
  const sequence = new Map();
  /** Bumped when Mobile Remote stops, so an answer to an earlier connection's send is not taken as the next one's. */
  let epoch = 0;
  /** After a new connection the next flush also ends pairs that show nothing here. */
  let announceEmpty = false;
  const seconds = () => Math.floor(now() / 1000);

  /** Reads the store: which chats are busy now, since when, and what happened since the last read. */
  function scan() {
    const at = seconds();
    const live = new Map();
    for (const id of state?.all() ?? []) {
      const turn = state?.get(id)?.turn;
      if (turn !== 'running' && turn !== 'awaitingUser') continue;
      if (!owns(id)) continue;
      live.set(id, turn === 'awaitingUser' ? 'needs' : 'running');
    }
    for (const [id, kind] of live) {
      const was = busy.get(id);
      if (!was) last = { kind, at };
      else if (was.kind !== kind) last = { kind, at };
      busy.set(id, { kind, since: was?.since ?? at });
    }
    for (const id of [...busy.keys()]) {
      if (live.has(id)) continue;
      busy.delete(id);
      last = { kind: 'done', at };
    }
  }

  /** @param {string} pair */
  function snapshot(pair) {
    const entries = [...busy].sort(([, a], [, b]) => (a.kind === b.kind ? a.since - b.since : a.kind === 'needs' ? -1 : 1));
    const needs = entries.filter(([, e]) => e.kind === 'needs').length;
    const running = entries.length - needs;
    /** rows of chats that have a title the push titles could not seal (yet) */
    let unsealed = 0;
    const rows = entries.slice(0, ACTIVITY_MAX_ROWS).map(([id, e]) => {
      const ref = chatRef(pair, id);
      const title = titleOf(id);
      const sealed = title ? (remote()?.pushTitles?.seal(pair, ref, title) ?? null) : null;
      if (title && !sealed) unsealed++;
      return { kind: e.kind, since: e.since, ref, ...(sealed && { st: sealed }) };
    });
    const state = {
      needs,
      running,
      kind: last?.kind ?? 'done',
      since: entries.length ? Math.min(...entries.map(([, e]) => e.since)) : 0,
      at: last?.at ?? seconds(),
      rows,
    };
    return { state, unsealed };
  }

  /** The comparison key of a snapshot: the event time and the sealed bytes (fresh random ones every time) left out, whether a title is there kept. */
  const keyOf = (/** @type {ReturnType<typeof snapshot>['state']} */ next) =>
    JSON.stringify({ ...next, at: 0, rows: next.rows.map(({ st, ...row }) => ({ ...row, titled: !!st })) });

  /** Runs `fn` again after `ms` unless it is already waiting. */
  function later(/** @type {'beat' | 'retry'} */ name, /** @type {number} */ ms, /** @type {() => void} */ fn) {
    if (timers[name]) return;
    timers[name] = setTimer(() => {
      timers[name] = null;
      fn();
    }, ms);
  }

  function flush() {
    wait = null;
    try {
      send();
    } catch (error) {
      // a title lookup, a seal or the device list failing must not take the timer's callback down with it
      noteIgnored('prepare a Live Activity update', error);
      later('retry', RETRY_MS, flush);
    }
  }

  function send() {
    const live = remote();
    if (!live?.devices) return;
    scan();
    const pairs = [...new Set(live.devices.list().map((d) => d.pairId))].filter(Boolean);
    for (const known of [...told.keys()]) if (!pairs.includes(known)) told.delete(known);
    const closing = announceEmpty;
    announceEmpty = false;
    let working = false;
    let waitingForKey = false;
    for (const pair of pairs) {
      const { state: next, unsealed } = snapshot(pair);
      const empty = next.needs + next.running === 0;
      if (!empty) working = true;
      // a title whose key the phone has not been handed yet is sent without it and again when the key is there
      if (unsealed) waitingForKey = true;
      // nothing was shown and nothing is: there is nothing to end (after a new connection the relay may still hold what it was told before, so that once it is ended)
      if (empty && !told.has(pair) && !closing) continue;
      const key = keyOf(next);
      if (told.get(pair) === key) continue;
      const mine = (sequence.get(pair) ?? 0) + 1;
      sequence.set(pair, mine);
      const era = epoch;
      live.activityUpdate({ pair, state: next }).then(
        (status) => {
          // only the newest send of a pair records what the relay holds, and only if the connection is the same one; a failure is left unrecorded and tried again
          if (era !== epoch || sequence.get(pair) !== mine) return;
          if (status === 'failed') later('retry', RETRY_MS, flush);
          else told.set(pair, key);
        },
        (error) => {
          noteIgnored('send a Live Activity update to the relay', error);
          if (era === epoch && sequence.get(pair) === mine) later('retry', RETRY_MS, flush);
        },
      );
    }
    if (working) later('beat', HEARTBEAT_MS, () => (told.clear(), flush()));
    else if (timers.beat) clearTimer(timers.beat), (timers.beat = null);
    if (waitingForKey && live.pushTitles?.enabled === true) later('retry', RETRY_MS, flush);
  }

  return {
    /** A chat's turn changed (or a pair was added): sends after a short wait, once for a burst. */
    changed() {
      if (wait) return;
      wait = setTimer(flush, DELAY_MS);
    },
    /** The relay connection is new (it may have lost what it held, even about chats that have ended): everything is sent again, now. */
    resend() {
      told.clear();
      announceEmpty = true;
      if (wait) clearTimer(wait);
      flush();
    },
    /** Mobile Remote stopped: what the relay was told is no longer true of the next connection, and an answer still on its way is not recorded. */
    reset() {
      epoch++;
      told.clear();
      sequence.clear();
      if (wait) clearTimer(wait);
      for (const name of /** @type {const} */ (['beat', 'retry'])) {
        if (timers[name]) clearTimer(timers[name]);
        timers[name] = null;
      }
      wait = null;
    },
  };
}

module.exports = { createActivityBridge, DELAY_MS, HEARTBEAT_MS, RETRY_MS };
