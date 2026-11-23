// Fixture ACP shutdown waits for actual owned child exits, including prior restarts and forced termination.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acpFixtureStop, acpFixtureProcesses } from './support/acp-fixture-stop.mjs';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function child() {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    signals: [] as string[],
    kill(signal: string) {
      this.signals.push(signal);
    },
  });
  return { proc, exited: null };
}
function host(agent: any) {
  return {
    spawnFn: () => agent.proc,
    agents: new Map([['old', Promise.resolve(agent)]]),
    isolatedAgents: new Map([['alias', Promise.resolve(agent)]]),
    codingAgents: new Map(),
    closeAll() {
      this.agents.clear();
      this.isolatedAgents.clear();
      this.codingAgents.clear();
    },
  };
}

test('a prior closeAll retains the exact child until its exit and cancels the force timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const agent = child();
  const h = host(agent);
  const stop = acpFixtureStop(h);
  h.spawnFn();
  h.closeAll();
  let settled = false;
  const waiting = stop().then(() => (settled = true));
  await turn();
  assert.deepEqual(agent.proc.signals, ['SIGTERM']);
  assert.equal(settled, false);
  agent.proc.emit('exit', 0, null);
  await waiting;
  t.mock.timers.tick(3000);
  assert.deepEqual(agent.proc.signals, ['SIGTERM']);
  assert.equal(agent.proc.listenerCount('exit'), 0);
  assert.equal(agent.proc.listenerCount('error'), 0);
});

test('sending SIGKILL does not complete shutdown before the child reports its exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const agent = child();
  const h = host(agent);
  const stop = acpFixtureStop(h);
  h.spawnFn();
  let settled = false;
  const waiting = stop().then(() => (settled = true));
  await turn();
  t.mock.timers.tick(2999);
  assert.deepEqual(agent.proc.signals, ['SIGTERM']);
  t.mock.timers.tick(1);
  await turn();
  assert.deepEqual(agent.proc.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false);
  assert.throws(() => h.spawnFn(), /shutting down/);
  agent.proc.emit('exit', null, 'SIGKILL');
  await waiting;
});

test('failed starts and retired agent entries cannot hide a child from fixture shutdown', async () => {
  const agent = child();
  const h = host(agent);
  const stop = acpFixtureStop(h);
  h.spawnFn();
  h.agents.clear();
  h.isolatedAgents.clear();
  h.codingAgents.set('failed', Promise.reject(new Error('initialization failed')));
  const waiting = stop();
  await turn();
  assert.deepEqual(agent.proc.signals, ['SIGTERM']);
  agent.proc.emit('exit', 0, null);
  await waiting;
});

test('a signal failure waits for other owned children and remains a rejected stop', async () => {
  const bad = child();
  const good = child();
  const failure = new Error('could not signal child');
  const h = host(bad);
  let next = bad.proc;
  h.spawnFn = () => next;
  const stop = acpFixtureStop(h);
  h.spawnFn();
  next = good.proc;
  h.spawnFn();
  bad.proc.kill = () => {
    throw failure;
  };
  let settled = false;
  const waiting = stop();
  void waiting.catch(() => (settled = true));
  const rejected = assert.rejects(waiting, (error: any) => error instanceof AggregateError && error.errors.includes(failure));
  await turn();
  assert.equal(settled, false);
  assert.deepEqual(good.proc.signals, ['SIGTERM']);
  good.proc.emit('exit', 0, null);
  await rejected;
});

test('retirement prevents a pending initialization from spawning a child, and skips children already exited', async () => {
  const agent = child();
  const h = host(agent);
  const stop = acpFixtureStop(h);
  h.spawnFn();
  agent.proc.emit('exit', 0, null);
  let release!: () => void;
  h.codingAgents.set(
    'late',
    new Promise<void>((resolve) => (release = resolve)).then(() => h.spawnFn()),
  );
  const waiting = stop();
  assert.throws(() => h.spawnFn(), /shutting down/);
  release();
  await waiting;
  assert.deepEqual(agent.proc.signals, []);
});

test('a real ACP host and fake child remain owned until the child has exited', async (t) => {
  const require = createRequire(import.meta.url);
  const { AcpHost } = require('../electron/harness/acp.cjs');
  const { spawn } = require('../electron/harness/acp/agent.cjs');
  const { ItemsLog } = require('../electron/platform/itemsLog.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-fixture-stop-'));
  const items = new ItemsLog(path.join(dir, 'threads'));
  let proc: any;
  t.after(async () => {
    if (proc && proc.exitCode == null && proc.signalCode == null) {
      const exited = once(proc, 'exit');
      proc.kill('SIGKILL');
      await exited;
    }
    await items.drain();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const fake = new URL('./fixtures/fake-acp-agent.mjs', import.meta.url).href;
  const script = `process.on('SIGTERM', () => {}); process.env.FAKE_STAY = '1'; await import(${JSON.stringify(fake)});`;
  const h = new AcpHost({
    items,
    ids: ['fake'],
    quirks: () => ({ label: 'Fake', args: ['--input-type=module', '-e', script] }),
    resolveBin: () => process.execPath,
    env: () => ({ ...process.env, FAKE_ACP_LOG: path.join(dir, 'agent.jsonl'), FAKE_ACP_STATE: path.join(dir, 'state') }),
    cwd: dir,
    spawnFn: (...args: any[]) => (proc = spawn(...args)),
  });
  const stop = acpFixtureStop(h);
  await h.ensure('acp:fake:cleanup', { cwd: dir });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const waiting = stop().then(() => (settled = true));
  await turn();
  assert.equal(settled, false);
  assert.equal(proc.exitCode, null);
  assert.equal(proc.signalCode, null);
  t.mock.timers.tick(3000);
  await waiting;
  assert.equal(proc.signalCode, 'SIGKILL');
  assert.equal(settled, true);
});

for (const phase of ['admission', 'launch', 'privacy']) {
  test(`a retired pre-spawn ${phase} remains owned after closeAll clears its pool`, async (t) => {
    const require = createRequire(import.meta.url);
    const { AcpHost } = require('../electron/harness/acp.cjs');
    const { transcriptFixture } = await import('./support/transcript-fixture.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-startup-cleanup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const hold = async (at: string) => {
      if (phase === at) {
        entered();
        await waiting;
      }
    };
    const h = new AcpHost({
      items: {},
      quirks: () => ({
        label: 'Fake',
        launch: async () => {
          await hold('launch');
          fs.mkdirSync(path.join(dir, 'launch-patch'), { recursive: true });
          return { args: [] };
        },
        admission: { privacyGate: async () => (await hold('privacy'), { ok: true }) },
      }),
      resolveBin: () => '/fake',
      admitted: async () => (await hold('admission'), null),
      spawnFn: () => {
        throw new Error('retired startup must not reach the underlying spawn');
      },
    });
    const owner = transcriptFixture(dir);
    owner.stopWith(acpFixtureStop(h));
    const starting = h.agent('fake');
    const failed = assert.rejects(starting, /shutting down/);
    await reached;
    h.closeAll();
    let settled = false;
    const cleaning = owner.cleanup().then(() => (settled = true));
    try {
      await turn();
      assert.equal(settled, false, 'an initialization removed from the host map still owns its fixture');
      assert.equal(fs.existsSync(dir), true);
    } finally {
      release();
      await Promise.all([failed, cleaning]);
    }
    assert.equal(fs.existsSync(dir), false, 'all launch writers settle before fixture removal');
  });
}

test('a real missing executable settles shutdown without waiting for a nonexistent child exit', async (t) => {
  const require = createRequire(import.meta.url);
  const { spawn } = require('node:child_process');
  const owned = acpFixtureProcesses(spawn);
  const proc = owned.spawn(path.join(os.tmpdir(), `missing-acp-executable-${process.pid}`), [], {});
  const [error] = await once(proc, 'error');
  assert.equal(error.code, 'ENOENT');
  assert.notEqual(proc.exitCode, null, 'Node records the failed spawn before delivering its error');
  const kill = t.mock.method(proc, 'kill', () => {
    throw new Error('a failed spawn has no process to signal');
  });
  let settled = false;
  const stopping = owned.stop().then(() => (settled = true));
  await turn();
  assert.equal(settled, true);
  await stopping;
  assert.equal(kill.mock.callCount(), 0);
});
