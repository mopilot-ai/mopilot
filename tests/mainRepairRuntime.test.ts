// Verifies fresh worker preparation, current-segment authority and native-send fences on Codex, Claude and ACP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { nativeRepairWorld, SHA } from './support/main-repair-runtime.ts';
import { useFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { githubRepo } = require('../electron/app/mainRepairRuntime.cjs');
const { assertInputReady } = require('../electron/session/contract/inputGuard.cjs');

test('each native harness gets a fresh tagged conversation in an exact fetched-main worktree, without parent notes', async () => {
  for (const kind of ['codex', 'claude', 'acp:test']) {
    const f = nativeRepairWorld(kind);
    const current = f.runtime.grant('feature'),
      selected = await f.runtime.settings('feature', current);
    assert.equal(selected.harness, kind);
    assert.ok(!('additionalDirectories' in selected.settings));
    Object.assign(f.policy.settings, selected.settings);
    const worker = await f.runtime.prepare(f.policy, f.job, current);
    Object.assign(f.job, worker);
    assert.equal(worker.baseSha, SHA);
    assert.equal(worker.cwd, '/prepared');
    assert.equal(f.calls.find((c) => c[0] === 'worktree')[2].baseCommit, SHA);
    assert.ok(
      f.calls.some(
        (c) => c[0] === 'git' && c[1].join(' ') === 'fetch --no-write-fetch-head origin refs/heads/main:refs/remotes/origin/main',
      ),
    );
    assert.equal(f.calls.find((c) => c[0] === 'started')[2].mainRepair.reservation, f.job.id);
    assert.deepEqual(await f.runtime.findPrepared(f.job), worker);
    assert.deepEqual(await f.runtime.deliver(f.job, 'assigned brief only', current), {
      accepted: true,
      error: undefined,
      turnId: undefined,
    });
    const item = f.calls.find((c) => c[0] === 'native')[2];
    assert.equal(item.id, f.job.briefId);
    assert.equal(item.opts.human, false);
    assert.equal(item.text, 'assigned brief only');
    assert.equal(f.runtime.activity(f.job), 'idle');
    assert.throws(() => f.runtime.grant(worker.chatId), /repair worker/);
  }
});

test('automatic input, changed user turns, missing projects and changed origins cannot authorize or prepare repairs', async () => {
  const f = nativeRepairWorld();
  f.states.get('feature').activeTurn.human = false;
  assert.throws(() => f.runtime.grant('feature'), /current turn/);
  f.states.get('feature').activeTurn.human = true;
  const current = f.runtime.grant('feature');
  f.states.get('feature').activeTurn = { human: true };
  await assert.rejects(f.runtime.settings('feature', current), /request changed/);
  f.live.peerRuntime.projectOf = async () => null;
  await assert.rejects(f.runtime.scope('feature'), /no repository/);
  f.live.peerRuntime.projectOf = async () => '/project';
  f.state.origin = 'https://evil.example/o/r';
  await assert.rejects(f.runtime.scope('feature'), /GitHub origin/);
  await assert.rejects(f.runtime.assertScope(f.policy), /authorized repository changed/i);
  f.state.ok = false;
  await assert.rejects(f.runtime.assertScope(f.policy), /Could not verify/);
});

test('preparation stops after revoked authority, bad main SHAs, unavailable adapters or failed worktree creation', async () => {
  const f = nativeRepairWorld();
  await assert.rejects(
    f.runtime.prepare(f.policy, f.job, () => false),
    /cancelled/,
  );
  f.state.baseSha = 'local-main';
  await assert.rejects(
    f.runtime.prepare(f.policy, f.job, () => true),
    /unreadable/,
  );
  f.state.baseSha = SHA;
  f.live.orchestrator.o.usable = async () => false;
  await assert.rejects(
    f.runtime.prepare(f.policy, f.job, () => true),
    /unavailable/,
  );
  f.live.orchestrator.o.usable = async () => true;
  f.live.orchestrator.o.starter.newWorktree = async () => null;
  await assert.rejects(
    f.runtime.prepare(f.policy, f.job, () => true),
    /could not be prepared/,
  );
  f.policy.harness = 'unknown';
  await assert.rejects(
    f.runtime.prepare(f.policy, f.job, () => true),
    /Unknown harness/,
  );
});

test('a revoked generation at the actual send boundary prevents native work and preserves the chat', async () => {
  const f = nativeRepairWorld();
  const made = await f.runtime.prepare(f.policy, f.job, () => true);
  Object.assign(f.job, made);
  const start = f.live.controller.start;
  f.live.controller.start = async (id: string, item: any) => {
    f.policy.enabled = false;
    return start(id, item);
  };
  await assert.rejects(
    f.runtime.deliver(f.job, 'brief', () => f.policy.enabled),
    /no longer owns/,
  );
  assert.equal(
    f.calls.some((c) => c[0] === 'native'),
    false,
  );
  assert.ok(f.records.has(made.chatId));
});

test('guarded send refusal and uncertain native replies are distinct, and automatic wakes honor retired ownership', async () => {
  const f = nativeRepairWorld();
  Object.assign(f.job, await f.runtime.prepare(f.policy, f.job, () => true));
  f.states.get(f.job.chatId).turn = 'running';
  assert.equal((await f.runtime.deliver(f.job, 'brief', () => true)).accepted, false);
  f.states.get(f.job.chatId).turn = 'idle';
  f.live.controller.start = async (chatId: string, item: any) => {
    await f.live.controller.beforeDispatch({ chatId, item });
    return { started: false, error: 'ack lost' };
  };
  assert.equal((await f.runtime.deliver(f.job, 'brief', () => true)).accepted, null);
  f.live.controller.start = async () => ({ started: false, error: 'refused' });
  assert.equal((await f.runtime.deliver(f.job, 'brief', () => true)).accepted, false);
  f.job.phase = 'lost';
  await assert.rejects(
    f.live.controller.beforeDispatch({ chatId: f.job.chatId, item: { id: 'other-wake', opts: { human: false } } }),
    /no longer owns/,
  );
  await f.live.controller.beforeDispatch({ chatId: f.job.chatId, item: { id: 'human', opts: { human: true } } });
});

test('activity uses fresh native progress, and cancellation stops only automatic turns and their PR monitor', async (t) => {
  const clock = useFakeClock(t, 1000),
    f = nativeRepairWorld();
  Object.assign(f.job, await f.runtime.prepare(f.policy, f.job, () => true));
  const state = f.states.get(f.job.chatId);
  f.job.turnId = 'owned';
  state.activeTurn = { id: 'owned', human: false };
  state.progressAt = clock.now();
  assert.equal(f.runtime.activity(f.job), 'working');
  clock.advance(20 * 60_000);
  assert.equal(f.runtime.activity(f.job), 'idle');
  f.live.peerRuntime.paused.add(f.job.chatId);
  assert.equal(f.runtime.activity(f.job), 'paused');
  f.job.turnId = 'owned';
  state.activeTurn.id = 'owned';
  const monitors: any[] = [];
  f.live.prMonitor = {
    snapshot: () => ({ url: 'https://github.com/o/r/pull/7', owner: f.job.id }),
    configure: (...a: any[]) => monitors.push(a),
  };
  await f.runtime.stop(f.job);
  assert.equal(f.calls.filter((c) => c[0] === 'stop').length, 1);
  assert.equal(monitors[0][1].autoFix, false);
  state.activeTurn.human = true;
  assert.equal(f.runtime.activity(f.job), 'user');
  await f.runtime.stop(f.job);
  assert.equal(f.calls.filter((c) => c[0] === 'stop').length, 1);
});

test('prepared identities cannot be duplicated or rebound across repositories, and GitHub origin parsing is exact', async () => {
  const f = nativeRepairWorld();
  assert.equal(await f.runtime.findPrepared(f.job), null);
  const made = await f.runtime.prepare(f.policy, f.job, () => true);
  const record = f.records.get(made.chatId);
  f.records.set('momo-copy', { ...record, meta: { ...record.meta, momo: 'main' } });
  assert.deepEqual(await f.runtime.findPrepared(f.job), made);
  record.meta.mainRepair.repo = 'other/repo';
  await assert.rejects(f.runtime.findPrepared(f.job), /unreadable/);
  f.records.set('duplicate', record);
  await assert.rejects(f.runtime.findPrepared(f.job), /More than one/);
  assert.equal(githubRepo('https://github.com/MoPilot-ai/MoPilot-internal.git'), 'mopilot-ai/mopilot-internal');
  assert.equal(githubRepo('ssh://git@github.com/o/r.git/'), 'o/r');
  assert.equal(githubRepo('https://github.com.evil/o/r'), null);
});

test('cancellation preserves a replacement monitor, unrelated automatic turn and a user-steered takeover', async () => {
  const f = nativeRepairWorld();
  Object.assign(f.job, await f.runtime.prepare(f.policy, f.job, () => true));
  const changes: any[] = [];
  f.live.prMonitor = {
    snapshot: () => ({ url: 'https://github.com/mopilot-ai/mopilot-internal/pull/99', owner: 'replacement' }),
    configure: (...a: any[]) => changes.push(a),
  };
  f.job.pr = 7;
  f.job.turnId = 'owned';
  f.states.get(f.job.chatId).activeTurn = { id: 'unrelated', human: false };
  await f.runtime.stop(f.job);
  assert.equal(changes.length, 0);
  assert.equal(
    f.calls.some((c) => c[0] === 'stop'),
    false,
  );
  f.states.get(f.job.chatId).activeTurn = { id: 'owned', human: false, userEngaged: true };
  assert.equal(f.runtime.activity(f.job), 'user');
  await f.runtime.stop(f.job);
  assert.equal(
    f.calls.some((c) => c[0] === 'stop'),
    false,
  );
});

test('brief persistence failure and authority changes after repository readiness prevent native delivery', async () => {
  for (const mode of ['save-failure', 'revoke-after-scope']) {
    const f = nativeRepairWorld();
    Object.assign(f.job, await f.runtime.prepare(f.policy, f.job, () => true));
    if (mode === 'save-failure') {
      const patch = f.live.chats.patchMeta;
      let writes = 0;
      f.live.chats.patchMeta = (...args: any[]) => (++writes === 2 ? false : patch(...args));
      await assert.rejects(
        f.runtime.deliver(f.job, 'brief', () => true),
        /brief identity/,
      );
    } else {
      let checks = 0;
      await assert.rejects(
        f.runtime.deliver(f.job, 'brief', () => ++checks === 1),
        /authority changed before dispatch/,
      );
    }
    assert.equal(
      f.calls.some((c) => c[0] === 'native'),
      false,
    );
  }
});

test('a refused dispatch can reuse an already-saved brief identity on every harness', async (t) => {
  useFakeClock(t, 1000);
  for (const harness of ['codex', 'claude', 'acp:test']) {
    const f = nativeRepairWorld(harness);
    Object.assign(f.job, await f.runtime.prepare(f.policy, f.job, () => true));
    const start = f.live.controller.start;
    f.live.controller.start = async () => ({ started: false, error: 'not dispatched' });
    assert.equal((await f.runtime.deliver(f.job, 'brief', () => true)).accepted, false);
    const saved = structuredClone(f.records.get(f.job.chatId).meta.authored[f.job.briefId]);
    f.live.controller.start = start;
    assert.equal((await f.runtime.deliver(f.job, 'brief', () => true)).accepted, true);
    assert.deepEqual(f.records.get(f.job.chatId).meta.authored[f.job.briefId], saved);
    assert.equal(f.calls.filter((call) => call[0] === 'native').length, 1);
  }
});

test('automatic follow-ups reject unowned input and a changed grant after the claim read', async (t) => {
  const clock = useFakeClock(t, 1000),
    f = nativeRepairWorld();
  Object.assign(f.job, await f.runtime.prepare(f.policy, f.job, () => true));
  await assert.rejects(
    f.live.controller.beforeDispatch({ chatId: f.job.chatId, item: { id: 'unowned', opts: { human: false } } }),
    /does not belong/,
  );
  const item = { id: f.job.ownedInputId, opts: { human: false } };
  await f.live.controller.beforeDispatch({ chatId: f.job.chatId, item });
  const remote = f.live.mainRepair.o.remote;
  f.live.mainRepair.o.remote = async () => {
    f.policy.enabled = false;
    return f.held();
  };
  await assert.rejects(assertInputReady(item), /authority changed/);
  f.policy.enabled = true;
  f.live.mainRepair.o.remote = remote;
  const ready = assertInputReady(item);
  await Promise.resolve();
  clock.advance(20 * 60_000);
  await assert.rejects(ready, /lease expired before dispatch/);
});

test('settings retain bounded plan permission and omit absent account settings', async () => {
  const f = nativeRepairWorld();
  f.live.orchestrator.o.childOptions = async () => ({ model: 'm', permission: 'plan', planBasePermission: 'default' });
  const selected = await f.runtime.settings('feature', () => true);
  assert.equal(selected.settings.planBasePermission, 'default');
  assert.equal('account' in selected.settings, false);
});
