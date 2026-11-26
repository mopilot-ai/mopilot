// What MoMo's home screens keep on the phone between runs: the notes (to read while the home is out of reach) and the messages not yet confirmed (so a kill loses none), one sealed row for each account and computer, and the newest lease stamp seen for each account (so an old home's late view or push is refused after a restart), all sealed with the device-only key. No token or sign-in is ever in it.
import { fromHex, toHex } from '../../../shared/remote/envelope.mjs';
import type { MomoNoteView } from '../../../shared/momoView';
import type { CacheCrypto, CacheStore } from '../momo/cache';
import type { LocalTurn } from './types';

export type HomeCopy = { notes: MomoNoteView[]; turns: LocalTurn[] };
export type HomeScope = { user: string; pair: string };
/** What reading a row says: nothing was kept, the copy, or that something was kept and could not be read (a locked or lost key, a damaged row): never the same as nothing. */
export type HomeLoad = { status: 'none' } | { status: 'ok'; copy: HomeCopy } | { status: 'unreadable' };

type Row = HomeScope & { nonce: string; box: string };
/** The newest lease seen for one account: the home that held it and its epoch. */
export type Stamp = { homeId: string; leaseEpoch: number };
type StampRow = { user: string; nonce: string; box: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const aad = (s: HomeScope) => `momo-home:${s.user}:${s.pair}`;
const stampAad = (user: string) => `momo-stamp:${user}`;
const isStampRow = (v: unknown): v is StampRow =>
  !!v && typeof v === 'object' && ['user', 'nonce', 'box'].every((k) => typeof (v as Record<string, unknown>)[k] === 'string');
const isRow = (v: unknown): v is Row =>
  !!v && typeof v === 'object' && ['user', 'pair', 'nonce', 'box'].every((k) => typeof (v as Record<string, unknown>)[k] === 'string');

/** The container holds rows, none, or something that is not rows at all (a damaged value): never the same as none. */
type Rows = { rows: Row[]; stamps: StampRow[] } | 'damaged';

export function createHomeCache({ store, crypto }: { store: CacheStore; crypto: CacheCrypto }) {
  /** Every change goes through one line, so two stores (or a store and the guard) never read the same rows and write over each other. */
  let line: Promise<unknown> = Promise.resolve();
  const alone = <T>(job: () => Promise<T>): Promise<T> => {
    const mine = line.then(job, job);
    line = mine.catch(() => undefined);
    return mine;
  };
  async function rows(): Promise<Rows> {
    const raw = await store.read();
    if (raw === null) return { rows: [], stamps: [] };
    try {
      const saved = JSON.parse(raw) as { rows?: unknown; stamps?: unknown };
      const stamps = Array.isArray(saved.stamps) ? saved.stamps.filter(isStampRow) : [];
      return Array.isArray(saved.rows) ? { rows: saved.rows.filter(isRow), stamps } : 'damaged';
    } catch {
      return 'damaged';
    }
  }
  const write = (kept: Row[], stamps: StampRow[]) =>
    kept.length || stamps.length ? store.write(JSON.stringify({ rows: kept, stamps })) : store.clear();
  const same = (a: HomeScope, b: HomeScope) => a.user === b.user && a.pair === b.pair;
  return {
    /** The accounts and computers something is kept for (not secret: the vault holds both). A damaged container has none to name. */
    scopes: async (): Promise<HomeScope[]> => {
      const all = await alone(rows);
      return all === 'damaged' ? [] : all.rows.map(({ user, pair }) => ({ user, pair }));
    },
    /** Keeps the copy for this account and computer. A damaged container is never written over: the save fails and says so. */
    save: (at: HomeScope, copy: HomeCopy): Promise<void> =>
      alone(async () => {
        const nonce = crypto.randomBytes(24);
        const box = crypto.seal(await crypto.key(), nonce, encoder.encode(JSON.stringify(copy)), aad(at));
        const all = await rows();
        if (all === 'damaged') throw new Error('what is kept on this phone cannot be read');
        await write([...all.rows.filter((r) => !same(r, at)), { ...at, nonce: toHex(nonce), box: toHex(box) }], all.stamps);
      }),
    /** The copy kept for this account and computer. Other computers' rows are left as they are. */
    load: (at: HomeScope): Promise<HomeLoad> =>
      alone(async (): Promise<HomeLoad> => {
        try {
          const all = await rows();
          if (all === 'damaged') return { status: 'unreadable' };
          const row = all.rows.find((r) => same(r, at));
          if (!row) return { status: 'none' };
          const plain = crypto.open(await crypto.key(), fromHex(row.nonce), fromHex(row.box), aad(at));
          if (!plain) return { status: 'unreadable' };
          const copy = JSON.parse(decoder.decode(plain)) as HomeCopy;
          return Array.isArray(copy.notes) && Array.isArray(copy.turns) ? { status: 'ok', copy } : { status: 'unreadable' };
        } catch {
          return { status: 'unreadable' };
        }
      }),
    /** Forgets the rows this says to: an account signed out, a computer unpaired, a computer that is not a MoMo home. A damaged container is left alone. */
    forget: (drop: (s: HomeScope) => boolean, dropStamp: (user: string) => boolean = () => false): Promise<void> =>
      alone(async () => {
        const all = await rows();
        if (all === 'damaged') return;
        const kept = all.rows.filter((r) => !drop(r));
        const stamps = all.stamps.filter((r) => !dropStamp(r.user));
        if (kept.length !== all.rows.length || stamps.length !== all.stamps.length) await write(kept, stamps);
      }),
    /** The newest lease stamp kept for this account: none, the stamp, or that one is kept and cannot be read (never taken as none). */
    newest: (user: string): Promise<{ status: 'none' } | { status: 'ok'; stamp: Stamp } | { status: 'unreadable' }> =>
      alone(async () => {
        try {
          const all = await rows();
          if (all === 'damaged') return { status: 'unreadable' as const };
          const row = all.stamps.find((r) => r.user === user);
          if (!row) return { status: 'none' as const };
          const plain = crypto.open(await crypto.key(), fromHex(row.nonce), fromHex(row.box), stampAad(user));
          const stamp = plain ? (JSON.parse(decoder.decode(plain)) as Stamp) : null;
          return stamp && typeof stamp.homeId === 'string' && Number.isSafeInteger(stamp.leaseEpoch)
            ? { status: 'ok' as const, stamp }
            : { status: 'unreadable' as const };
        } catch {
          return { status: 'unreadable' as const };
        }
      }),
    /** Keeps the newest stamp for this account; a damaged container is never written over. */
    keepStamp: (user: string, stamp: Stamp): Promise<void> =>
      alone(async () => {
        const nonce = crypto.randomBytes(24);
        const box = crypto.seal(await crypto.key(), nonce, encoder.encode(JSON.stringify(stamp)), stampAad(user));
        const all = await rows();
        if (all === 'damaged') throw new Error('what is kept on this phone cannot be read');
        await write(all.rows, [...all.stamps.filter((r) => r.user !== user), { user, nonce: toHex(nonce), box: toHex(box) }]);
      }),
    clear: () => alone(() => store.clear()),
  };
}
export type HomeCache = ReturnType<typeof createHomeCache>;

type GuardRuntime = {
  snapshot(): { phase?: string; user?: { id: string } | null; pairs?: { pairId: string }[] };
  subscribe(listener: () => void): () => void;
};

/** Pairs are read from the vault once the app is out of `loading`; before that an empty list says nothing. */
const KNOWN = new Set(['signedOut', 'ready', 'pairing', 'offline', 'online', 'error']);

/**
 * Forgets what is kept for an account that signed out and for a computer that was unpaired, whether that happened while the app ran or while it
 * was closed: the first time the phone knows its account and computers it drops every row that belongs to neither.
 */
export function guardHomeCache(runtime: GuardRuntime, cache: Pick<HomeCache, 'forget'>): () => void {
  let user: string | undefined;
  let pairs = new Set<string>();
  let checked = false;
  const look = async () => {
    const snap = runtime.snapshot();
    const known = !snap.phase || KNOWN.has(snap.phase);
    const now = new Set((snap.pairs ?? []).map((p) => p.pairId));
    const signedOut = user !== undefined && !snap.user;
    const gone = new Set([...pairs].filter((p) => !now.has(p)));
    const first = known && !checked;
    const who = snap.user?.id;
    user = who;
    pairs = now;
    if (known) checked = true;
    if (signedOut || (first && !snap.user))
      await cache.forget(
        () => true,
        () => true,
      );
    else if (first)
      await cache.forget(
        (s) => s.user !== who || !now.has(s.pair),
        // an account's push row (`<user>|push`) goes with the account, never alone
        (u) => u.split('|')[0] !== who,
      );
    else if (gone.size) await cache.forget((s) => gone.has(s.pair));
  };
  void look();
  return runtime.subscribe(() => void look());
}
