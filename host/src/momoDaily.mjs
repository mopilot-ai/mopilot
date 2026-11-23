// MoMo's day on its home (S6, design Function 3): the morning brief at the user's time, claimed once per day on the home and never twice across devices or restarts; one catch-up summary after the home slept; the 3:00 notes tidy only when something changed. Every action carries the home's lease epoch and is refused once the home has moved on. The builder, the wording pass, delivery and the tidy are injected (the notice lane owns what a brief says), so a Host without them does nothing.
import path from 'node:path';
import { createRequire } from 'node:module';
import { describeError } from '../../shared/userError.mjs';
import { clockMinutes, inQuiet, zonedParts, hostZone } from './momoClock.mjs';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../electron/gateway/sealedFile.cjs');

const MINUTE = 60_000;
/** A tick this much later than the last one means the Host slept (ticks are 30 s apart). */
export const SLEEP_GAP_MS = 10 * MINUTE;
/** How long after its time a brief may still start while the home is awake; later it is a missed brief, not a late one. */
export const BRIEF_WINDOW_MIN = 180;
/** Two briefs are never closer than this, whatever the zone or day key says (a trip to another zone must not give two in a morning). */
export const MIN_BRIEF_GAP_MS = 18 * 60 * MINUTE;
/** The notes tidy: from 3:00 for an hour on the user's clock. */
export const TIDY_AT_MIN = 3 * 60;
export const TIDY_WINDOW_MIN = 60;
/** Delivery tries of one brief before it is called failed (one a tick). */
export const MAX_TRIES = 5;
/** The ledger keeps this many days of claims. */
const KEEP_DAYS = 14;
/** Where the day's defaults come from (design D1). */
export const DEFAULTS = Object.freeze({ time: '08:00', quiet: Object.freeze({ start: 22 * 60, end: 8 * 60 }) });

/**
 * @typedef {object} DailySettings what the day runs on, read at every tick (so a change applies at once)
 * @property {boolean} on the brief switch
 * @property {boolean} [paused] MoMo is paused: nothing is sent
 * @property {string} [time] "HH:MM" on `zone`
 * @property {string} [zone] IANA zone; this Host's own when none
 * @property {{ start: number, end: number } | null} [quiet] minutes after midnight on `zone`; none means never quiet
 */
/**
 * @typedef {object} Stamp the home's lease the action was begun under
 * @property {string} homeId
 * @property {number} leaseEpoch
 */
/**
 * @typedef {object} BriefBuild what the builder (the notice lane) returns for a day
 * @property {string} text the deterministic brief
 */
/**
 * @typedef {object} DailySeams what the notice lane gives; none given, that part of the day does nothing
 * @property {(a: { day: string, since: number, until: number, zone: string, stamp: Stamp }) => Promise<BriefBuild | null> | BriefBuild | null} [build] null: nothing worth saying today, so nothing is sent
 * @property {(built: BriefBuild, a: { day: string }) => Promise<string | null | undefined> | string | null | undefined} [word] the one model pass for wording; its failure keeps the builder's text
 * @property {(a: { id: string, day: string, text: string, built: BriefBuild | null, stamp: Stamp }) => Promise<unknown> | unknown} [deliver] chat line and push; idempotent on `id`
 * @property {(a: { id: string, from: number, to: number, stamp: Stamp }) => Promise<unknown> | unknown} [catchUp] one summary card for the time the home was away; idempotent on `id`
 * @property {(a: { day: string, at: number }) => Promise<boolean> | boolean} [claimBrief] the notice store's own once-a-day claim, taken after this Host's
 * @property {() => boolean} [active] the person was active in the last seven days
 * @property {{ changedSince: (ms: number) => Promise<boolean> | boolean, run: (a: { stamp: Stamp }) => Promise<unknown> | unknown }} [tidy] the notes tidy
 */

/** @param {any} v */
const ledgerShape = (v) => {
  const rec = (/** @type {any} */ x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const days = Object.keys(rec(v?.briefs)).sort().slice(-KEEP_DAYS);
  const briefs = Object.fromEntries(days.map((d) => [d, v.briefs[d]]));
  const pending =
    v?.pending && Number.isFinite(v.pending.from) && Number.isFinite(v.pending.to) ? { from: v.pending.from, to: v.pending.to } : null;
  return {
    lastTickAt: Number.isFinite(v?.lastTickAt) ? v.lastTickAt : 0,
    lastBriefAt: Number.isFinite(v?.lastBriefAt) ? v.lastBriefAt : 0,
    // only a brief that went on its schedule counts for the gap between two: "Show it now" at 18:30 must not block tomorrow's
    lastScheduledAt: Number.isFinite(v?.lastScheduledAt) ? v.lastScheduledAt : 0,
    // catch-up cards by id (`catchup:<from>`): delivered ones are not delivered again, failing ones are given up after MAX_TRIES
    catchUps:
      v?.catchUps && typeof v.catchUps === 'object' && !Array.isArray(v.catchUps)
        ? Object.fromEntries(Object.entries(v.catchUps).slice(-KEEP_DAYS))
        : {},
    briefs,
    pending,
    tidy: { day: typeof v?.tidy?.day === 'string' ? v.tidy.day : '', at: Number.isFinite(v?.tidy?.at) ? v.tidy.at : 0 },
  };
};

/**
 * The settings of a day from MoMo's prefs (`prefs.momo`): the brief switch (off until the owner turns it on), its time and zone, and quiet hours, which default to 22:00-08:00 here.
 * @param {any} prefs
 * @returns {DailySettings}
 */
export function dailySettingsOf(prefs) {
  const momo = prefs?.momo ?? {};
  const brief = momo.brief ?? {};
  const q = momo.routines?.quietHours;
  /** @type {{ start: number, end: number } | null} */
  let quiet = { ...DEFAULTS.quiet };
  if (q === null) quiet = null;
  else if (q && typeof q === 'object') {
    const [start, end] = [clockMinutes(q.start), clockMinutes(q.end)];
    if (start !== null && end !== null) quiet = start === end ? null : { start, end };
  }
  return {
    on: brief.on === true,
    paused: momo.paused === true,
    time: clockMinutes(brief.time) === null ? DEFAULTS.time : brief.time,
    zone: typeof brief.zone === 'string' && brief.zone ? brief.zone : hostZone(),
    quiet,
  };
}

/** What the notice core's `NoticeSettings` (shared/momoNotice/types.ts) reads from this home, in its own names: the core reads nothing, so the Host builds them from the stored settings and passes them into every call. */
export const TRACK_RECHECK_MS = 24 * 60 * MINUTE;
export const CATCH_UP_GAP_MS = 2 * 60 * MINUTE;
/**
 * @param {any} prefs `prefs.momo` as the Host keeps it
 * @returns {{ timeZone: string, quietHours: { startMinute: number, endMinute: number } | null, dailyCap: number, trackRecheckMs: number, catchUpGapMs: number }}
 */
export function noticeSettingsOf(prefs) {
  const { quiet, zone } = dailySettingsOf(prefs);
  const cap = prefs?.momo?.notify?.tellNowMax;
  return {
    // the HOME's zone, never a device's: every device then claims the same day
    timeZone: /** @type {string} */ (zone),
    quietHours: quiet ? { startMinute: quiet.start, endMinute: quiet.end } : null,
    dailyCap: Number.isInteger(cap) && cap >= 1 ? cap : 6,
    trackRecheckMs: TRACK_RECHECK_MS,
    catchUpGapMs: CATCH_UP_GAP_MS,
  };
}

/**
 * @param {object} o
 * @param {{ stamp: () => Stamp | null, current: (s: unknown) => boolean, receiveStamp: (s: unknown) => { ok: boolean } | Promise<{ ok: boolean }>, data: { safeStorage: any }, storage: { dir: string } }} o.home
 * @param {() => DailySettings} o.settings
 * @param {DailySeams} [o.seams]
 * @param {() => number} [o.now]
 * @param {(message: string) => void} o.report
 */
export function createMomoDaily({ home, settings, seams = {}, now = Date.now, report }) {
  /** What the notice lane gives, set at the start or later (`setSeams`). @type {DailySeams} */
  const seamsRef = { ...seams };
  const ledger = new SealedJson({
    file: path.join(home.storage.dir, 'daily.json'),
    safeStorage: home.data.safeStorage,
    shape: ledgerShape,
    now,
  });
  /** The last tick this process saw, so a Host that slept is told from one that ticks on time without a write at every tick. */
  let lastSeen = 0;
  /** The days whose brief is being built or delivered now. @type {Set<string>} */
  const finishing = new Set();

  const read = () => {
    try {
      return ledger.read();
    } catch (error) {
      report(`MoMo's day record could not be read: ${describeError(error)}`);
      return null;
    }
  };
  /** An action may go on only while the stamp it began under is the home's current lease. @param {Stamp} stamp */
  const live = async (stamp) => {
    if (home.current(stamp) && (await home.receiveStamp(stamp)).ok) return true;
    report('MoMo: a scheduled action was refused because its home has moved on');
    return false;
  };
  /** @param {string} day @param {(rec: any) => void} fn */
  const mark = (day, fn) =>
    ledger.change((l) => void fn((l.briefs[day] ??= { state: 'claimed', at: now(), id: `brief:${day}`, tries: 0 })));

  /**
   * Build, word and deliver the day's claimed brief; what was built is kept before delivery, so a restart delivers the same text under the same id.
   * @param {string} day @param {Stamp} stamp @param {DailySettings} s
   */
  function finish(day, stamp, s, manual = false) {
    // one at a time per day: a tick that finds the day claimed while "Show it now" is building it builds nothing
    if (finishing.has(day)) return Promise.resolve('busy');
    finishing.add(day);
    return run(day, stamp, s, manual).finally(() => void finishing.delete(day));
  }

  /** @param {string} day @param {Stamp} stamp @param {DailySettings} s @param {boolean} manual */
  async function run(day, stamp, s, manual) {
    const rec = /** @type {any} */ (read()).briefs[day];
    if (!(await live(stamp))) return 'refused';
    try {
      /** @type {BriefBuild | null} */
      let built = null;
      if (typeof rec.text !== 'string') {
        const l = /** @type {NonNullable<ReturnType<typeof read>>} */ (read());
        built =
          (await seamsRef.build?.({
            day,
            since: l.lastBriefAt || now() - 24 * 60 * MINUTE,
            until: now(),
            zone: /** @type {string} */ (s.zone),
            stamp,
          })) ?? null;
        if (!built) {
          await mark(day, (r) => void (r.state = 'quiet'));
          return 'quiet';
        }
        let text = built.text;
        try {
          const worded = await seamsRef.word?.(built, { day });
          if (typeof worded === 'string' && worded.trim()) text = worded;
        } catch (error) {
          report(`MoMo's brief wording failed, the plain brief is sent: ${describeError(error)}`);
        }
        await mark(day, (r) => void ((r.text = text), (r.state = 'ready')));
      }
      if (!(await live(stamp))) return 'refused';
      const text = /** @type {string} */ (read()?.briefs[day]?.text);
      await seamsRef.deliver?.({ id: rec.id, day, text, built, stamp });
      await ledger.change((l) => {
        l.briefs[day].state = 'delivered';
        l.lastBriefAt = now();
        if (!manual) l.lastScheduledAt = now();
        l.pending = null;
      });
      return 'delivered';
    } catch (error) {
      report(`MoMo's brief could not be delivered: ${describeError(error)}`);
      let state = 'ready';
      await mark(day, (r) => {
        r.tries += 1;
        if (r.tries >= MAX_TRIES) r.state = 'failed';
        r.reason = describeError(error);
        state = r.state;
      });
      return state;
    }
  }

  /** The brief of `day` is claimed once on this home: the first caller wins, a second (a tick, "Show it now", a restart) sees the claim. @param {string} day @param {Stamp} stamp */
  async function claim(day, stamp) {
    const won = await ledger.change((l) => {
      if (l.briefs[day]) return false;
      l.briefs[day] = { state: 'claimed', at: now(), id: `brief:${day}`, tries: 0, epoch: stamp.leaseEpoch };
      return true;
    });
    if (!won) return false;
    if (!seamsRef.claimBrief) return true;
    try {
      if (await seamsRef.claimBrief({ day, at: now() })) return true;
    } catch (error) {
      // the notice store could not be asked: the day is not left claimed, so the next tick asks again
      report(`MoMo's brief could not be claimed, it is tried again: ${describeError(error)}`);
      await ledger.change((l) => void delete l.briefs[day]);
      return false;
    }
    await mark(day, (r) => void (r.state = 'elsewhere'));
    return false;
  }

  const api = {
    /** The notice lane gives what builds, words and delivers the day once it exists on this Host. @param {DailySeams} next */
    setSeams(next) {
      Object.assign(seamsRef, next);
    },
    /**
     * One look at the day: resume a brief a restart cut off, the brief itself when due, one catch-up after a sleep, the notes tidy.
     * Returns what it did (for the status and tests), or `{ idle }` when this Host is not the running home.
     * @returns {Promise<{ idle?: string, did: string[] }>}
     */
    async tick() {
      const stamp = home.stamp();
      if (!stamp) return { idle: 'not-home', did: [] };
      const s = settings();
      const at = now();
      const l0 = read();
      if (!l0) return { idle: 'unreadable', did: [] };
      /** @type {string[]} */
      const did = [];
      const prev = lastSeen || l0.lastTickAt;
      lastSeen = at;
      const slept = prev > 0 && at - prev > SLEEP_GAP_MS;
      // persisted at most once a minute: enough for a restart to know when the Host was last awake
      if (at - l0.lastTickAt >= MINUTE || slept || at < l0.lastTickAt)
        await ledger.change((l) => {
          l.lastTickAt = at;
          if (slept) l.pending = { from: l.pending?.from ?? prev, to: at };
        });
      if (!s.on || s.paused) return { idle: 'off', did };
      const here = zonedParts(at, s.zone);
      const briefMin = /** @type {number} */ (clockMinutes(s.time));
      const l = /** @type {NonNullable<ReturnType<typeof read>>} */ (read());
      const quiet = inQuiet(s.quiet, at, s.zone);

      // a brief claimed before a restart or a failed delivery goes on under its own id. This resume assumes ONE writer of this record: one instance per home (momoWiring makes the only one, tests/hostMomoDaily.invariant.test.ts holds it there), because two on one directory would both finish a claimed day and deliver twice; across Hosts the notice store's `claimBrief` is the once-only guard
      const today = l.briefs[here.day];
      if (today && ['claimed', 'ready'].includes(today.state)) did.push(`brief:${await finish(here.day, stamp, s)}`);

      const fresh = /** @type {NonNullable<ReturnType<typeof read>>} */ (read());
      const pending = fresh.pending;
      // the sleep covered the brief's time: a catch-up when it wakes, never a late brief on top
      const sleptThrough =
        !!pending &&
        tuple(zonedParts(pending.from, s.zone)) <= `${here.day} ${pad(briefMin)}` &&
        `${here.day} ${pad(briefMin)}` <= tuple(zonedParts(pending.to, s.zone));
      const inWindow = here.minutes >= briefMin && here.minutes < briefMin + BRIEF_WINDOW_MIN;
      const unclaimed = !fresh.briefs[here.day];
      const gapOk = at - fresh.lastScheduledAt >= MIN_BRIEF_GAP_MS;
      const active = seamsRef.active ? seamsRef.active() : true;

      if (unclaimed && inWindow && !quiet && gapOk && active && seamsRef.build && seamsRef.deliver && !sleptThrough) {
        if (await claim(here.day, stamp)) did.push(`brief:${await finish(here.day, stamp, s)}`);
      } else if (unclaimed && sleptThrough && here.minutes >= briefMin && !quiet) {
        // the day's brief did not start: the catch-up below says so, and "Show it now" can still make it
        await ledger.change(
          (x) => void (x.briefs[here.day] ??= { state: 'missed', at, id: `brief:${here.day}`, tries: 0, reason: 'asleep' }),
        );
        did.push('brief:missed');
      }

      const after = /** @type {NonNullable<ReturnType<typeof read>>} */ (read());
      if (after.pending && !quiet && seamsRef.catchUp && (await live(stamp))) {
        const { from } = after.pending;
        const id = `catchup:${from}`;
        const had = after.catchUps[id];
        try {
          // a crash between the delivery and the clearing leaves the id delivered: it is not delivered twice
          if (had?.state !== 'delivered' && (had?.tries ?? 0) < MAX_TRIES) {
            await seamsRef.catchUp({ id, from, to: at, stamp });
            await ledger.change((x) => void (x.catchUps[id] = { state: 'delivered', at }));
            did.push('catchUp');
          }
          await ledger.change((x) => void (x.pending = null));
        } catch (error) {
          report(`MoMo's catch-up could not be delivered, it is tried again: ${describeError(error)}`);
          await ledger.change((x) => {
            const tries = (x.catchUps[id]?.tries ?? 0) + 1;
            x.catchUps[id] = { state: 'failed', tries };
            // given up after MAX_TRIES: what it would have said is in the next brief
            if (tries >= MAX_TRIES) x.pending = null;
          });
        }
      }

      // notes tidy: checked once a night from 3:00, run only when something changed
      if (seamsRef.tidy && here.minutes >= TIDY_AT_MIN && here.minutes < TIDY_AT_MIN + TIDY_WINDOW_MIN && after.tidy.day !== here.day) {
        await ledger.change((x) => void (x.tidy.day = here.day));
        try {
          if ((await seamsRef.tidy.changedSince(after.tidy.at)) && (await live(stamp))) {
            await seamsRef.tidy.run({ stamp });
            await ledger.change((x) => void (x.tidy.at = at));
            did.push('tidy');
          }
        } catch (error) {
          report(`MoMo's notes tidy failed: ${describeError(error)}`);
        }
      }
      return { did };
    },

    /**
     * "Show it now" / "Resume": the day's brief made at once whatever the time or a missed or failed earlier try; a brief already delivered today is left as it is.
     * @returns {Promise<'delivered' | 'already' | 'busy' | 'quiet' | 'failed' | 'refused' | 'not-home' | 'unavailable'>}
     */
    async briefNow() {
      const stamp = home.stamp();
      if (!stamp) return 'not-home';
      if (!seamsRef.build || !seamsRef.deliver) return 'unavailable';
      const s = settings();
      const day = zonedParts(now(), s.zone).day;
      const had = read()?.briefs[day];
      if (had?.state === 'delivered') return 'already';
      if (had && ['quiet', 'missed', 'failed', 'elsewhere'].includes(had.state)) await ledger.change((l) => void delete l.briefs[day]);
      // a double tap, or a tick that claimed the day first, builds nothing twice
      if ((!had || !['claimed', 'ready'].includes(had.state)) && !(await claim(day, stamp))) return 'busy';
      const state = await finish(day, stamp, s, true);
      return /** @type {any} */ (state === 'ready' ? 'failed' : state);
    },

    /** What `host.momoStatus` says of the day, and the failure (with its one-tap fix) when there is one. */
    status() {
      const l = read();
      const s = settings();
      const day = zonedParts(now(), s.zone).day;
      const today = l?.briefs[day] ?? null;
      /** @type {{ code: string, fix: string } | null} */
      let failure = null;
      if (today?.state === 'failed') failure = { code: 'brief_failed', fix: 'show_brief_now' };
      else if (today?.state === 'missed') failure = { code: 'brief_missed_asleep', fix: 'show_brief_now' };
      return { on: s.on && !s.paused, today: today ? today.state : null, pendingCatchUp: !!l?.pending, failure };
    },
  };
  return api;
}

const pad = (/** @type {number} */ m) => String(m).padStart(4, '0');
const tuple = (/** @type {{ day: string, minutes: number }} */ p) => `${p.day} ${pad(p.minutes)}`;
