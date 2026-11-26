// What the phone-composed home keeps between runs, sealed on the phone for one account: the highest lease seen on any Host, the older MoMos the owner chose to keep, where MoMo was last seen to live, the outbox of messages typed while the home was away, and the messages already sent. The shared home reads them in one step, so they are held in memory and written behind, one write at a time. What is kept and cannot be read is never written over: the home starts without it and says so.
import { fromHex, toHex } from '../../../../shared/remote/envelope.mjs';
import type { HomeNote } from '../../../../shared/momoHomeLook.mjs';
import type { CacheCrypto, CacheStore } from '../../momo/cache';

export type { HomeNote };

export type OutboxEntry = {
  turnId: string;
  chatId: string;
  text: string;
  createdAt: number;
  delivery: 'not-sent' | 'sent-uncertain';
  homeId?: string;
  renewedAt?: number;
  refusal?: string;
};
export type Sent = { id: string; text: string; at: number };
export type Kept = {
  seen: number;
  kept: string[];
  home: HomeNote | null;
  outbox: OutboxEntry[];
  sent: Sent[] /** When a Mac last said the account may see MoMo (ms), 0 when it never did. */;
  invited: number;
};

const empty = (): Kept => ({ seen: 0, kept: [], home: null, outbox: [], sent: [], invited: 0 });
/** A hint that the account was allowed lasts as long as a grant does: 7 days. It is renewed when a Mac says so again, at most once an hour. */
export const INVITED_MS = 7 * 24 * 3_600_000;
const RENEW_MS = 3_600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const aad = (user: string) => `momo-phone-home:${user}`;

/** What a sealed row holds, as far as it can be trusted: a field that is not what it should be is as if it were never kept. */
function readKept(value: unknown): Kept {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const list = <T>(x: unknown, ok: (e: unknown) => boolean) => (Array.isArray(x) ? (x.filter(ok) as T[]) : []);
  const obj = (e: unknown): e is Record<string, unknown> => !!e && typeof e === 'object';
  return {
    seen: Number.isSafeInteger(v.seen) && (v.seen as number) > 0 ? (v.seen as number) : 0,
    kept: list<string>(v.kept, (e) => typeof e === 'string'),
    // a home is named by its id; the machine it is on may not be known (null)
    home:
      obj(v.home) && typeof v.home.homeId === 'string' && (v.home.machineId === null || typeof v.home.machineId === 'string')
        ? (v.home as HomeNote)
        : null,
    outbox: list<OutboxEntry>(v.outbox, (e) => obj(e) && typeof e.turnId === 'string' && typeof e.text === 'string'),
    sent: list<Sent>(v.sent, (e) => obj(e) && typeof e.id === 'string' && typeof e.text === 'string'),
    invited: Number.isSafeInteger(v.invited) && (v.invited as number) > 0 ? (v.invited as number) : 0,
  };
}

/**
 * @param o.store the sealed row's container (one row for the phone)
 * @param o.crypto the phone's sealing
 * @param o.user the account the row belongs to: another account's row is not read
 * @param o.report told of a write that failed (the home goes on with what it holds in memory)
 */
export async function openPhoneHomeMemory(o: {
  store: CacheStore;
  crypto: CacheCrypto;
  user: string;
  report?: (error: unknown) => void;
  now?: () => number;
}) {
  const now = o.now ?? Date.now;
  let state = empty();
  /** True when something was kept for this account and could not be read: it is never written over. */
  let unreadable = false;
  const raw = await o.store.read().catch(() => 'unreadable' as const);
  if (raw === 'unreadable') unreadable = true;
  else if (raw !== null) {
    try {
      const row = JSON.parse(raw) as { user?: string; nonce?: string; box?: string };
      if (row.user === o.user) {
        const plain = o.crypto.open(await o.crypto.key(), fromHex(String(row.nonce)), fromHex(String(row.box)), aad(o.user));
        if (plain) state = readKept(JSON.parse(decoder.decode(plain)));
        else unreadable = true;
      }
    } catch {
      unreadable = true;
    }
  }
  /** Writes go one after another; the last one wins and carries everything before it. */
  let line: Promise<unknown> = Promise.resolve();
  const persist = () => {
    if (unreadable) return;
    const snapshot = JSON.stringify(state);
    line = line
      .then(async () => {
        const nonce = o.crypto.randomBytes(24);
        const box = o.crypto.seal(await o.crypto.key(), nonce, encoder.encode(snapshot), aad(o.user));
        await o.store.write(JSON.stringify({ user: o.user, nonce: toHex(nonce), box: toHex(box) }));
      })
      .catch((error) => o.report?.(error));
  };
  const keep = <K extends keyof Kept>(key: K, value: Kept[K]) => {
    state = { ...state, [key]: value };
    persist();
  };
  return {
    /** Something was kept for this account and cannot be read: nothing new is kept until it is discarded. */
    get unreadable() {
      return unreadable;
    },
    /** The owner's choice to delete what cannot be read: the container is cleared, and what the home holds from now on is kept again. */
    async discard() {
      state = empty();
      await line;
      await o.store.clear();
      unreadable = false;
    },
    /** The highest lease seen on any Host. */
    seen: { read: () => state.seen, write: (n: number) => keep('seen', n) },
    kept: { read: () => [...state.kept], write: (k: string[]) => keep('kept', [...k]) },
    memory: { read: () => state.home, write: (h: HomeNote | null) => keep('home', h) },
    outbox: {
      read: () => state.outbox.map((e) => ({ ...e })),
      write: (e: OutboxEntry[]) =>
        keep(
          'outbox',
          e.map((x) => ({ ...x })),
        ),
    },
    /** Whether a Mac last said this account may see MoMo: what the phone goes by when no Mac answers. */
    invited: {
      read: () => state.invited > 0 && now() - state.invited < INVITED_MS,
      /** What a Mac just said of the account: yes is kept (and renewed), no takes the hint away. A hint only: the Host decides. */
      set(yes: boolean) {
        if (yes) {
          if (state.invited === 0 || now() - state.invited >= RENEW_MS) keep('invited', now());
        } else if (state.invited !== 0) keep('invited', 0);
      },
    },
    sent: {
      read: () => state.sent.map((e) => ({ ...e })),
      write: (e: Sent[]) =>
        keep(
          'sent',
          e.map((x) => ({ ...x })),
        ),
    },
    /** Every write made so far has finished. */
    settled: () => line.then(() => undefined),
    /** Whether the phone has ever learned where MoMo lives or how new a lease it has seen. Nothing known: it may live on a machine this phone cannot see. */
    known: () => state.seen > 0 || state.home !== null,
    /**
     * What a Mac that answers says of the home (its machine, name and lease): the highest lease and where MoMo was last seen are kept here, so the phone
     * never starts below a lease a Mac has seen and knows MoMo has a home it cannot reach. A newer or first note replaces; an older one never does.
     */
    learn(h: { machineId: string | null; homeId: string; name: string; leaseEpoch: number }) {
      if (h.leaseEpoch > state.seen) keep('seen', h.leaseEpoch);
      const now = state.home;
      // a newer lease replaces the note; at the same lease, a note that does not name the home yet is made whole, one that does is never replaced
      if (!now || now.leaseEpoch < h.leaseEpoch || (now.leaseEpoch === h.leaseEpoch && now.homeId === ''))
        keep('home', { machineId: h.machineId, homeId: h.homeId, leaseEpoch: h.leaseEpoch, name: h.name, lineage: [] });
    },
    /** Sign-out or Reset: nothing is kept for the account any more. */
    async forget() {
      state = empty();
      unreadable = false;
      await line;
      await o.store.clear();
    },
  };
}
