// Action-driven Host desktop frames: shared per-Host capture budget and Host+chat activity, never an input dependency or routing authority.
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { DESKTOP_READS, desktopCallAllowed } = require('../../shared/host/desktop.mjs');
const { noteIgnored } = require('../ignored.cjs');

/** At most four captures per second across every pane/chat on one Host, with one unresolved capture at a time. */
const ACTIVE_FRAME_MS = 250;
/** The next capture starts at least this many times the last capture's duration after it ended: a slow capture (a big desktop, a slow relay) backs the pane off instead of piling on the Host. */
const GAP_FACTOR = 3;
/** ...but never longer than the old watch cadence: one slow capture (the first one after a cold start took 2.6 s on a guest) must not leave the pane without frames for ten seconds. */
const GAP_MAX_MS = 3000;
/** What a pane frame asks of the Host (the model's own screenshots are untouched): a JPEG no wider than the cap, so a frame is tens of KB, not MB. */
const FRAME_QUALITY = 0.6;
const FRAME_MAX_SIDE = 1280;
const FRAME_PARAMS = Object.freeze({ format: 'jpeg', quality: FRAME_QUALITY, maxSide: FRAME_MAX_SIDE });
/** A capture that was overtaken (the Host reconnected, the pane moved on): not a failure to show; the poller takes the next frame soon. */
const STALE_FRAME = 'stale_frame';
/**
 * @param {{remoteOf: (hostId: string) => any, hostOf: (chatId: string) => string | null, now?: () => number, sleep?: (ms: number) => Promise<void>}} o
 */
function createDesktopFramePacing({ remoteOf, hostOf, now = performance.now.bind(performance), sleep = delay }) {
  /** @type {Map<string, {remote: any, generation: unknown, tail: Promise<unknown>, nextAt: number}>} */
  const slots = new Map();
  /** @type {Map<string, {hostId: string, chatId: string, count: number, epoch: number, listeners: Set<(active: boolean, refresh: boolean) => void>}>} */
  const groups = new Map();
  let disposed = false;
  const keyOf = (hostId, chatId) => JSON.stringify([hostId, chatId]);
  const groupOf = (hostId, chatId) => {
    const key = keyOf(hostId, chatId);
    if (!groups.has(key)) groups.set(key, { hostId, chatId, count: 0, epoch: 0, listeners: new Set() });
    return /** @type {NonNullable<ReturnType<typeof groups.get>>} */ (groups.get(key));
  };
  const publish = (group, refresh) => {
    for (const listener of group.listeners) {
      try {
        listener(group.count > 0, refresh);
      } catch (error) {
        noteIgnored('update action frame pacing', error);
      }
    }
    if (!group.count && !group.listeners.size) groups.delete(keyOf(group.hostId, group.chatId));
  };
  const retire = (matches, refresh) => {
    for (const group of groups.values())
      if (matches(group)) {
        group.epoch++;
        group.count = 0;
        publish(group, refresh);
      }
  };
  /** The Host's capture slot for this connection: a new connection starts a new one (the old one's captures are no longer current). */
  const slotOf = (hostId, remote, generation) => {
    let slot = slots.get(hostId);
    if (!slot || slot.remote !== remote || slot.generation !== generation) {
      slot = { remote, generation, tail: Promise.resolve(), nextAt: 0 };
      slots.set(hostId, slot);
    }
    return slot;
  };
  return {
    /** Capture only while this exact watch and connection still own the request. @param {string} hostId @param {string} chatId @param {() => boolean} valid */
    fetch(hostId, chatId, valid) {
      const remote = remoteOf(hostId);
      const generation = remote?.generation?.();
      const held = slotOf(hostId, remote, generation);
      const current = () => {
        if (
          disposed ||
          !valid() ||
          hostOf(chatId) !== hostId ||
          !remote ||
          remoteOf(hostId) !== remote ||
          remote.generation?.() !== generation ||
          slots.get(hostId) !== held
        )
          throw Object.assign(new Error('This desktop frame is no longer current.'), { code: STALE_FRAME });
      };
      const run = held.tail.then(async () => {
        current();
        // A timer can wake early; the monotonic deadline, not the number of wakes, owns the budget.
        while (now() < held.nextAt) {
          await sleep(held.nextAt - now());
          current();
        }
        current();
        const startedAt = now();
        try {
          const shot = await remote.command(chatId, 'screenshot', { ...FRAME_PARAMS });
          current();
          return shot;
        } finally {
          // the gap follows what the capture cost, so a slow one is not followed at once by another
          held.nextAt = now() + Math.min(GAP_MAX_MS, Math.max(ACTIVE_FRAME_MS, GAP_FACTOR * (now() - startedAt)));
        }
      });
      // Only the queue barrier consumes this typed outcome; the caller still receives run's rejection.
      held.tail = run.catch((error) => ({ ok: false, error }));
      return run;
    },
    /** @param {string} hostId @param {string} chatId @param {(active: boolean, refresh: boolean) => void} listener */
    subscribe(hostId, chatId, listener) {
      const group = groupOf(hostId, chatId);
      group.listeners.add(listener);
      publish(group, false);
      return () => {
        group.listeners.delete(listener);
        publish(group, false);
      };
    },
    /** @template T @param {string} hostId @param {string} chatId @param {string} method @param {() => Promise<T>} run */
    async around(hostId, chatId, method, run) {
      if (disposed || !desktopCallAllowed(method) || DESKTOP_READS.has(method) || method === 'input.release' || hostOf(chatId) !== hostId)
        return run();
      const group = groupOf(hostId, chatId);
      const epoch = group.epoch;
      group.count++;
      publish(group, true);
      try {
        return await run();
      } finally {
        if (group.epoch === epoch) {
          group.count--;
          publish(group, true);
        }
      }
    },
    retireChat: (chatId) => retire((g) => g.chatId === chatId, true),
    // the slot stays: a reconnect has a new generation (its old captures go stale by that), and a stack rebuild on a live connection must not let a second capture start beside the one outstanding
    retireHost(hostId) {
      retire((g) => g.hostId === hostId, false);
    },
    dispose() {
      disposed = true;
      slots.clear();
      retire(() => true, false);
      groups.clear();
    },
  };
}
module.exports = { createDesktopFramePacing, ACTIVE_FRAME_MS, GAP_FACTOR, GAP_MAX_MS, FRAME_PARAMS, STALE_FRAME };
