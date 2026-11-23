// Notifications held through the Mac's quiet hours (prefs.notifyQuietHours): a banner that would show in the window is kept back, and when the window ends the "needs you" among them are said once, as one fixed-title push (electron/remote/pushBridge.cjs catchUp). What waits is only chat ids, kinds and times, saved so a restart or a Mac that slept through the window still says it once; MoMo keeps its own quiet hours (electron/momo/notices.cjs).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');
const { writePrivate } = require('./fsutil.cjs');
const { mkdirPrivate } = require('./privateFiles.cjs');
const { parseClock, inQuietHours } = require('../../shared/momoRoutine.mjs');

/** How often what is held checks whether the window ended (a wall-clock comparison, so a Mac that slept is caught up at the first check after waking). */
const CHECK_MS = 60_000;
/** Chats held: the oldest goes past this many. */
const KEEP = 200;
/** A "needs you" older than this is not said any more (the person has long since seen it, or it no longer stands). */
const STALE_MS = 24 * 60 * 60_000;

/** The quiet hours as minutes after midnight, or null for none or anything that is not two different "HH:MM" times. @returns {{ start: number, end: number } | null} */
function quietWindow(/** @type {any} */ v) {
  const start = parseClock(v?.start);
  const end = parseClock(v?.end);
  return start === null || end === null || start === end ? null : { start, end };
}

/**
 * @param {object} o
 * @param {() => unknown} o.quietHours the setting, as saved ({ start: "22:00", end: "07:00" } or null)
 * @param {(held: { chatId: string, at: number, count: number }) => Promise<boolean> | boolean} o.deliver says the newest held chat (held at `at`) needs the person; true once it is said to everyone (or there is no one to say it to), false to try again
 * @param {string} o.file where what is held is kept
 * @param {(kind: string) => boolean} [o.still] whether a held kind may still be said (the Notifications mode and switches as they are now, not as they were when it was held)
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => unknown} [o.schedule]
 * @param {(timer: any) => void} [o.cancel]
 */
function createQuietHold({
  quietHours,
  deliver,
  file,
  still = () => true,
  now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms).unref(),
  cancel = clearTimeout,
}) {
  /** @type {Map<string, { at: number, kind: string }>} the chats that need the person, with when and why, oldest first */
  const held = new Map();
  /** @type {unknown} */
  let timer = null;
  let delivering = false;

  const quiet = () => inQuietHours(quietWindow(quietHours()), now());
  const save = () => {
    try {
      mkdirPrivate(path.dirname(file));
      writePrivate(file, JSON.stringify({ held: [...held].map(([chatId, e]) => ({ chatId, ...e })) }));
    } catch (error) {
      noteIgnored('save the notifications held through quiet hours', error);
    }
  };
  const arm = () => {
    if (held.size && timer === null) timer = schedule(check, CHECK_MS);
  };
  const disarm = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };

  async function check() {
    timer = null;
    let changed = false;
    for (const [chatId, e] of held) {
      // too old, or its kind no longer notifies (the mode or a switch changed while it waited)
      if (now() - e.at > STALE_MS || !still(e.kind)) {
        held.delete(chatId);
        changed = true;
      }
    }
    if (changed) save();
    if (!held.size || delivering || quiet()) return arm();
    const sent = [...held];
    const [chatId, newest] = /** @type {[string, { at: number, kind: string }]} */ (sent.at(-1));
    delivering = true;
    let said = false;
    try {
      said = (await deliver({ chatId, at: newest.at, count: sent.length })) === true;
    } catch (error) {
      noteIgnored('say the notifications held through quiet hours', error);
    }
    delivering = false;
    if (said) {
      // what came in while it was being said (a new window can have begun) stays, even for the same chat
      for (const [id, e] of sent) if (held.get(id)?.at === e.at) held.delete(id);
      save();
    }
    arm();
  }

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of Array.isArray(saved?.held) ? saved.held : []) {
      if (typeof e?.chatId !== 'string' || !e.chatId || !Number.isFinite(e.at)) continue;
      // a time in the future (a clock set back) counts from now, so it still goes stale
      held.set(e.chatId, { at: Math.min(e.at, now()), kind: typeof e.kind === 'string' ? e.kind : 'approval' });
    }
  } catch (error) {
    noteIgnored('read the notifications held through quiet hours', error, ['ENOENT']);
  }
  arm();

  return {
    /**
     * Whether the banner for this chat is kept back: it is quiet now. A "needs you" waits for the end; the rest are not said later.
     * @param {string} chatId
     * @param {boolean} needs
     * @param {string} [kind] the notification kind (approval, auth, goal)
     */
    hold(chatId, needs, kind = 'approval') {
      if (!quiet()) return false;
      if (needs) {
        held.delete(chatId);
        held.set(chatId, { at: now(), kind });
        if (held.size > KEEP) held.delete(/** @type {string} */ (held.keys().next().value));
        save();
        arm();
      }
      return true;
    },
    /** The chat's approval was answered: nothing is left to say. */
    retract(/** @type {string} */ chatId) {
      if (!held.delete(chatId)) return;
      if (!held.size) disarm();
      save();
    },
    /** Looks at the clock now: the Mac woke, or the setting changed. */
    check() {
      disarm();
      return check();
    },
    /** How many chats wait. */
    get size() {
      return held.size;
    },
  };
}

module.exports = { createQuietHold, quietWindow, CHECK_MS, STALE_MS, KEEP };
