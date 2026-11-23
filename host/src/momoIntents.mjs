// A notification's own buttons on a Host (S7, design Function 3): "Draft a reply", "Remind me at 4" and "Not needed" arrive as typed intents on a key this home issued, are fenced to the running home, do their work once per notification however many taps, devices or restarts there are, and clear the notification on every device.
import os from 'node:os';
import { HostRefusal } from './hostFs.mjs';
import { nextWallTime, hostZone } from './momoClock.mjs';

const DAY = 24 * 60 * 60_000;
/** "Remind me at 4": 16:00 on the owner's clock. */
export const REMIND_AT_MIN = 16 * 60;
/** The furthest ahead a reminder may be set. */
export const MAX_REMIND_MS = 30 * DAY;

/**
 * @param {object} o
 * @param {{ stamp: () => unknown }} o.home the running home, or none
 * @param {{ knows: (key: string) => boolean, intentDone: (key: string) => boolean, markIntent: (key: string, on: boolean) => Promise<unknown>, answered: (key: string, how?: { by: 'card' | 'button' }) => Promise<number> }} o.push
 * @param {{ draft?: (a: Intent) => unknown, remind?: (a: Intent) => unknown, dismiss?: (a: Intent) => unknown }} [o.handlers] what the notice lane does with each answer; one not given is refused honestly
 * @param {() => string} [o.zone] the clock "at 4" is read on
 * @param {() => string} [o.machine] this machine's name, for what a refusal says of it
 * @param {() => number} [o.now]
 * @typedef {{ key: string, action: 'draft' | 'remind' | 'dismiss', at?: number, stamp: unknown }} Intent
 */
export function createMomoIntents({ home, push, handlers = {}, zone = hostZone, machine = os.hostname, now = Date.now }) {
  /** @type {Map<string, Promise<unknown>>} */
  const running = new Map();
  /** @type {{ draft?: (a: Intent) => unknown, remind?: (a: Intent) => unknown, dismiss?: (a: Intent) => unknown }} */
  const wired = { ...handlers };

  return {
    /** The notice lane gives what each answer does (once it exists on this Host). @param {typeof wired} next */
    setHandlers(next) {
      Object.assign(wired, next);
    },
    /**
     * @param {{ key: string, action: 'draft' | 'remind' | 'dismiss', at?: number }} p
     * @returns {Promise<{ ok: true, action: string, at?: number, duplicate?: boolean }>}
     */
    async apply(p) {
      const stamp = home.stamp();
      if (!stamp) throw new HostRefusal('momo_home_away', `MoMo's home is not running on ${machine()}.`);
      const handler = wired[p.action];
      if (!handler) throw new HostRefusal('momo_intent_unavailable', `MoMo on ${machine()} can't do that from a notification yet.`);
      // only a notification this home sent can be answered: a key made up by a client is refused
      if (!push.knows(p.key)) throw new HostRefusal('momo_unknown_notification', `That notification is not one MoMo on ${machine()} sent.`);
      // one answer per notification, whatever the action, device or restart: a second tap is acknowledged and nothing runs
      const same = running.get(p.key);
      if (same) {
        await same;
        return { ok: true, action: p.action, duplicate: true };
      }
      if (push.intentDone(p.key)) return { ok: true, action: p.action, duplicate: true };
      let at = p.at;
      if (p.action === 'remind') {
        // "at 4" is the next 4 PM and always ahead; a time a client names must be ahead and not further than a month
        at ??= nextWallTime(REMIND_AT_MIN, now(), zone());
        if (at <= now() || at > now() + MAX_REMIND_MS) throw new HostRefusal('momo_bad_time', 'That is not a time MoMo can remind you at.');
      }
      await push.markIntent(p.key, true);
      const run = Promise.resolve().then(() => handler({ key: p.key, action: p.action, ...(at ? { at } : {}), stamp }));
      running.set(p.key, run);
      try {
        await run;
      } catch (error) {
        // the answer did not happen: the notification can be answered again
        await push.markIntent(p.key, false);
        throw error;
      } finally {
        running.delete(p.key);
      }
      await push.answered(p.key, { by: 'button' });
      return { ok: true, action: p.action, ...(at ? { at } : {}) };
    },
  };
}
