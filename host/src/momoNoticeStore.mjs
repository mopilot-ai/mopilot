// MoMo's notice records on its home, sealed with MoMo's data key under the home's storage so a move carries them and a reset deletes them: the matters and watching entries, the daily told count and brief claims, the decision log, the cursors, the domains the user writes to, and the briefs shown. Every read-modify-write is one `change`, so two passes or two devices never count or claim twice.
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../electron/gateway/sealedFile.cjs');

/** The decision log keeps this many lines, the briefs and claims this many days, the correspondents this many domains. */
export const KEEP_DECISIONS = 500;
const KEEP_DAYS = 30;
const KEEP_VIEWS = 60;
const KEEP_REACTIONS = 500;
const KEEP_DOMAINS = 500;
const KEEP_UNSORTED = 50;

/** @param {any} x */
const record = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

/** @param {any} v */
export const noticeShape = (v) => ({
  matters: record(v?.matters),
  told: {
    day: typeof v?.told?.day === 'string' ? v.told.day : '',
    keys: Array.isArray(v?.told?.keys) ? v.told.keys.filter((/** @type {unknown} */ k) => typeof k === 'string') : [],
  },
  claims: record(v?.claims),
  decisions: Array.isArray(v?.decisions) ? v.decisions.filter((/** @type {any} */ d) => d && typeof d.changeId === 'string') : [],
  views: record(v?.views),
  reactions: Array.isArray(v?.reactions)
    ? v.reactions.filter((/** @type {any} */ r) => r && typeof r.kind === 'string' && typeof r.rowId === 'string')
    : [],
  hiddenOffers: Array.isArray(v?.hiddenOffers) ? v.hiddenOffers.filter((/** @type {unknown} */ o) => typeof o === 'string') : [],
  domains: Array.isArray(v?.domains) ? v.domains.filter((/** @type {unknown} */ d) => typeof d === 'string') : [],
  unsorted: record(v?.unsorted),
  lastRunAt: Number.isFinite(v?.lastRunAt) ? v.lastRunAt : 0,
  lastBriefAt: Number.isFinite(v?.lastBriefAt) ? v.lastBriefAt : 0,
  connectDay: typeof v?.connectDay === 'string' ? v.connectDay : '',
  reads: {
    day: typeof v?.reads?.day === 'string' ? v.reads.day : '',
    count: Number.isInteger(v?.reads?.count) && v.reads.count > 0 ? v.reads.count : 0,
  },
  backoff: {
    until: Number.isFinite(v?.backoff?.until) ? v.backoff.until : 0,
    tries: Number.isInteger(v?.backoff?.tries) && v.backoff.tries > 0 ? v.backoff.tries : 0,
  },
});

/**
 * @param {object} o
 * @param {{ storage: { dir: string }, data: { safeStorage: any } }} o.home MoMo's data key seals it: the one a move bundle carries, not the Host's own key file
 * @param {() => number} [o.now]
 */
export function createNoticeStore({ home, now = Date.now }) {
  const file = new SealedJson({
    file: path.join(home.storage.dir, 'notice.json'),
    safeStorage: home.data.safeStorage,
    shape: noticeShape,
    now,
  });
  const read = () => file.read();
  const change = (/** @type {(v: ReturnType<typeof noticeShape>) => any} */ fn) => file.change(fn);

  return {
    /** The core's `NoticeStore` (shared/momoNotice/types.d.ts). */
    notice: {
      getMatter: async (/** @type {string} */ key) => read().matters[key],
      putMatter: (/** @type {any} */ matter) => change((v) => void (v.matters[matter.matterKey] = matter)),
      listMatters: async () => Object.values(read().matters),
      /** One matter changed from the record as it is NOW, atomically: `fn` gets the kept matter (or undefined) and returns the new one, or undefined to leave it. Resolves whether it changed. */
      updateMatter: (/** @type {string} */ key, /** @type {(current: any) => any} */ fn) =>
        change((v) => {
          const next = fn(v.matters[key]);
          if (next === undefined) return false;
          v.matters[key] = next;
          return true;
        }),
      /** The day's told count, atomic and idempotent per key: a key already counted today is counted once. */
      tryCountTold: (/** @type {string} */ day, /** @type {number} */ cap, /** @type {string | undefined} */ key) =>
        change((v) => {
          if (v.told.day !== day) v.told = { day, keys: [] };
          if (key !== undefined && v.told.keys.includes(key)) return true;
          if (v.told.keys.length >= cap) return false;
          v.told.keys.push(key ?? `n${v.told.keys.length}`);
          return true;
        }),
      claimBrief: (/** @type {string} */ day) =>
        change((v) => {
          if (v.claims[day]) return false;
          v.claims[day] = now();
          for (const old of Object.keys(v.claims).sort().slice(0, -KEEP_DAYS)) delete v.claims[old];
          return true;
        }),
      releaseBrief: (/** @type {string} */ day) => change((v) => void delete v.claims[day]),
    },
    /** One more reading turn today, counted atomically; false when the day's budget is spent. @param {string} day @param {number} max */
    countRead: (day, max) =>
      change((v) => {
        if (v.reads.day !== day) v.reads = { day, count: 0 };
        if (v.reads.count >= max) return false;
        v.reads.count += 1;
        return true;
      }),
    /** Gives back `n` of today's reading turns, so a person can allow more after the budget is spent. @param {string} day @param {number} n */
    allowMore: (day, n) =>
      change((v) => {
        if (v.reads.day !== day) v.reads = { day, count: 0 };
        v.reads.count = Math.max(0, v.reads.count - n);
        return true;
      }),
    /** How long reading waits after failing, kept across a restart: `until` (ms) and the failures in a row. */
    backoff: () => read().backoff,
    /** @param {{ until: number, tries: number }} next */
    setBackoff: (next) => change((v) => void (v.backoff = next)),
    /** What a person did to a notice, as the home derived it from its own log: the input of learned rules, newest last, capped. @param {any} reaction */
    addReaction: (reaction) =>
      change((v) => {
        v.reactions.push(reaction);
        if (v.reactions.length > KEEP_REACTIONS) v.reactions.splice(0, v.reactions.length - KEEP_REACTIONS);
      }),
    reactions: () => read().reactions,
    /** An offer on the brief the owner hid. @param {string} id */
    hideOffer: (id) =>
      change((v) => {
        if (!v.hiddenOffers.includes(id)) v.hiddenOffers.push(id);
        if (v.hiddenOffers.length > KEEP_DOMAINS) v.hiddenOffers.splice(0, v.hiddenOffers.length - KEEP_DOMAINS);
      }),
    hiddenOffers: () => read().hiddenOffers,
    /** What the collector keeps beside the core's records. */
    lastRunAt: () => read().lastRunAt || undefined,
    setLastRunAt: (/** @type {number} */ at) => change((v) => void (v.lastRunAt = at)),
    lastBriefAt: () => read().lastBriefAt || undefined,
    setLastBriefAt: (/** @type {number} */ at) => change((v) => void (v.lastBriefAt = at)),
    /** The home-local day the account was first read: events before it are never read. Set once. @param {string} day */
    connectDay: (day) => change((v) => (v.connectDay ||= day)),
    /** @param {any} stored a decision with its matter's title */
    addDecision: (stored) =>
      change((v) => {
        v.decisions.push(stored);
        if (v.decisions.length > KEEP_DECISIONS) v.decisions.splice(0, v.decisions.length - KEEP_DECISIONS);
        // what could not be sorted waits in the brief until a later pass sorts it
        if (stored.outcome === 'unsorted')
          v.unsorted[stored.changeId] = { key: stored.changeId, title: stored.title, error: stored.reason };
        else delete v.unsorted[stored.changeId];
        for (const key of Object.keys(v.unsorted).slice(0, -KEEP_UNSORTED)) delete v.unsorted[key];
      }),
    decisions: () => read().decisions,
    unsorted: () => Object.values(read().unsorted),
    /** The domains the user writes to (the sender check's history), newest last. @param {string[]} domains */
    learnDomains: (domains) =>
      change((v) => {
        for (const d of domains) if (!v.domains.includes(d)) v.domains.push(d);
        if (v.domains.length > KEEP_DOMAINS) v.domains.splice(0, v.domains.length - KEEP_DOMAINS);
      }),
    knownDomains: () => read().domains,
    /** A card shown to the apps, a brief (key `brief:<day>`) or a catch-up (`catchup:<from>`); the newest are kept. @param {string} key @param {any} view @param {number} at */
    saveView: (key, view, at) =>
      change((v) => {
        v.views[key] = { view, at };
        const old = Object.entries(v.views)
          .sort((a, b) => b[1].at - a[1].at)
          .slice(KEEP_VIEWS);
        for (const [k] of old) delete v.views[k];
      }),
    views: () =>
      Object.entries(read().views)
        .filter(([, entry]) => entry && typeof entry.view === 'object' && entry.view !== null)
        .map(([key, entry]) => ({ key, ...entry })),
  };
}
