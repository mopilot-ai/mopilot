// Drives the production repository tools through durable authority, CAS claims, fresh native chats and app restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nativeRepairWorld } from './support/main-repair-runtime.ts';
import { useFakeClock } from './support/ports/clock.ts';
import { readClaim } from '../shared/mainRedClaims.mjs';
import { reserveRepair, bindRepair, heartbeatRepair, releaseRepair } from '../shared/mainRepairClaims.mjs';
const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/mainRepair.cjs');
const { MainRepairStore } = require('../electron/session/mainRepair/store.cjs');
const { registerMainRepairTools } = require('../electron/capabilities/tools/mainRepair.cjs');
const { ownerOf, segmentKey } = require('../electron/platform/segmentOwner.cjs');
function appWorld(kind: string) {
  const f = nativeRepairWorld(kind),
    app = new EventEmitter(),
    requests: any[] = [];
  f.hub.refs.clear();
  f.runtime.prepare = f.prepare;
  let saved: string | null = null,
    recovered = false,
    closed = 0;
  const store = new MainRepairStore({
    file: '/fixture/state',
    read: () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    write: (d: any) => {
      saved = JSON.stringify(d);
    },
  });
  const github = {
    request: async (op: string, p: any) => {
      requests.push([op, p]);
      const options = { ...p, gh: f.hub.gh };
      if (op === 'read') return readClaim(options);
      if (op === 'observe')
        return [
          {
            issue: 5,
            context: 'main-e2e',
            failedSha: 'a'.repeat(40),
            url: 'https://github.com/mopilot-ai/mopilot-internal/issues/5',
            runUrl: 'https://github.com/mopilot-ai/mopilot-code-release/actions/runs/8',
          },
        ];
      if (op === 'inspect') return { claim: readClaim(options), recovered, merged: false, liveCI: false, pr: null, superseded: false };
      return ({ reserve: reserveRepair, bind: bindRepair, heartbeat: heartbeatRepair, release: releaseRepair } as any)[op](options);
    },
    close: () => {
      closed++;
    },
  };
  const service = register(null, { app, live: f.live, broadcastAll: () => undefined }, { store, github, runtime: f.runtime });
  const tools = new Map<string, any>();
  let removed = 0;
  const dispose = registerMainRepairTools(
    {
      register: (s: any) => {
        tools.set(s.name, s);
        return () => removed++;
      },
    },
    { owner: (ctx: any) => ownerOf(f.records, ctx, { current: true }), service: () => service.api },
  );
  const ctx = { chatId: 'feature', segmentId: segmentKey(kind, 'source') };
  return {
    ...f,
    app,
    store,
    service,
    tools,
    ctx,
    requests,
    github,
    dispose,
    counts: () => ({ removed, closed }),
    saved: () => saved!,
    recover: () => {
      recovered = true;
    },
  };
}
test('current user authority creates one isolated worker on every harness and survives without the feature conversation', async (t) => {
  useFakeClock(t, Date.now());
  for (const kind of ['codex', 'claude', 'acp:test']) {
    const f = appWorld(kind);
    t.after(() => f.app.emit('will-quit'));
    const before = await f.tools.get('get_main_repair').handler({}, f.ctx);
    assert.equal(before.policy, null);
    await assert.rejects(f.tools.get('request_main_repair').handler({}, f.ctx), /not been authorized/);
    const configured = await f.tools.get('configure_main_repair').handler({ enabled: true }, f.ctx);
    assert.equal(configured.policy.harness, kind);
    await f.service.tick();
    const job = Object.values(f.store.data.jobs)[0] as any;
    assert.equal(job.phase, 'running');
    assert.equal(f.calls.filter((c) => c[0] === 'native').length, 1);
    assert.ok(!JSON.stringify(f.store.data).includes('feature-notes'));
    const status = await f.tools.get('request_main_repair').handler({}, f.ctx);
    assert.equal(status.requested, true);
    await f.service.tick();
    assert.equal(f.calls.filter((c) => c[0] === 'native').length, 1);
    f.states.get(job.chatId).activeTurn = { id: 'owned-turn', human: false };
    assert.equal(f.service.api.monitorOwner(job.chatId), job.id);
    f.service.api.monitorInput(job.chatId, { id: 'follow-up' }, job.id);
    f.live.controller.onDispatchResult({ chatId: job.chatId, item: { id: 'follow-up' }, result: { started: true, turnId: 'owned-turn' } });
    assert.equal(f.store.data.jobs[job.id].turnId, 'owned-turn');
    f.service.api.monitorInput(job.chatId, { id: 'unowned' }, null);
    assert.throws(() => f.service.api.monitorInput(job.chatId, { id: 'bad' }, 'other-owner'), /no longer owns/);
    f.states.get(job.chatId).activeTurn.userEngaged = true;
    assert.equal(f.service.api.monitorOwner(job.chatId), null);
    f.recover();
    await f.service.tick();
    assert.equal(f.store.data.jobs[job.id].phase, 'complete');
    await f.tools.get('configure_main_repair').handler({ enabled: false }, f.ctx);
    await f.service.tick();
    assert.equal(f.store.data.policies[f.policy.repo].enabled, false);
    const restarted = new MainRepairStore({ file: '/fixture/state', read: f.saved });
    assert.equal(restarted.snapshot().jobs[job.id].phase, 'complete');
    f.dispose();
    assert.equal(f.counts().removed, 3);
    f.app.emit('will-quit');
    assert.ok(f.counts().closed >= 1);
  }
});
test('stale segments, automatic turns, unsupported repositories and unavailable services cannot enable authority', async (t) => {
  useFakeClock(t, 1000);
  const f = appWorld('codex');
  t.after(() => f.app.emit('will-quit'));
  await assert.rejects(
    f.tools.get('configure_main_repair').handler({ enabled: true }, { chatId: 'feature', segmentId: 'stale' }),
    /does not own/,
  );
  await assert.rejects(f.service.api.configure('feature', { enabled: true }, { chatId: 'feature', segmentId: 'stale' }), /segment changed/);
  await assert.rejects(f.service.api.status('missing', {}, { chatId: 'missing', segmentId: 'stale' }), /segment changed/);
  f.records.get('feature').meta.momo = 'main';
  await assert.rejects(f.service.api.configure('feature', { enabled: true }, f.ctx), /unavailable in this chat/);
  delete f.records.get('feature').meta.momo;
  f.states.get('feature').activeTurn.human = false;
  await assert.rejects(f.tools.get('configure_main_repair').handler({ enabled: true }, f.ctx), /current turn/);
  f.states.get('feature').activeTurn.human = true;
  f.state.origin = 'git@github.com:other/repo.git';
  await assert.rejects(f.tools.get('configure_main_repair').handler({ enabled: true }, f.ctx), /supported main-red/);
  const tools = new Map<string, any>();
  registerMainRepairTools(
    {
      register: (s: any) => {
        tools.set(s.name, s);
        return () => undefined;
      },
    },
    { owner: () => 'feature', service: () => null },
  );
  await assert.rejects(tools.get('get_main_repair').handler({}, {}), /not ready/);
  assert.equal(Object.keys(f.store.data.policies).length, 0);
});

test('default startup persists the coordinator and publishes a guarded native brief without any GitHub request', async (t) => {
  const clock = useFakeClock(t, Date.now()),
    f = nativeRepairWorld();
  Object.assign(f.job, await f.runtime.prepare(f.policy, f.job, () => true));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repair-app-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:mopilot-ai/mopilot-internal.git']);
  const app = Object.assign(new EventEmitter(), { getPath: () => dir }),
    broadcasts: any[] = [];
  f.live.chats.get = (id: string) => f.records.get(id);
  const service = register(null, { app, live: f.live, broadcastAll: (...args: any[]) => broadcasts.push(args) });
  t.after(() => app.emit('will-quit'));
  service.configure({ ...f.policy, root: dir, authorizedBy: 'feature' });
  f.job.generation = service.store.data.policies[f.policy.repo].generation;
  Object.assign(f.job, { context: 'main-e2e', failedSha: 'a'.repeat(40), createdAt: clock.now(), updatedAt: clock.now() });
  service.store.change((d: any) => {
    d.jobs[f.job.id] = f.job;
  });
  service.o.remote = async () => f.held();
  assert.equal((await service.o.deliver(f.job, 'assigned brief', () => true)).accepted, true);
  assert.equal(broadcasts[0][0], 'chats:changed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'main-repairs.json'), 'utf8')).jobs[f.job.id].ownedInputId, f.job.briefId);
  service.tick = async () => {
    throw new Error('unreadable startup state');
  };
  clock.advance(0);
  await Promise.resolve();
  await Promise.resolve();
  assert.match(service.errors.get('startup'), /Unreadable startup state/);
});

test('grant changes during repository resolution are rejected, and disabling before a prior grant remains explicit', async (t) => {
  useFakeClock(t, Date.now());
  const f = appWorld('codex');
  t.after(() => f.app.emit('will-quit'));
  assert.equal((await f.service.api.configure('feature', { enabled: false }, f.ctx)).policy.enabled, false);
  const settings = f.runtime.settings;
  f.runtime.settings = async (id: string, current: () => boolean) => {
    const found = await settings(id, current);
    f.states.get(id).activeTurn = { human: true, id: 'replacement' };
    return found;
  };
  await assert.rejects(f.service.api.configure('feature', { enabled: true }, f.ctx), /request changed/);
  assert.equal(f.store.data.policies[f.policy.repo].enabled, false);
});

test('turn receipts and monitor ownership fail visibly when storage or job identity changes', async (t) => {
  useFakeClock(t, Date.now());
  const f = appWorld('codex');
  t.after(() => f.app.emit('will-quit'));
  await f.service.api.configure('feature', { enabled: true }, f.ctx);
  await f.service.tick();
  const job = Object.values(f.store.data.jobs)[0] as any;
  const change = f.store.change;
  f.store.change = () => {
    throw new Error('disk unavailable');
  };
  f.live.controller.onDispatchResult({ chatId: job.chatId, item: { id: job.ownedInputId }, result: { started: true, turnId: 'native' } });
  assert.match(f.service.errors.get(job.repo), /Disk unavailable/);
  f.store.change = change;
  assert.equal(f.service.api.monitorOwner('feature'), null);
  f.records.get(job.chatId).meta.mainRepair.reservation = 'missing';
  assert.equal(f.service.api.monitorOwner(job.chatId), null);
  f.records.get(job.chatId).meta.mainRepair.reservation = job.id;
  job.chatId = 'replacement';
  assert.equal(f.service.api.monitorOwner('worker'), null);
  job.chatId = 'worker';
  job.phase = 'complete';
  assert.equal(f.service.api.monitorOwner(job.chatId), null);
  job.phase = 'running';
  delete f.store.data.policies[job.repo];
  assert.equal(f.service.api.monitorOwner(job.chatId), null);
});
