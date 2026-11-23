// Drives the real repair coordinator and claim protocol with durable snapshots and controllable runtime boundaries.
import { createRequire } from 'node:module';
import { claimHub } from './claim-hub.ts';
import { readClaim } from '../../shared/mainRedClaims.mjs';
import { reserveRepair, bindRepair, heartbeatRepair, releaseRepair } from '../../shared/mainRepairClaims.mjs';
const require = createRequire(import.meta.url);
const { MainRepairStore } = require('../../electron/session/mainRepair/store.cjs');
const { MainRepair } = require('../../electron/session/mainRepair/service.cjs');
const { clock } = require('../../electron/platform/ports/clock.cjs');
export const SHA = 'a'.repeat(40);
export function repairWorld(over: any = {}) {
  const hub = claimHub(),
    calls: any[] = [];
  let saved: string | null = null;
  const store = new MainRepairStore({
    file: '/state/main-repair.json',
    read: () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    write: (d: any) => {
      saved = JSON.stringify(d);
    },
  });
  const state: any = { activity: 'working', recovered: false, superseded: false, liveCI: false, merged: false, pr: null };
  const held = () => readClaim({ gh: hub.gh, repo: 'o/r', issue: 5 }) as any;
  const remote = async (op: string, args: any) => {
    calls.push([op, args]);
    const opts = { ...args, gh: hub.gh, now: clock.now() };
    return op === 'read'
      ? readClaim(opts)
      : ({ reserve: reserveRepair, bind: bindRepair, heartbeat: heartbeatRepair, release: releaseRepair } as any)[op](opts);
  };
  const incident = {
    issue: 5,
    context: 'main-e2e',
    failedSha: SHA,
    url: 'https://github.com/o/r/issues/5',
    runUrl: 'https://github.com/o/rel/actions/runs/1',
  };
  const options: any = {
    store,
    remote,
    observe: async () => [incident],
    findPrepared: async () => null,
    prepare: async () => {
      calls.push(['prepare']);
      return { chatId: 'worker', cwd: '/repair', baseSha: SHA };
    },
    inspect: async () => ({ ...state, claim: held() }),
    assertScope: async () => {
      calls.push(['scope']);
    },
    deliver: async (job: any, text: string, current: () => boolean) => {
      calls.push(['deliver', job, text, current()]);
      return { accepted: true };
    },
    activity: () => state.activity,
    stop: async (job: any) => {
      calls.push(['stop', job]);
    },
    ...over,
  };
  const service = new MainRepair(options);
  const policy = { repo: 'o/r', root: '/project', enabled: true, harness: 'codex', settings: {}, authorizedBy: 'feature' };
  service.configure(policy);
  const job = () => Object.values(store.data.jobs).at(-1) as any;
  const restart = () =>
    new MainRepair({
      ...options,
      store: new MainRepairStore({
        file: '/state/main-repair.json',
        read: () => saved!,
        write: (d: any) => {
          saved = JSON.stringify(d);
        },
      }),
    });
  return { hub, calls, store, state, held, options, service, policy, job, restart, incident };
}
