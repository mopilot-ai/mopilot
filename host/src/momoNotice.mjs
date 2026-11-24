// MoMo's "notices what matters" on its home (design Function 3): the collector that reads Gmail and Calendar changes on this Host's clock through the home's Google reader, runs the pure notice pipeline (shared/momoNotice) with a tool-less reading model, keeps the matters, the watching entries and the decision log, tells what the limits allow through MoMo's push, and gives the day's brief and catch-up to the daily clock. Everything it does carries the home's lease and stops when this Host is not the running home.
import { calendarClean, runNoticePass } from '../../shared/momoNotice/pipeline.ts';
import { detectEventChanges, detectMailChanges, markCalendarSynced } from '../../shared/momoNotice/changeDetect.ts';
import { briefHasContent, buildBrief, markBriefed } from '../../shared/momoNotice/brief.ts';
import { randomMarkerId } from '../../shared/momoNotice/envelope.ts';
import { dismissMatter, localTime, snoozeMatter, zonedMidnight } from '../../shared/momoNotice/limits.ts';
import { addDays } from '../../shared/momoNotice/signals.ts';
import { namesSender } from '../../shared/momoCore/senders.ts';
import { createDrafter } from './momoNoticeDraft.mjs';
import { fenced } from './momoNoticeFence.mjs';
import { createHeldSweep } from './momoNoticeHeld.mjs';
import { createReminders } from './momoNoticeReminders.mjs';
import { briefView, decisionView, renderBrief, watchingTask } from '../../shared/momoNotice/views.ts';
import { describeError } from '../../shared/userError.mjs';
import { noticeSettingsOf } from './momoDaily.mjs';

const MINUTE = 60_000;
const RETRY = { action: 'retry', label: 'Try again' };
/** Reading turns a day may use, the most a failing reading waits before trying again, and how many more a person may allow. */
export const READS_PER_DAY = 300;
export const BACKOFF_BASE_MS = 5 * MINUTE;
export const BACKOFF_MAX_MS = 60 * MINUTE;
export const MORE_READS = 100;
/** A usage limit as a harness words it. */
const USAGE_LIMIT = /usage limit|rate limit|quota|too many requests|\b429\b|overloaded/i;

/** The home moved on (a move, Reset, a lost lease) while a pass was running: nothing more is written. */
export class LeaseLost extends Error {}

/** How often the Host looks for changes while the home is awake. */
export const PASS_EVERY_MS = 5 * MINUTE;
/** The collector's modes: nothing, the brief only (the first thing anyone sees of it), or tell-now pushes as well. Off until it is turned on for a Host. */
export const NOTICE_MODES = /** @type {const} */ (['off', 'brief', 'tell_now']);
/** @param {string | undefined} value */
export const noticeModeOf = (value) => NOTICE_MODES.find((m) => m === value) ?? 'off';
/** The matters a Watching list shows. */
const WATCHING_LIMIT = 50;
/** @param {string} address */
const domainOf = (address) => /@([^>\s]+)>?\s*$/.exec(address.trim())?.[1]?.toLowerCase() ?? '';

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./momoHome.mjs').createMomoHome> & Record<string, any>} o.home
 * @param {ReturnType<typeof import('./momoNoticeStore.mjs').createNoticeStore>} o.store
 * @param {() => Promise<{ client: any, versions: any }>} o.reader the home's Google reader (read-only client and the sealed version store)
 * @param {() => Promise<{ kind: string, email?: string }>} o.google the home's Google state
 * @param {() => import('../../shared/momoNotice/types.d.ts').ReaderModel | null} o.model the tool-less reading model, none until the Host has one
 * @param {() => 'off' | 'brief' | 'tell_now'} o.mode
 * @param {() => { tell: (item: any) => Promise<{ status: string }> } | undefined} [o.push] read when needed: the push is made after the services load
 * @param {() => { machineId: string, name: string }} o.machine this Host as the apps name it
 * @param {() => number} [o.now]
 * @param {(message: string) => void} o.report
 * @param {number} [o.everyMs]
 * @param {number} [o.readsPerDay] reading turns a day may use
 */
export function createMomoNotice({
  home,
  store,
  reader,
  google,
  model,
  mode,
  push = () => undefined,
  machine,
  now = Date.now,
  report,
  everyMs = PASS_EVERY_MS,
  readsPerDay = READS_PER_DAY,
}) {
  let running = false;
  let lastTickAt = 0;
  /** What the last pass could not read, for the brief and the apps: the cause, and the one action that may fix it. @type {{ source: string, why: string, fix?: { action: string, label: string } }[]} */
  let gaps = [];
  /** @type {{ at: number, did: string[] } | null} */
  let lastPass = null;

  const drafter = createDrafter({
    store,
    home,
    reader,
    model: () => model(),
    spend: async () => store.countRead(localTime(new Date(now()), noticeSettingsOf(home.prefs.forRoutines()).timeZone).dayKey, readsPerDay),
    email: async () => {
      const status = await google();
      return 'email' in status && status.email ? status.email : 'me@example.invalid';
    },
    now,
    randomId: randomMarkerId,
  });
  /** Why a reminder could not be told now, or null: notices are not set to push, or no push is set up on this machine. */
  const cannotRemind = () =>
    mode() !== 'tell_now'
      ? 'MoMo can’t remind you here: notices are not set to tell you now on this machine.'
      : push()
        ? null
        : 'MoMo can’t remind you yet: no phone push is set up on this machine.';
  /** @param {{ getMatter: any, listMatters: any, updateMatter: any }} notice */
  const remindersOn = (notice) => createReminders({ store: { notice }, now, push, cannotFire: cannotRemind });
  // the store opens on first use (a home with no storage has none yet), so it is read when a reminder is asked for, never while this is built
  const reminders = createReminders({
    store: {
      get notice() {
        return store.notice;
      },
    },
    now,
    push,
    cannotFire: cannotRemind,
  });
  /** Reminders given up on, with why, until they are tried again or the matter ends. @type {{ source: string, why: string, at: number }[]} */
  let reminderGaps = [];
  /** The reminder gaps of the last day, as the apps show gaps. */
  const reminderGapsNow = () => {
    reminderGaps = reminderGaps.filter((g) => now() - g.at < 24 * 3_600_000);
    return reminderGaps.map(({ source, why }) => ({ source, why }));
  };
  let reminding = false;

  /** The reminders that are due, outside the pass (a wait, a backoff or a failing pass never holds one back). @param {{ homeId: string, leaseEpoch: number }} stamp */
  async function fireReminders(stamp) {
    if (reminding) return;
    reminding = true;
    try {
      const check = async () => {
        if (!(await live(stamp))) throw new LeaseLost('MoMo moved on while reminders were going out.');
      };
      const fencedNotice = fenced(store.notice, ['updateMatter'], check);
      const { gaveUp } = await remindersOn(fencedNotice).fire({ stillHome: () => live(stamp) });
      // mail a quiet rule held for a brief that is off, or not shown for days, moves to Watching where it is seen
      await createHeldSweep({
        store: { notice: fencedNotice },
        now,
        briefOn: () => home.prefs.forRoutines()?.momo?.brief?.on !== false,
        recheckMs: () => noticeSettingsOf(home.prefs.forRoutines()).trackRecheckMs,
      }).sweep();
      if (gaveUp.length > 0) {
        reminderGaps = [
          ...reminderGaps,
          ...gaveUp.map((g) => ({ source: 'Reminders', why: `A reminder for “${g.title}” could not be sent: ${g.why}.`, at: now() })),
        ].slice(-5);
      }
    } catch (error) {
      if (!(error instanceof LeaseLost)) report(`MoMo's reminders failed: ${describeError(error)}`);
    } finally {
      reminding = false;
    }
  }

  /** Whether the lease an action began under is still the home's. @param {{ homeId: string, leaseEpoch: number }} stamp */
  const live = async (stamp) => home.current(stamp) && (await home.receiveStamp(stamp)).ok;

  /**
   * After a pass: reading that failed every time waits (5 minutes, doubling to an hour) and says why with the one action that may fix it; reading that worked clears the wait; a spent day says so.
   * @param {{ ok: number, failed: number, spent: boolean, error: unknown }} budget @param {{ setBackoff: (b: { until: number, tries: number }) => Promise<unknown> }} mine
   */
  async function settleReading(budget, mine) {
    if (budget.spent)
      gaps.push({
        source: 'Reading',
        why: `Reading is paused for today: the limit of ${readsPerDay} reads was reached.`,
        fix: { action: 'more_reads', label: `Allow ${MORE_READS} more today` },
      });
    if (budget.failed > 0 && budget.ok === 0) {
      const tries = store.backoff().tries + 1;
      await mine.setBackoff({ until: now() + Math.min(BACKOFF_BASE_MS * 2 ** (tries - 1), BACKOFF_MAX_MS), tries });
      const limit = USAGE_LIMIT.test(String(budget.error));
      gaps.push({
        source: 'Reading',
        why: limit ? `Reading is paused: usage limit on ${machine().name}.` : 'Reading is paused: the reading model did not answer.',
        fix: RETRY,
      });
    } else if (budget.ok > 0) await mine.setBackoff({ until: 0, tries: 0 });
  }

  /** The owner's standing rules from the learning service (none while it is absent or this Host is not the home); a failure there never stops a pass. */
  function readOwnerRules() {
    try {
      const rules = /** @type {any} */ (home.service('learning'))?.ownerRules?.();
      return Array.isArray(rules) ? rules : [];
    } catch (error) {
      report(`MoMo could not read the owner's rules: ${describeError(error)}`);
      return [];
    }
  }

  /** The senders whose quiet rule the owner accepted, minus any the owner also wrote a "tell me now" rule for (a name in such a rule keeps the sender loud); none while the learning service has none. @param {{ kind: string, text: string }[]} rules */
  function readQuietSenders(rules) {
    try {
      const senders = /** @type {any} */ (home.service('learning'))?.quietSenders?.();
      // a "tell me now" rule wins for a sender it names: learning's own `namesSender`, so the two sides cannot differ
      const texts = rules.filter((r) => r.kind === 'tell_now').map((r) => String(r.text));
      return (Array.isArray(senders) ? senders : []).filter(
        (/** @type {any} */ q) =>
          typeof q?.domain === 'string' && !texts.some((text) => namesSender(text, { domain: q.domain, address: q.address ?? null })),
      );
    } catch (error) {
      report(`MoMo could not read the quiet senders: ${describeError(error)}`);
      return [];
    }
  }

  /** @param {{ homeId: string, leaseEpoch: number }} stamp @param {'brief' | 'tell_now'} how */
  async function pass(stamp, how) {
    const settings = noticeSettingsOf(home.prefs.forRoutines());
    const reading = model();
    const rules = readOwnerRules();
    let rulesApplied = false;
    if (!reading) {
      gaps = [
        {
          source: 'Reading',
          why: 'No reading model is set up on this machine yet.',
          fix: { action: 'update_host', label: 'Update MoMo on this machine' },
        },
      ];
      return { idle: 'no-model' };
    }
    /** @type {any} */
    let google_;
    try {
      google_ = await reader();
    } catch (error) {
      gaps = [{ source: 'Google', why: describeError(error), fix: { action: 'connect_google', label: 'Connect Google' } }];
      return { idle: 'no-google' };
    }
    const status = await google();
    const email = 'email' in status && status.email ? status.email : 'me@example.invalid';
    const at = new Date(now());
    const first = store.lastRunAt() === undefined;
    const connectDay = await store.connectDay(localTime(at, settings.timeZone).dayKey);
    const options = { now: at, settings, connectDay };
    gaps = [];
    /** @type {import('../../shared/momoNotice/changeDetect.ts').Change[]} */
    let changes = [];
    let token = '';
    try {
      changes = await detectMailChanges(google_.client, google_.versions, options);
    } catch (error) {
      gaps.push({ source: 'Gmail', why: describeError(error), fix: RETRY });
    }
    let calendarOk = true;
    try {
      const events = await detectEventChanges(google_.client, google_.versions, options);
      changes = [...changes, ...events.changes];
      token = events.token;
    } catch (error) {
      calendarOk = false;
      gaps.push({ source: 'Calendar', why: describeError(error), fix: RETRY });
    }
    if (!(await live(stamp))) return { idle: 'not-home' };
    // every write from here on first asks whether this Host is still the running home (a pass can run for minutes)
    const check = async () => {
      if (!(await live(stamp))) throw new LeaseLost('MoMo moved on while a pass was running.');
    };
    const mine = fenced(store, ['addDecision', 'setLastRunAt', 'learnDomains', 'countRead', 'setBackoff'], check);
    const noticeStore = fenced(store.notice, ['putMatter', 'tryCountTold'], check);
    const versions = fenced(google_.versions, ['set'], check);
    const day = localTime(at, settings.timeZone).dayKey;
    const budget = { ok: 0, failed: 0, spent: false, error: /** @type {unknown} */ (null) };
    /** The reading model, counted against the day's budget, with its failures kept for the backoff. @type {import('../../shared/momoNotice/types.d.ts').ReaderModel} */
    const watched = {
      name: reading.name,
      async complete(prompt, signal) {
        if (!rulesApplied && rules.some((r) => r.kind !== 'ask_first')) {
          rulesApplied = true;
          /** @type {any} */ (home.service('learning'))?.appliedBy?.('notice');
        }
        if (!(await mine.countRead(day, readsPerDay))) {
          budget.spent = true;
          throw new Error("The day's reading budget is spent.");
        }
        try {
          const text = await reading.complete(prompt, signal);
          budget.ok += 1;
          return text;
        } catch (error) {
          budget.failed += 1;
          budget.error = error;
          throw error;
        }
      },
    };
    const result = await runNoticePass(
      {
        store: noticeStore,
        versions,
        model: watched,
        person: { name: email.split('@')[0], email, rules },
        quietSenders: readQuietSenders(rules),
        briefOn: home.prefs.forRoutines()?.momo?.brief?.on !== false,
        clock: { now: () => new Date(now()) },
        settings,
        history: { knownDomains: async () => store.knownDomains() },
        randomId: randomMarkerId,
        ...(first ? {} : { lastRunAt: new Date(/** @type {number} */ (store.lastRunAt())) }),
        load: async (change) => {
          if (change.kind === 'event') return change.event.status === 'cancelled' ? null : { kind: 'event', event: change.event };
          const mail = await google_.client.getMail(change.threadId);
          if (mail?.labels.includes('SENT'))
            await mine.learnDomains([...mail.to, ...mail.cc].map(domainOf).filter((/** @type {string} */ d) => d !== ''));
          return mail ? { kind: 'mail', mail } : null;
        },
      },
      changes,
    );
    if (calendarOk && token && calendarClean(result.decisions)) await markCalendarSynced(versions, token, at);
    for (const decision of result.decisions) {
      const matter = await store.notice.getMatter(decision.matterKey);
      await mine.addDecision({ ...decision, title: matter?.title ?? decision.matterKey, first: !matter || matter.sources.length <= 1 });
    }
    // each time a learned quiet rule kept something out, the rule is counted as used (the Rules page shows it, and a mistaken Accept shows up)
    for (const decision of result.decisions) {
      const ruleId = decision.decidedBy.startsWith('rule:quiet-sender:') ? decision.decidedBy.slice('rule:quiet-sender:'.length) : null;
      if (ruleId) await /** @type {any} */ (home.service('learning'))?.used?.(ruleId)?.catch?.(() => undefined);
    }
    await mine.setLastRunAt(now());
    await settleReading(budget, mine);
    /** The version each change had when it was read, for the push's own key. */
    const versionOf = new Map(changes.map((c) => [c.kind === 'mail' ? `gmail:${c.threadId}` : `calendar:${c.eventId}`, c.version]));
    /** @type {string[]} */
    const told = [];
    const pusher = how === 'tell_now' ? push() : undefined;
    for (const decision of result.decisions) {
      if (decision.outcome !== 'tell_now' || !pusher || !(await live(stamp))) continue;
      const version = versionOf.get(decision.changeId);
      const out = await pusher.tell({ kind: 'reply', key: `notice:${decision.changeId}:${version}` });
      if (out.status === 'sent' || out.status === 'held') told.push(decision.changeId);
    }
    return { did: ['pass'], decisions: result.decisions.length, told };
  }

  const api = {
    /** One look at the day's mail and calendar; a no-op while off, when this Host is not the running home, or between passes. */
    async tick() {
      const how = mode();
      if (how === 'off') return { idle: 'off' };
      const stamp = home.stamp();
      if (!stamp) return { idle: 'not-home' };
      if (home.prefs.get().paused) return { idle: 'paused' };
      // whether a pass runs now is decided here, before anything is awaited, so two ticks never both begin one
      const idle = running ? 'busy' : now() - lastTickAt < everyMs ? 'wait' : now() < store.backoff().until ? 'backoff' : null;
      if (idle) {
        // reminders are due on their own time: a wait, a backoff or a pass under way never holds one back
        await fireReminders(stamp);
        return { idle };
      }
      running = true;
      lastTickAt = now();
      /** @type {Awaited<ReturnType<typeof pass>>} */
      let out;
      try {
        await fireReminders(stamp);
        out = await pass(stamp, how);
        lastPass = { at: now(), did: /** @type {{ did?: string[] }} */ (out).did ?? [] };
      } catch (error) {
        if (error instanceof LeaseLost) {
          running = false;
          return { idle: 'not-home' };
        }
        report(`MoMo's notice pass failed: ${describeError(error)}`);
        gaps = [{ source: 'Notices', why: 'A pass could not finish; it is tried again.', fix: RETRY }];
        out = { idle: 'failed' };
      }
      running = false;
      return out;
    },

    /** "Draft a reply" on a notice (the intent `notice.draft`). */
    draft: drafter.draft,
    /** "Remind me later" on a notice (the intent `notice.remind`). */
    remind: reminders.remind,

    /** What the day's clock asks of the notice lane (`home.daily.setSeams`). */
    seams: {
      /** @param {{ day: string, since: number, until: number, zone: string, stamp: any }} a */
      async build({ since, until, zone }) {
        const settings = noticeSettingsOf(home.prefs.forRoutines());
        const at = new Date(until);
        const log = store.decisions().filter((/** @type {any} */ d) => Date.parse(d.at) >= since);
        const today = localTime(at, zone).dayKey;
        /** @type {any[]} */
        let events = [];
        const gap = [...gaps, ...reminderGapsNow()];
        try {
          const read = await reader();
          const day = await read.client.listEvents({
            timeMin: zonedMidnight(today, zone).toISOString(),
            timeMax: zonedMidnight(addDays(today, 1), zone).toISOString(),
            showDeleted: false,
            maxResults: 50,
          });
          events = day.events;
        } catch (error) {
          gap.push({ source: 'Calendar', why: describeError(error) });
        }
        const brief = buildBrief({
          now: at,
          settings: { ...settings, timeZone: zone },
          name: null,
          matters: await store.notice.listMatters(),
          events,
          unsorted: store.unsorted(),
          couldNotCheck: gap,
          checked: {
            mail: log.filter((/** @type {any} */ d) => d.changeId.startsWith('gmail:')).length,
            byRules: log.filter((/** @type {any} */ d) => d.decidedBy.startsWith('rule:')).length,
            byModel: log.filter((/** @type {any} */ d) => d.decidedBy.startsWith('model:')).length,
          },
        });
        if (!briefHasContent(brief)) {
          // a quiet day does not use up the day
          await store.notice.releaseBrief(brief.dayKey);
          return null;
        }
        // the card says "quiet mail": events that were quiet are not listed
        const leftOut = log
          .filter(
            (/** @type {any} */ d) =>
              d.decision === 'quiet' && d.changeId.startsWith('gmail:') && !d.decidedBy.startsWith('rule:quiet-sender:'),
          )
          .slice(-20);
        return { text: renderBrief(brief, zone), brief, view: briefView(brief, leftOut) };
      },
      /** @param {{ id: string, day: string, text: string, built: any, stamp: any }} a */
      async deliver({ id, day, text, built, stamp }) {
        if (!(await live(stamp))) throw new LeaseLost('MoMo moved on; the brief was not delivered.');
        if (built?.view) await store.saveView(`brief:${day}`, { ...built.view, text }, now());
        if (built?.brief) await markBriefed(store.notice, built.brief, new Date(now()));
        await store.setLastBriefAt(now());
        const out = await push()?.tell({ kind: 'brief', key: id });
        if (out && out.status === 'failed') throw new Error('The brief could not be pushed yet.');
      },
      /** @param {{ id: string, from: number, to: number, stamp: any }} a */
      async catchUp({ id, from, to, stamp }) {
        if (!(await live(stamp))) throw new LeaseLost('MoMo moved on; the catch-up was not delivered.');
        const told = store
          .decisions()
          .filter((/** @type {any} */ d) => d.outcome === 'catch_up' && Date.parse(d.at) >= from && Date.parse(d.at) <= to);
        if (told.length === 0) return;
        const read = store.decisions().filter((/** @type {any} */ d) => Date.parse(d.at) >= from && Date.parse(d.at) <= to).length;
        await store.saveView(
          `catchup:${from}`,
          { machine: machine(), from, to, read, needsYou: told.map((/** @type {any} */ d) => ({ id: d.changeId, text: d.title })) },
          now(),
        );
        if (mode() === 'tell_now') await push()?.tell({ kind: 'catchUp', key: id });
      },
      claimBrief: (/** @type {{ day: string }} */ a) => store.notice.claimBrief(a.day),
    },

    /** What a person does to a matter from the apps. */
    actions: {
      /** Reading failed or paused: try again now, without waiting out the backoff. */
      retry: async () => {
        await store.setBackoff({ until: 0, tries: 0 });
        lastTickAt = 0;
        return true;
      },
      /** The day's reading budget is spent: allow more reads today. */
      moreReads: async () =>
        store.allowMore(localTime(new Date(now()), noticeSettingsOf(home.prefs.forRoutines()).timeZone).dayKey, MORE_READS),
      snooze: (/** @type {string} */ matterKey, /** @type {number} */ until) =>
        snoozeMatter(store.notice, matterKey, new Date(until), new Date(now())),
      dismiss: (/** @type {string} */ matterKey) => dismissMatter(store.notice, matterKey, new Date(now())),
    },

    /** What the apps ask for: the why of decisions, the Watching rows, the cards shown, and the state of the collector. */
    views: {
      /** @param {{ ids?: string[], matterKey?: string, limit?: number }} [q] */
      decisions(q = {}) {
        const all = store.decisions();
        const chosen = all.filter((/** @type {any} */ d) =>
          q.ids ? q.ids.includes(d.changeId) : q.matterKey ? d.matterKey === q.matterKey : true,
        );
        return chosen.slice(-(q.limit ?? 50)).map(decisionView);
      },
      async watching() {
        const matters = (await store.notice.listMatters())
          .filter((/** @type {any} */ m) => m.state === 'watching' || (m.remindAt && (m.state === 'open' || m.state === 'offered')))
          .slice(0, WATCHING_LIMIT);
        const log = store.decisions();
        return matters.map((/** @type {any} */ m) =>
          watchingTask(m, [...log].reverse().find((/** @type {any} */ d) => d.matterKey === m.matterKey) ?? null, machine()),
        );
      },
      cards: () => store.views(),
      state: () => ({ mode: mode(), lastPass, gaps: [...gaps, ...reminderGapsNow()] }),
    },
  };
  return api;
}
