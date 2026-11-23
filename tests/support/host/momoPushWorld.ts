// The world MoMo's push tests run in (host/src/momoPush.mjs over a real sealed store): phones, a relay that answers as the test says, a lease it can spoil, and a stamp sealed for each phone's own root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createMomoPush, pushShape } from '../../../host/src/momoPush.mjs';
// @ts-ignore
import { zonedParts } from '../../../host/src/momoClock.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../../../host/src/secretStore.mjs';
// @ts-ignore
import { createStampSeal } from '../../../shared/remote/stampSeal.mjs';
// @ts-ignore
import { createNodePrimitives } from '../../../shared/remote/nodePrimitives.mjs';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../../electron/gateway/sealedFile.cjs');

export const NY = 'America/New_York';
export const prim = createNodePrimitives();
export const stamps = createStampSeal(prim);
/** One pair root per phone, as each enrollment has its own. */
export const rootOf = (pairId: string) => new Uint8Array(32).fill(pairId === 'pair1' ? 1 : 2);
export const MIN = 60_000;

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

export function world(opts: { dir?: string; at?: number } = {}): any {
  let at = opts.at ?? wall(NY, '2026-11-23', '12:00');
  const sent: any[] = [];
  const reports: string[] = [];
  const phones = [
    { hostId: 'h1', pairId: 'pair1' },
    { hostId: 'h2', pairId: 'pair2' },
  ];
  const state = {
    status: (_h: string, _r: any) => 'sent' as any,
    stamp: { homeId: 'studio', leaseEpoch: 1 } as any,
    current: true,
    stale: false,
    allowed: true,
    linked: phones,
    settings: { previews: false, tellNowMax: 3, zone: NY, quiet: { start: 22 * 60, end: 8 * 60 } } as any,
    sealBody: undefined as any,
    boom: false,
    told: undefined as undefined | ((a: any) => any),
    untold: undefined as undefined | ((a: any) => any),
  };
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'momo-push-'));
  const make = () => {
    const file = new SealedJson({
      file: path.join(dir, 'push.json'),
      safeStorage: createFileSafeStorage(dir),
      shape: pushShape,
      now: () => at,
    });
    return createMomoPush({
      allowed: () => state.allowed,
      targets: () => state.linked,
      send: async (hostId: string, req: any) => {
        const status = state.status(hostId, req);
        if (status instanceof Error) throw status;
        if (req.kind === 'cleared' && status !== 'sent') throw new Error('relay refused the clearing');
        sent.push({ hostId, ...req });
        return status;
      },
      report: (m: string) => reports.push(m),
      now: () => at,
      store: { read: () => file.read(), change: (fn: any) => file.change(fn) },
      settings: () => state.settings,
      sealBody: state.sealBody ? (...a: any[]) => state.sealBody(...a) : undefined,
      claimTold: state.told ? (a: any) => state.told!(a) : undefined,
      releaseTold: state.untold ? (a: any) => state.untold!(a) : undefined,
      sealStamp: (t: any, ref: string, stamp: any) => {
        if (state.boom) throw new Error('crash');
        return stamps.seal({ key: stamps.stampKey(rootOf(t.pairId)), ref, ...stamp });
      },
      stamp: () => state.stamp,
      current: () => state.current,
      receive: async () => ({ ok: !state.stale }),
    });
  };
  return { push: make(), make, sent, reports, state, dir, set: (ms: number) => void (at = ms), now: () => at };
}
export const tick = () => new Promise((r) => setImmediate(r));
