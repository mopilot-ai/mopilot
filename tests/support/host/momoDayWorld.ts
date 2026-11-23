// The world MoMo's day tests run in (host/src/momoDaily.mjs over a real sealed ledger): a clock the test moves by hand, a lease it can spoil, and seams that record what the notice lane would be asked to do.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoDaily } from '../../../host/src/momoDaily.mjs';
// @ts-ignore
import { zonedParts } from '../../../host/src/momoClock.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../../../host/src/secretStore.mjs';

export const NY = 'America/New_York';
export const MIN = 60_000;

/** The instant the wall clock of `zone` reads `hhmm` on `day` (the first such instant; none on a skipped time gives the next minute that exists). */
export function wall(zone: string, day: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = day.split('-').map(Number);
  let t = Date.UTC(y, mo - 1, d, 0, 0) - 14 * 60 * MIN;
  for (let i = 0; i < 50 * 60; i++, t += MIN) {
    const p = zonedParts(t, zone);
    if (p.day === day && p.minutes >= h * 60 + m) return t;
  }
  throw new Error('no such time');
}

export function world(opts: { dir?: string; start?: number } = {}): any {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'momo-daily-'));
  let at = opts.start ?? wall(NY, '2026-11-23', '07:00');
  let lease = { homeId: 'studio', leaseEpoch: 1 } as { homeId: string; leaseEpoch: number } | null;
  let current = true;
  let stale = false;
  const calls = {
    build: [] as any[],
    word: [] as any[],
    deliver: [] as any[],
    catchUp: [] as any[],
    tidy: [] as any[],
    claim: [] as any[],
  };
  const reports: string[] = [];
  const state = {
    settings: { on: true, paused: false, time: '08:00', zone: NY, quiet: { start: 22 * 60, end: 8 * 60 } } as any,
    build: (a: any) => ({ text: `plain brief ${a.day}` }) as any,
    word: (b: any) => `worded ${b.text}` as any,
    deliver: (_a: any) => undefined as any,
    catchUp: (_a: any) => undefined as any,
    claimBrief: undefined as undefined | ((a: any) => boolean),
    active: undefined as undefined | (() => boolean),
    changed: false,
    tidyRun: (_a: any) => undefined as any,
    tidyChanged: (_ms: number) => state.changed as any,
  };
  const make = () =>
    createMomoDaily({
      home: {
        stamp: () => lease,
        current: (s: any) => current && !!lease && s.leaseEpoch === lease.leaseEpoch,
        receiveStamp: async () => ({ ok: !stale }),
        storage: { dir },
        data: { safeStorage: createFileSafeStorage(dir) },
      },
      settings: () => state.settings,
      now: () => at,
      report: (m: string) => reports.push(m),
      seams: {
        build: (a: any) => (calls.build.push(a), state.build(a)),
        word: (b: any, a: any) => (calls.word.push([b, a]), state.word(b)),
        deliver: (a: any) => (calls.deliver.push(a), state.deliver(a)),
        catchUp: (a: any) => (calls.catchUp.push(a), state.catchUp(a)),
        claimBrief: state.claimBrief ? (a: any) => (calls.claim.push(a), state.claimBrief!(a)) : undefined,
        active: state.active,
        tidy: {
          changedSince: (ms: number) => state.tidyChanged(ms),
          run: (a: any) => (calls.tidy.push(a), state.tidyRun(a)),
        },
      },
    });
  return {
    dir,
    calls,
    reports,
    state,
    daily: make(),
    make,
    set: (ms: number) => void (at = ms),
    /** Awake time: tick every five minutes (a Host that is up) until `to`, and say what was done. */
    async walk(to: number, daily = this.daily) {
      const did: string[] = [];
      while (at < to) {
        at = Math.min(at + 5 * MIN, to);
        did.push(...(await daily.tick()).did);
      }
      return did;
    },
    advance: (ms: number) => void (at += ms),
    now: () => at,
    setLease: (l: typeof lease) => void (lease = l),
    setCurrent: (v: boolean) => void (current = v),
    setStale: (v: boolean) => void (stale = v),
  };
}
