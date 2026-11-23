// Types for shared/momoStamp.mjs: the sink that refuses a stamp older than the newest lease seen.
export type Stamp = { homeId: string; leaseEpoch: number };
export type StampStore = { read: () => Stamp | null; write: (newest: Stamp) => void };
export function createStampSink(store: StampStore): {
  accept(stamp: unknown): { ok: true } | { ok: false; reason: 'not-a-stamp' | 'stale' | 'two-homes'; newest: Stamp | null };
  newest(): Stamp | null;
};
