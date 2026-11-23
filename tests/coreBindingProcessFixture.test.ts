// Real process fixtures prove their own readiness, ancestry and cleanup without depending on a native addon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownedNode, TREE } from './support/core-process-fixture.ts';

async function observeExit(pids: number[], timeout = 5000) {
  const running = new Set(pids);
  const deadline = Date.now() + timeout;
  while (running.size) {
    for (const pid of running) {
      try {
        // A PID may have been recycled; observation must never signal its current owner.
        process.kill(pid, 0);
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
        running.delete(pid);
      }
    }
    assert.ok(!running.size || Date.now() < deadline, `owned descendants exit after losing their owner: ${[...running]}`);
    if (running.size) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a controlled tree reports its real live child and ends both processes on cleanup', async (t) => {
  const fixture = ownedNode(t, { source: TREE });
  const identity = await fixture.ready;
  assert.equal(identity.pid, fixture.process.pid);
  assert.equal(identity.ppid, process.pid);
  assert.equal(identity.child?.ppid, identity.pid);
  assert.ok(identity.child && identity.child.pid !== identity.pid);
  assert.doesNotThrow(() => process.kill(identity.child!.pid, 0));
  await fixture.stop();
  assert.notEqual(fixture.process.exitCode ?? fixture.process.signalCode, null);
  assert.throws(() => process.kill(identity.child!.pid, 0), { code: 'ESRCH' });
  await fixture.stop();
});

test('an early fixture exit rejects readiness and completes cleanup', async (t) => {
  const fixture = ownedNode(t, { source: 'process.exit(7)' });
  await assert.rejects(fixture.ready, /fixture exited before ready \(7\)/);
  assert.equal(fixture.process.exitCode, 7);
  await fixture.exited;
});

test('a silent fixture cannot leave readiness pending or a child running', async (t) => {
  const fixture = ownedNode(t, {
    source: "process.on('message', () => {}); process.on('disconnect', () => {}); setInterval(() => {}, 1000)",
    timeout: 100,
  });
  await assert.rejects(fixture.ready, /fixture did not become ready/);
  assert.notEqual(fixture.process.exitCode ?? fixture.process.signalCode, null);
  await fixture.exited;
});

test('a failed launch rejects readiness without waiting for an exit that cannot arrive', async (t) => {
  const fixture = ownedNode(t, { executable: `${process.execPath}.nonexistent-fixture` });
  await assert.rejects(fixture.ready, { code: 'ENOENT' });
  assert.equal(fixture.process.pid, undefined);
  await fixture.stop();
});

test('an abrupt tree-root exit closes the leaf IPC lease and the leaf exits', async (t) => {
  const fixture = ownedNode(t, { source: TREE });
  const identity = await fixture.ready;
  assert.equal(fixture.process.kill('SIGKILL'), true);
  await fixture.exited;
  await observeExit([identity.child!.pid]);
});

test('an abrupt fixture-owner exit makes the tree reap its leaf and exit', async (t) => {
  const fixture = ownedNode(t, {
    source: `
      const tree = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(TREE)}], {
        windowsHide: true, detached: process.platform === 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
      tree.once('message', (identity) => process.send({ pid: process.pid, ppid: process.ppid, child: identity }));
      tree.once('error', () => process.exit(1));
      tree.once('exit', () => process.exit(0));
      process.on('disconnect', () => { if (tree.connected) tree.disconnect(); });`,
  });
  const identity = await fixture.ready;
  const tree = identity.child!;
  assert.equal(tree.ppid, identity.pid);
  assert.equal(tree.child!.ppid, tree.pid);
  assert.equal(fixture.process.kill('SIGKILL'), true);
  await fixture.exited;
  await observeExit([tree.pid, tree.child!.pid]);
});

test('an unobserved exit with a reused PID fails conservatively without terminating its new owner', async (t) => {
  const kill = t.mock.method(process, 'kill', () => true);
  await assert.rejects(observeExit([12345], 0), /owned descendants exit after losing their owner/);
  assert.deepEqual(
    kill.mock.calls.map(({ arguments: args }) => args),
    [[12345, 0]],
  );
});

test('a custom fixture that ignores its lost IPC owner still has a bounded self-exit', async (t) => {
  const fixture = ownedNode(t, {
    source: `
      const schedule = setTimeout;
      global.setTimeout = (fn, delay) => schedule(fn, delay === 60_000 ? 100 : delay);
      process.on('disconnect', () => {});
      setInterval(() => {}, 1000);
      process.send({ pid: process.pid, ppid: process.ppid });`,
  });
  await fixture.ready;
  fixture.process.disconnect();
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      fixture.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('custom fixture outlived its watchdog')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
  assert.equal(fixture.process.exitCode, 1, 'the self-watchdog ends a fixture that ignored owner loss');
});
