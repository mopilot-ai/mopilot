// The durable item ledger: one document behind an atomic `change` seam (the home wires it to its sealed store), validated on every read so a damaged file never becomes a wrong state.
import { TASK_ORIGINS, TASK_STATES, type DocSeam, type Item, type TaskError, type TaskResult } from './types.ts';

/** The name this store registers under in Reset MoMo (electron/momo/stores.cjs). */
export const TASKS_STORE_ID = 'tasks';
/** Finished items are kept this long, so "Done today" and a late "Open the session" still work. */
export const KEEP_MS = 30 * 24 * 3_600_000;
export const MAX_ITEMS = 200;

type Doc = { v: 1; items: Item[] };
/** What was read: the items, and the entries that were not whole, kept aside untouched. */
type Read = Doc & { aside: unknown[] };
const EMPTY: Doc = { v: 1, items: [] };
const MAX_ASIDE = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const ERROR_KEYS = ['code', 'message'] as const;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const FIX_ACTIONS = new Set(['install', 'signIn', 'orgSignIn', 'update', 'retry', 'runElsewhere', 'startAgain', 'openSession', 'review']);

/** A stored error, with whatever part is missing filled in: no fixes, no retry. null when it has no code and message. */
function parseError(raw: unknown, at: number): TaskError | null {
  if (!isRecord(raw) || !ERROR_KEYS.every((key) => str(raw[key]))) return null;
  const fixes = (Array.isArray(raw.fixes) ? raw.fixes : []).filter(
    (f): f is TaskError['fixes'][number] => isRecord(f) && str(f.label) && str(f.action) && FIX_ACTIONS.has(f.action),
  );
  return {
    code: raw.code as TaskError['code'],
    message: raw.message as string,
    fixes,
    retry: raw.retry === true,
    at: num(raw.at) ? raw.at : at,
  };
}

/** A stored result, with missing parts filled in. null when there is no summary to build on. */
function parseResult(raw: unknown): TaskResult | null {
  if (!isRecord(raw) || !str(raw.summary)) return null;
  return {
    summary: raw.summary,
    files: Array.isArray(raw.files) ? raw.files.filter(str) : [],
    evidence: str(raw.evidence) ? raw.evidence : '',
    checked: str(raw.checked) ? raw.checked : '',
    met: raw.met === true,
  };
}

/** One stored item, or null when it is not a whole one (it is dropped, never guessed at). */
export function parseItem(raw: unknown): Item | null {
  if (!isRecord(raw) || !isRecord(raw.where)) return null;
  const { where } = raw;
  if (!str(raw.id) || !str(raw.title) || !str(raw.doneMeans) || !str(raw.stableKey)) return null;
  if (!TASK_STATES.includes(raw.state as Item['state']) || !TASK_ORIGINS.includes(raw.origin as Item['origin'])) return null;
  if (!str(where.machineId) || !str(where.harness) || !(where.sessionId === null || str(where.sessionId))) return null;
  if (!num(raw.attempts) || !num(raw.attemptCap) || !num(raw.createdAt) || !num(raw.updatedAt)) return null;
  const optNum = (v: unknown): number | null => (num(v) ? v : null);
  const optStr = (v: unknown): string | null => (str(v) ? v : null);
  const state = raw.state as Item['state'];
  // a failed item always has an error to show, and a finished or waiting one a result, whatever the file lost
  const lastError =
    parseError(raw.lastError, raw.updatedAt) ??
    (state === 'failed'
      ? { code: 'session_failed' as const, message: 'This task failed; the details were lost.', fixes: [], retry: true, at: raw.updatedAt }
      : null);
  const result =
    parseResult(raw.result) ??
    (state === 'done' || state === 'needs_you' ? { summary: '', files: [], evidence: '', checked: '', met: false } : null);
  return {
    id: raw.id,
    title: raw.title,
    doneMeans: raw.doneMeans,
    state,
    where: {
      machineId: where.machineId,
      harness: where.harness,
      sessionId: where.sessionId,
      machineName: str(where.machineName) ? where.machineName : null,
    },
    origin: raw.origin as Item['origin'],
    stableKey: raw.stableKey,
    attempts: raw.attempts,
    attemptCap: raw.attemptCap,
    lastError,
    result,
    progress: optStr(raw.progress),
    cardId: optStr(raw.cardId),
    watch: isRecord(raw.watch) && isRecord(raw.watch.watch) ? (raw.watch as unknown as Item['watch']) : null,
    nextCheck: optNum(raw.nextCheck),
    createdAt: raw.createdAt,
    startedAt: optNum(raw.startedAt),
    updatedAt: raw.updatedAt,
    settled: optNum(raw.settled) ?? 0,
    posted: optNum(raw.posted) ?? 0,
    card: isRecord(raw.card) && str(raw.card.itemId) && num(raw.card.settle) ? (raw.card as unknown as Item['card']) : null,
    notice: isRecord(raw.notice) && str(raw.notice.itemId) ? (raw.notice as unknown as Item['notice']) : null,
    failedWith: optStr(raw.failedWith),
  };
}

/** The ledger cannot be read as it stands. It is left untouched: a newer MoPilot wrote it, or it is damaged (Reset MoMo clears it). */
export class LedgerError extends Error {
  readonly code: 'newer' | 'damaged';
  constructor(code: 'newer' | 'damaged') {
    super(
      code === 'newer'
        ? 'The tasks ledger was written by a newer version of MoPilot, so this version leaves it as it is.'
        : 'The tasks ledger is damaged, so it was left as it is. Reset MoMo clears it.',
    );
    this.code = code;
  }
}

function parseDoc(raw: unknown): Read {
  // no document yet is an empty ledger; anything else that is not a version 1 ledger is refused, never overwritten
  if (raw === null || raw === undefined) return { ...EMPTY, aside: [] };
  if (!isRecord(raw) || !Array.isArray(raw.items) || !num(raw.v)) throw new LedgerError('damaged');
  if (raw.v !== 1) throw new LedgerError(raw.v > 1 ? 'newer' : 'damaged');
  const seen = new Set<string>();
  const items: Item[] = [];
  const aside: unknown[] = Array.isArray(raw.aside) ? [...raw.aside] : [];
  for (const entry of raw.items) {
    const item = parseItem(entry);
    // an entry that is not whole is kept aside as it was, never dropped by the next write; a repeated id is a copy
    if (!item && aside.length < MAX_ASIDE) aside.push(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return { v: 1, items, aside };
}

const TERMINAL = new Set(['done', 'failed', 'stopped']);
/** What a new request does not return: a finished item does not block asking again. */
const LIVE = new Set(['working', 'needs_you', 'watching']);

/** Old finished items go (never one whose card is still owed); the newest MAX_ITEMS stay. A working, waiting or watching item is never pruned. */
function prune(doc: Doc, now: number): Doc {
  const owes = (i: Item): boolean => i.posted < i.settled;
  const kept = doc.items.filter((i) => !TERMINAL.has(i.state) || owes(i) || now - i.updatedAt < KEEP_MS);
  if (kept.length <= MAX_ITEMS) return { v: 1, items: kept };
  const pinned = kept.filter((i) => !TERMINAL.has(i.state) || owes(i));
  const done = kept.filter((i) => TERMINAL.has(i.state) && !owes(i)).sort((a, b) => b.updatedAt - a.updatedAt);
  return { v: 1, items: [...pinned, ...done.slice(0, Math.max(0, MAX_ITEMS - pinned.length))] };
}

export interface ItemStore {
  list(): Promise<Item[]>;
  get(id: string): Promise<Item | null>;
  bySession(machineId: string, sessionId: string): Promise<Item | null>;
  /** Adds the item unless a live one (working, waiting or watching) with its stable key exists (that one comes back); a working item is refused when `maxWorking` are already working. */
  insertOrGet(item: Item, maxWorking: number): Promise<{ item: Item; created: boolean } | { full: true }>;
  /** Takes the item back into `working` for a new start, unless `maxWorking` other tasks are already working (the cap holds for a retry as much as for a new task). null when there is no such item. */
  reopen(id: string, maxWorking: number): Promise<{ item: Item } | { full: true } | null>;
  /** Atomic read-modify-write of one item; `fn` returns the new item, or null to leave it. Resolves the stored item (null when none). */
  update(id: string, fn: (item: Item) => Item | null): Promise<Item | null>;
  /** The stored entries that were not whole, kept as they were so they can be looked at and are not lost by the next write. */
  aside(): Promise<unknown[]>;
  /** Reset MoMo: every item deleted. */
  reset(): Promise<void>;
}

export function createItemStore(seam: DocSeam, clock: { now(): number }): ItemStore {
  const change = <T>(fn: (doc: Doc) => { doc: Doc; out: T }): Promise<T> =>
    seam.change((raw) => {
      const read = parseDoc(raw);
      const result = fn(read);
      return { doc: { ...prune(result.doc, clock.now()), aside: read.aside }, out: result.out };
    });
  return {
    async list() {
      return parseDoc(await seam.read()).items;
    },
    async aside() {
      return parseDoc(await seam.read()).aside;
    },
    async get(id) {
      return parseDoc(await seam.read()).items.find((i) => i.id === id) ?? null;
    },
    async bySession(machineId, sessionId) {
      return parseDoc(await seam.read()).items.find((i) => i.where.machineId === machineId && i.where.sessionId === sessionId) ?? null;
    },
    insertOrGet: (item, maxWorking) =>
      change<{ item: Item; created: boolean } | { full: true }>((doc) => {
        const same = doc.items.find((i) => i.stableKey === item.stableKey && LIVE.has(i.state));
        if (same) return { doc, out: { item: same, created: false } };
        if (item.state === 'working' && doc.items.filter((i) => i.state === 'working').length >= maxWorking)
          return { doc, out: { full: true } };
        return { doc: { v: 1, items: [...doc.items, item] }, out: { item, created: true } };
      }),
    reopen: (id, maxWorking) =>
      change<{ item: Item } | { full: true } | null>((doc) => {
        const at = doc.items.findIndex((i) => i.id === id);
        if (at < 0) return { doc, out: null };
        if (doc.items.filter((i) => i.id !== id && i.state === 'working').length >= maxWorking) return { doc, out: { full: true } };
        const items = [...doc.items];
        // the intent to start is recorded here: the old session is no longer this task's, so a late report from it settles nothing
        const old = items[at] as Item;
        const item = { ...old, state: 'working' as const, where: { ...old.where, sessionId: null }, updatedAt: clock.now() };
        items[at] = item;
        return { doc: { v: 1, items }, out: { item } };
      }),
    update: (id, fn) =>
      change((doc) => {
        const at = doc.items.findIndex((i) => i.id === id);
        if (at < 0) return { doc, out: null };
        const current = doc.items[at] as Item;
        const next = fn(current);
        if (!next) return { doc, out: current };
        const items = [...doc.items];
        items[at] = next;
        return { doc: { v: 1, items }, out: next };
      }),
    // Reset MoMo is the way out of a ledger that cannot be read, so it does not read it
    reset: () => seam.change(() => ({ doc: EMPTY, out: undefined })),
  };
}

/** An in-memory seam for tests and a home that has not wired storage yet. */
export function createMemorySeam(initial: unknown = EMPTY): DocSeam & { snapshot(): unknown } {
  let doc: unknown = initial;
  return {
    read: async () => doc,
    snapshot: () => doc,
    // one JavaScript turn: nothing else runs between reading the document and saving it
    change: async <T>(fn: (current: unknown) => { doc: unknown; out: T }): Promise<T> => {
      const result = fn(doc);
      doc = result.doc;
      return result.out;
    },
  };
}
