// The newest lease this window has seen for MoMo's home, kept across restarts (localStorage), and the sink that refuses an older one (shared/momoStamp.mjs, home lane S1): after the owner reclaims the home at a higher epoch, a late view, change or answer from the old home must not be believed.
import { createStampSink } from '../../../../shared/momoStamp.mjs';
import type { MomoView } from '../../../../shared/momoView';
import { noteIgnored } from '../../../lib/ignored';

const KEY = 'momo.home.newestLease';

type Stamp = { homeId: string; leaseEpoch: number };
type Kept = Stamp & { name: string | null; createdAt: number | null };

/** The name the machine had when its lease was kept (written with the lease, so it survives a restart); set just before the sink writes. */
let pendingName: string | null = null;
/** When the home that holds the newest lease was started, kept with it, set just before the sink writes. */
let pendingCreatedAt: number | null = null;

/** The small store the sink keeps its newest stamp in, with the home's name beside it; a window without storage remembers it until it closes. */
function store() {
  let memory: Kept | null = null;
  return {
    read(): Kept | null {
      try {
        const raw = globalThis.localStorage?.getItem(KEY);
        const v = raw ? JSON.parse(raw) : null;
        if (v && typeof v.homeId === 'string' && Number.isSafeInteger(v.leaseEpoch))
          return { ...v, name: typeof v.name === 'string' ? v.name : null, createdAt: Number.isFinite(v.createdAt) ? v.createdAt : null };
      } catch (error) {
        noteIgnored('read the newest MoMo lease', error);
      }
      return memory;
    },
    write(newest: Stamp) {
      memory = { ...newest, name: pendingName, createdAt: pendingCreatedAt };
      try {
        globalThis.localStorage?.setItem(KEY, JSON.stringify(memory));
      } catch (error) {
        noteIgnored('keep the newest MoMo lease', error);
      }
    },
    forget() {
      memory = null;
      try {
        globalThis.localStorage?.removeItem(KEY);
      } catch (error) {
        noteIgnored('forget the newest MoMo lease', error);
      }
    },
  };
}

const kept = store();
export const stampSink = createStampSink(kept);

/**
 * The lease is forgotten when the user explicitly makes a new home (the setup choice, a reset, Start fresh): a home made again starts
 * again at its first epoch, and an older lease must not refuse it forever.
 */
export function forgetLease() {
  kept.forget();
}

/** The stamp a view carries: its home's machine and lease; null while it has none (first run, or a machine that is not the home). */
export function stampOf(view: MomoView): Stamp | null {
  const { homeMachineId, leaseEpoch } = view.home;
  return homeMachineId && leaseEpoch ? { homeId: homeMachineId, leaseEpoch } : null;
}

/** The current home's name as the newest accepted view said it, kept across restarts, for "MoMo runs on <machine> now". */
export const currentHomeName = (): string | null => kept.read()?.name ?? null;

/**
 * A view this window may believe: the view itself, or null when it is from a home older than the newest seen (or two claimants of one
 * lease). A view with no stamp claims no home, so it is believed only before any home was seen, as this machine's own tombstone
 * ("MoMo moved to <machine>"), or as the first-run choice; a stale view sent mid-move has no stamp of its own and is refused.
 */
export function believe(view: MomoView): MomoView | null {
  const stamp = stampOf(view);
  if (!stamp) return !stampSink.newest() || view.home.movedAway || view.setup.step === 'where' ? view : null;
  const seen = kept.read();
  const createdAt = view.home.createdAt ?? null;
  // the same machine's home made anew (Reset, Start fresh, a reinstall) starts again: the lease of the home it replaced no longer binds it
  if (seen && seen.homeId === stamp.homeId && createdAt !== null && seen.createdAt !== null && createdAt !== seen.createdAt) kept.forget();
  pendingName = view.home.machineName ?? seen?.name ?? null;
  pendingCreatedAt = createdAt;
  return stampSink.accept(stamp).ok ? view : null;
}
