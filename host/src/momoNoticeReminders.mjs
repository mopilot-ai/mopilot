// "Remind me later" on a notice (the notice lane's `notice.remind`, from the notification's own button): one reminder is set on a live matter only when it can fire, it is told once through MoMo's push as its own kind (so it never uses the daily tell-now cap), a matter may be reminded at most MAX_REMINDERS times, and a reminder that could not be sent is tried a few times and then given up with its cause. Every change to a matter is made atomically on the record as it is then (a Dismiss during a push is never overwritten).
import { IntentError } from '../../shared/momoHomeApi.mjs';

export const REMIND_AFTER_MS = 3 * 3_600_000;
export const MAX_REMINDERS = 3;
/** How many times a reminder that could not be sent is tried before it is given up. */
export const MAX_SEND_TRIES = 3;
const LIVE = new Set(['open', 'offered', 'watching']);

/** What a push status that did not reach the phone means, in words. @param {string} status */
const WHY = (status) =>
  status === 'duplicate'
    ? 'this reminder was already sent'
    : status === 'off'
      ? 'push notifications are off'
      : status === 'no_phone'
        ? 'no phone is linked'
        : status === 'not-home'
          ? 'this machine is not where MoMo runs now'
          : 'the push did not go out';

/**
 * @param {object} o
 * @param {{ notice: { getMatter: (key: string) => Promise<any>, listMatters: () => Promise<any[]>, updateMatter: (key: string, fn: (current: any) => any) => Promise<boolean> } }} o.store
 * @param {() => number} o.now
 * @param {() => { tell: (item: { kind: string, key: string, text?: string }) => Promise<{ status: string }> } | undefined} o.push
 * @param {() => string | null} o.cannotFire why a reminder could not be told right now (notices off or brief-only, no push), or null
 */
export function createReminders({ store, now, push, cannotFire }) {
  return {
    /** Sets the reminder for a matter MoMo still has, if it can fire; a second tap while one is waiting changes nothing. @param {unknown} key @returns {Promise<{ remindAt: string }>} */
    async remind(key) {
      const matter = typeof key === 'string' && key !== '' ? await store.notice.getMatter(key) : null;
      if (!matter || !LIVE.has(matter.state)) throw new IntentError('MoMo no longer has that notice.');
      const why = cannotFire();
      if (why) throw new IntentError(why);
      const remindAt = new Date(now() + REMIND_AFTER_MS).toISOString();
      /** @type {'set' | 'waiting' | 'gone' | 'full'} */
      let result = 'gone';
      let waitingAt = remindAt;
      await store.notice.updateMatter(/** @type {string} */ (key), (current) => {
        if (!current || !LIVE.has(current.state)) return undefined;
        if (current.remindAt) return void ((result = 'waiting'), (waitingAt = current.remindAt));
        if ((current.reminded ?? 0) >= MAX_REMINDERS) return void (result = 'full');
        result = 'set';
        return { ...current, remindAt, reminded: (current.reminded ?? 0) + 1, remindTries: 0 };
      });
      if (result === 'gone') throw new IntentError('MoMo no longer has that notice.');
      if (result === 'full') throw new IntentError('MoMo already reminded you about this three times.');
      return { remindAt: waitingAt };
    },
    /**
     * Tells the reminders that are due, once each. A reminder is taken off its matter first, atomically, then told; a push that did not go out puts it back (a few times, then it is given up and said so), and a matter that was dismissed, resolved or snoozed meanwhile is left as it is.
     * @param {{ stillHome: () => Promise<boolean> }} how
     * @returns {Promise<{ told: string[], gaveUp: { key: string, title: string, why: string }[] }>}
     */
    async fire({ stillHome }) {
      /** @type {string[]} */
      const told = [];
      /** @type {{ key: string, title: string, why: string }[]} */
      const gaveUp = [];
      const sender = push();
      if (!sender || cannotFire()) return { told, gaveUp };
      for (const seen of await store.notice.listMatters()) {
        if (!seen.remindAt || Date.parse(seen.remindAt) > now()) continue;
        if (!(await stillHome())) break;
        /** @type {any} */
        let taken = null;
        await store.notice.updateMatter(seen.matterKey, (current) => {
          if (!current?.remindAt || Date.parse(current.remindAt) > now()) return undefined;
          // over: nothing to remind about; snoozed: it is told when the snooze ends
          if (!LIVE.has(current.state)) return { ...current, remindAt: undefined };
          if (current.snoozedUntil && Date.parse(current.snoozedUntil) > now()) return undefined;
          taken = current;
          const { remindAt: _taken, ...rest } = current;
          return rest;
        });
        if (!taken) continue;
        const out = await sender.tell({ kind: 'remind', key: `remind:${taken.matterKey}:${taken.reminded}`, text: taken.title });
        if (out.status === 'sent' || out.status === 'held') {
          told.push(taken.matterKey);
          continue;
        }
        const tries = (taken.remindTries ?? 0) + 1;
        const giveUp = tries >= MAX_SEND_TRIES;
        await store.notice.updateMatter(taken.matterKey, (current) =>
          !current || !LIVE.has(current.state) || current.remindAt
            ? undefined
            : giveUp
              ? { ...current, remindTries: tries }
              : { ...current, remindAt: taken.remindAt, remindTries: tries },
        );
        if (giveUp) gaveUp.push({ key: taken.matterKey, title: taken.title, why: WHY(out.status) });
      }
      return { told, gaveUp };
    },
  };
}
