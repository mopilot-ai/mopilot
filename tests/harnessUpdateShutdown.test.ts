// Update subscribers cannot start health, optional-download, version or restart work after the package manager closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from './support/async-scenarios.ts';
import { setup } from './support/harness-updates-kit.ts';

test('a natural exit waiting for admission when Quit starts cannot begin updater health probes afterward', async () => {
  const s = setup();
  const admission = deferred<void>();
  let health = 0;
  s.runs.o.afterExit = () => admission.promise;
  s.setHealth(() => {
    health++;
    return { version: '2.2.0', broken: null };
  });
  await s.updates.check();
  await s.updates.update('acp:kimi');
  s.ptys[0].h.onExit({ exitCode: 0 });
  const drain = s.runs.close();
  admission.resolve();
  await drain;
  await s.flush();
  assert.equal(health, 0);
  assert.deepEqual(s.restarts, []);
});

test('health already running when Quit starts cannot download optional packages or start a new version read', async () => {
  for (const broken of [null, 'native package missing']) {
    const s = setup();
    const health = deferred<any>();
    let reads = 0;
    s.setHealth((() => health.promise) as any);
    await s.updates.check();
    await s.updates.update('acp:kimi');
    const original = s.updates.read.bind(s.updates);
    s.updates.read = (...args: any[]) => {
      reads++;
      return original(...args);
    };
    s.ptys[0].h.onExit({ exitCode: 0 });
    await s.flush();
    await s.runs.close();
    health.resolve({ version: '2.2.0', broken });
    await s.flush();
    await s.flush();
    assert.equal(reads, 0);
    assert.equal(s.ptys.length, 1);
    assert.deepEqual(s.restarts, []);
  }
});

test('a version read already running at Quit cannot restart a harness when it resolves', async () => {
  const s = setup();
  const refreshed = deferred<any>();
  await s.updates.check();
  await s.updates.update('acp:kimi');
  s.updates.read = () => refreshed.promise;
  s.ptys[0].h.onExit({ exitCode: 0 });
  await s.flush();
  await s.runs.close();
  refreshed.resolve({ installed: '2.2.0', latest: '2.2.0' });
  await s.flush();
  assert.deepEqual(s.restarts, []);
});

test('a restart waiting for busy chats retires when the package manager closes', async () => {
  const s = setup();
  s.setBusy({ codex: [{ id: 'chat', title: 'working' }] });
  s.updates.restartWhenIdle('codex');
  assert.equal(s.updates.restarting.has('codex'), true);
  await s.runs.close();
  s.setBusy({});
  await s.tick();
  assert.equal(s.updates.restarting.has('codex'), false);
  assert.deepEqual(s.restarts, []);
});
