// A Host that is told to stop ends its children at once (Remote Run #5153): a Claude Code child that does not leave kept a stopped Host alive for about five minutes, serving nothing, which the app read as an offline machine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
import { createChildren } from '../host/src/children.mjs';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { proc } = require('../electron/platform/ports/proc.cjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-stop-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

/** A process table of stand-ins: a signal is logged, SIGTERM ends one unless it ignores it, SIGKILL always does. */
function table(pids: number[], ignoresTerm: number[] = []) {
  const sent: string[] = [];
  const live = new Set(pids);
  return {
    sent,
    live,
    alive: (pid: number) => live.has(pid),
    signal(pid: number, sig: NodeJS.Signals | 0, group: boolean) {
      if (sig === 0) {
        if (!live.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        return;
      }
      sent.push(`${group ? '-' : ''}${pid}:${sig}`);
      if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !ignoresTerm.includes(pid))) live.delete(pid);
    },
  };
}

test('endAll ends every child it has: SIGTERM, then SIGKILL for one that does not leave inside the grace; none is nothing', async () => {
  const t = table([10, 11], [11]);
  const children = createChildren({ dataDir: path.join(base, 'a'), signal: t.signal, alive: t.alive, graceMs: 60 });
  assert.deepEqual(await children.endAll(), [], 'a Host with no child ends none');
  assert.deepEqual(t.sent, []);
  children.track(10, 'codex');
  children.track(11, 'claude');
  const ended = await children.endAll();
  assert.deepEqual(ended.sort(), [10, 11]);
  assert.deepEqual(t.sent.sort(), ['-10:SIGTERM', '-11:SIGKILL', '-11:SIGTERM']);
  assert.equal(t.live.size, 0);
});

test('a stopping Host does not wait for a child that ignores SIGTERM: it ends it and exits within seconds', async () => {
  const dir = path.join(base, 'serve');
  const signals = new EventEmitter() as unknown as NodeJS.Process;
  const printed: string[] = [];
  const done = main(['serve', '--data-dir', dir], { env: {}, signals, out: (l: string) => printed.push(l), err: () => {} });
  await waitFor(() => printed.some((l) => l.startsWith('Pairing code: ')), 'the Host serving');
  // a child the Host started (through the proc port the Host tracks) that will not leave on SIGTERM, as a Claude Code process in its exit hooks
  const child = proc.spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: 'ignore',
  });
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await waitFor(
    () =>
      fs.existsSync(path.join(dir, 'children.json')) &&
      fs.readFileSync(path.join(dir, 'children.json'), 'utf8').includes(String(child.pid)),
    'the child recorded',
  );
  const stopped = Date.now();
  signals.emit('SIGTERM');
  assert.equal(await done, 0);
  await gone;
  assert.ok(Date.now() - stopped < 15_000, `stopped in ${Date.now() - stopped} ms`);
});

test("endAll never signals a pid whose child already exited (the number may be anyone's now), and ends a child that started while the others were leaving", async () => {
  const t = table([20, 21, 22], [21]);
  const children = createChildren({ dataDir: path.join(base, 'b'), signal: t.signal, alive: t.alive, graceMs: 80 });
  const { EventEmitter: Emitter } = await import('node:events');
  const exited = Object.assign(new Emitter(), { pid: 20 });
  const stubborn = Object.assign(new Emitter(), { pid: 21 });
  children.watch(exited as any, 'claude');
  children.watch(stubborn as any, 'claude');
  // 20 exits on its own after it was listed and its pid is now someone else's (alive in the table): it is forgotten on 'exit', never signalled
  exited.emit('exit');
  // a turn starts another child while 21 is still leaving
  setTimeout(() => children.track(22, 'codex'), 20);
  const ended = await children.endAll();
  assert.deepEqual(ended.sort(), [21, 22]);
  assert.ok(!t.sent.some((s) => s.includes('20:')), 'the exited child is never signalled');
  assert.ok(t.sent.includes('-22:SIGTERM'), 'the late child is ended in a further pass');
  assert.equal(t.live.has(21), false);
  assert.equal(t.live.has(22), false);
});

test('a leader that leaves on SIGTERM while a member of its group does not: the group is ended too, and an empty group is not signalled', async () => {
  const sent: string[] = [];
  // process 30 leads group 30 with one member that ignores SIGTERM; 31 leads an empty group once it leaves
  const groups = new Map<number, string[]>([
    [30, ['leader', 'member']],
    [31, ['leader']],
  ]);
  const leaders = new Set([30, 31]);
  const signal = (pid: number, sig: NodeJS.Signals | 0, group: boolean) => {
    const members = groups.get(pid) ?? [];
    if (sig === 0) {
      if (members.length === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return;
    }
    sent.push(`${group ? '-' : ''}${pid}:${sig}`);
    if (sig === 'SIGKILL') groups.set(pid, []);
    if (sig === 'SIGTERM') {
      groups.set(
        pid,
        members.filter((m) => m === 'member'),
      );
      leaders.delete(pid);
    }
  };
  const children = createChildren({ dataDir: path.join(base, 'c'), signal, alive: (pid: number) => leaders.has(pid), graceMs: 60 });
  const { EventEmitter: Emitter } = await import('node:events');
  const a = Object.assign(new Emitter(), { pid: 30 });
  const b = Object.assign(new Emitter(), { pid: 31 });
  children.watch(a as any, 'claude');
  children.watch(b as any, 'claude');
  // each leader exits as it gets SIGTERM and is forgotten on its exit event
  const leave = (e: any) => setTimeout(() => e.emit('exit'), 5);
  leave(a);
  leave(b);
  await children.endAll();
  assert.ok(sent.includes('-30:SIGKILL'), 'the member that ignored SIGTERM is ended through its group');
  assert.ok(!sent.includes('-31:SIGKILL'), 'a group with no member left is not signalled');
  assert.deepEqual(groups.get(30), []);
});

test('a Host that is stopping refuses a new message and passes everything else through', async () => {
  const { refuseWhenStopping } = await import('../host/src/stopGate.mjs');
  let stopping = false;
  const calls: unknown[] = [];
  const runtime = { send: async (...a: unknown[]) => (calls.push(a), { ok: true }), state: () => 'state' };
  const gated = refuseWhenStopping(runtime as any, () => stopping);
  assert.deepEqual(await gated.send('a', 1), { ok: true });
  assert.equal(gated.state(), 'state');
  stopping = true;
  await assert.rejects(gated.send('b'), { code: 'unsupported', message: /This Host is stopping/ });
  assert.deepEqual(calls, [['a', 1]], 'nothing reaches the runtime once the stop begins');
  assert.equal(gated.state(), 'state');
});
