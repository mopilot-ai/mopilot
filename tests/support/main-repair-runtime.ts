// Composes real ChatStarter metadata and input guards behind fake native transports for all repair harness families.
import { createRequire } from 'node:module';
import { claimHub } from './claim-hub.ts';
import { readClaim } from '../../shared/mainRedClaims.mjs';
import { reserveRepair, bindRepair } from '../../shared/mainRepairClaims.mjs';
const require = createRequire(import.meta.url);
const { createRepairRuntime } = require('../../electron/app/mainRepairRuntime.cjs');
const { ChatStarter } = require('../../electron/platform/chatStart.cjs');
const { assertInputReady } = require('../../electron/session/contract/inputGuard.cjs');
const { clock } = require('../../electron/platform/ports/clock.cjs');
export const SHA = 'a'.repeat(40);
export function nativeRepairWorld(harness = 'codex') {
  const calls: any[] = [],
    records = new Map<string, any>(),
    states = new Map<string, any>(),
    runtimes = new Map<string, any>();
  const add = (id: string, kind: string, nativeId: string) => {
    records.set(id, { meta: {}, segments: [{ kind, nativeId }] });
    states.set(id, { turn: 'idle', queue: [], activeTurn: null, progressAt: 0 });
    runtimes.set(id, {});
  };
  add('feature', harness, 'source');
  states.get('feature').activeTurn = { id: 'human', human: true };
  const controller: any = {
    state: { get: (id: string) => states.get(id) },
    rt: (id: string) => runtimes.get(id),
    ref: (id: string) => {
      const s = records.get(id).segments.at(-1);
      return { kind: s.kind, id: s.nativeId, key: `${s.kind}:${s.nativeId}` };
    },
    beforeDispatch: async () => undefined,
    start: async (chatId: string, item: any) => {
      Object.assign(runtimes.get(chatId), { token: 'pending', inputToken: `pending-${item.id}`, startAttempt: {} });
      await controller.beforeDispatch({ chatId, item });
      await assertInputReady(item);
      calls.push(['native', chatId, item]);
      return { started: true };
    },
    stopChat: async (id: string) => {
      calls.push(['stop', id]);
    },
  };
  const chats: any = {
    records,
    record: (id: string) => records.get(id),
    patchMeta: (id: string, patch: any) => {
      if (Object.entries(patch).every(([key, value]) => JSON.stringify(records.get(id).meta[key]) === JSON.stringify(value))) return false;
      Object.assign(records.get(id).meta, patch);
      return true;
    },
  };
  const live: any = { controller, chats, peerRuntime: { paused: new Set(), projectOf: async () => '/project' } };
  const policy = {
    repo: 'mopilot-ai/mopilot-internal',
    root: '/project',
    harness,
    generation: 'g',
    enabled: true,
    settings: { model: 'own', effort: 'medium', permission: 'default' },
  };
  const job: any = {
    id: 'reservation',
    repo: policy.repo,
    issue: 5,
    generation: 'g',
    phase: 'bound',
    briefId: 'stable-brief',
    ownedInputId: 'stable-brief',
  };
  const hub = claimHub();
  const held = () => readClaim({ gh: hub.gh, repo: policy.repo, issue: job.issue }) as any;
  reserveRepair({ gh: hub.gh, repo: policy.repo, issue: job.issue, reservation: job.id, coordinator: 'feature', now: clock.now() });
  live.mainRepair = {
    store: { data: { policies: { [policy.repo]: policy }, jobs: { [job.id]: job } } },
    o: { remote: async () => held() },
  };
  const starter = new ChatStarter({
    prefs: () => ({}),
    codexThread: async (args: any) => {
      calls.push(['codex', args]);
      add('worker', 'codex', 'worker');
      return { id: 'worker' };
    },
    claudeSession: (id: string, args: any) => {
      calls.push(['claude', args]);
      add(id, 'claude', id.slice(7));
    },
    acpSession: (id: string, args: any) => {
      calls.push(['acp', args]);
      add(id, 'acp:test', id.split(':').slice(2).join(':'));
    },
    chats,
    worktree: async (cwd: string, opts: any) => {
      calls.push(['worktree', cwd, opts]);
      return { ok: true, repo: '/project', worktree: '/prepared', path: '/prepared' };
    },
    script: async () => {
      throw new Error('No setup script exists in fixture');
    },
    started: (event: any) => {
      calls.push(['started', event, structuredClone(records.get(event.chatId).meta)]);
    },
  });
  live.orchestrator = {
    o: {
      starter,
      usable: async () => true,
      childOptions: async () => ({ ...policy.settings, additionalDirectories: ['/feature-notes'], account: 'own-account' }),
    },
  };
  const state: any = { origin: 'git@github.com:mopilot-ai/mopilot-internal.git', root: '/project', baseSha: SHA, ok: true };
  const git = async (args: string[], cwd: string) => {
    calls.push(['git', args, cwd]);
    return {
      ok: state.ok,
      stdout:
        args[0] === 'remote' ? state.origin : args.includes('--show-toplevel') ? state.root : args[0] === 'rev-parse' ? state.baseSha : '',
      stderr: '',
    };
  };
  const runtime = createRepairRuntime({ live, git, broadcast: (id: string) => calls.push(['broadcast', id]) });
  const prepare = runtime.prepare;
  runtime.prepare = async (...args: any[]) => {
    const made = await prepare(...args);
    bindRepair({
      gh: hub.gh,
      repo: policy.repo,
      issue: job.issue,
      reservation: job.id,
      from: held().sha,
      chatId: made.chatId,
      cwd: made.cwd,
      baseSha: made.baseSha,
      now: clock.now(),
    });
    return made;
  };
  return { live, runtime, calls, records, states, policy, job, state, git, hub, held, prepare };
}
