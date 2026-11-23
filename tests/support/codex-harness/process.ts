// Codex harness process unit cases with shared server and session fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { AppServer, killTree } from './fixture';
import { useFakeProc } from '../ports/proc.ts';
import { readerTurns } from '../reader-turns.ts';

export function registerProcessCases() {
  function fakeProc(pid: number | undefined = 42) {
    const p: any = new EventEmitter();
    p.pid = pid;
    p.written = [] as string[];
    p.kills = 0;
    p.kill = () => p.kills++;
    p.stdin = Object.assign(new EventEmitter(), { write: (s: string) => p.written.push(s) });
    p.stdout = Object.assign(new EventEmitter(), { encoding: '', setEncoding: (e: string) => (p.stdout.encoding = e) });
    p.stderr = Object.assign(new EventEmitter(), { encoding: '', setEncoding: (e: string) => (p.stderr.encoding = e) });
    return p;
  }
  function fakeSpawn(pids: (number | undefined)[] = []) {
    const calls: any[] = [];
    const procs: any[] = [];
    const spawn = (cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      const p = fakeProc();
      if (pids.length) p.pid = pids.shift();
      procs.push(p);
      return p;
    };
    return { spawn, calls, procs };
  }

  test('AppServer spawns `codex app-server` from the home folder with the default env, once', () => {
    const sp = fakeSpawn();
    const s = new AppServer({ spawn: sp.spawn });
    assert.equal(s.status, 'stopped');
    s.start();
    s.start();
    assert.equal(sp.calls.length, 1);
    const { cmd, args, opts } = sp.calls[0];
    assert.ok([cmd, ...args].includes('codex'));
    assert.ok(args.includes('app-server'));
    assert.equal(opts.env, process.env);
    assert.equal(opts.cwd, os.homedir());
    assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(sp.procs[0].stdout.encoding, ''); // raw bytes are decoded off main for growing records
    assert.equal(sp.procs[0].stderr.encoding, 'utf8');
    assert.equal(s.status, 'running');
    // a broken stdin pipe is not fatal
    sp.procs[0].stdin.emit('error', new Error('EPIPE'));
    // the default crash reporter is a no-op; listeners still hear the exit
    const events: any[] = [];
    s.listeners.add((e: any) => events.push(e));
    sp.procs[0].emit('exit', 3, null);
    assert.equal(s.status, 'exited');
    assert.equal(s.proc, null);
    assert.deepEqual(events, [{ kind: 'exit', code: 3, signal: null, stderr: '' }]);
  });

  test('AppServer reads newline-delimited JSON, across chunks, skipping blanks, junk and intercepted messages', async () => {
    const sp = fakeSpawn();
    const s = new AppServer({ spawn: sp.spawn, findBin: () => '/bin/codex', env: () => ({ X: '1' }) });
    s.threadConfig = { openai_base_url: 'http://127.0.0.1:1/relay-secret' };
    const events: any[] = [];
    s.listeners.add((e: any) => events.push(e));
    s.intercepts.add((m: any) => m.method === 'account/login/completed');
    s.start();
    assert.deepEqual(sp.calls[0].opts.env, { X: '1' });
    // the relay's address goes with each thread request, never on the command line any process can read
    assert.equal(sp.calls[0].args.at(-1), 'app-server');
    assert.ok(!sp.calls[0].args.join(' ').includes('relay-secret'));
    const out = sp.procs[0].stdout;
    out.emit('data', '{"id":"a","res');
    assert.equal(events.length, 0);
    out.emit('data', 'ult":1}\n\n   \nnot json\nnull\n[]\n1\ntrue\n"text"\n{"method":"account/login/completed"}\n{"method":"x"}\n');
    // past the reader's time budget (a busy machine) the later lines come in later turns
    await readerTurns();
    assert.deepEqual(events, [
      { kind: 'message', msg: { id: 'a', result: 1 } },
      { kind: 'message', msg: { method: 'x' } },
    ]);
  });

  test('AppServer reports a crash with the stderr tail, but not a stop on purpose or a plain SIGTERM', () => {
    const sp = fakeSpawn();
    const crashes: any[] = [];
    const s = new AppServer({ spawn: sp.spawn, onCrashReport: (...a: any[]) => crashes.push(a) });
    s.start();
    const chunks = Array.from({ length: 201 }, (_, i) => `error ${i}: ${'x'.repeat(40)};`);
    for (const chunk of chunks) sp.procs[0].stderr.emit('data', chunk);
    assert.equal(s.stderrTail.text.length, 4000);
    sp.procs[0].emit('exit', 1, null);
    assert.equal(crashes.length, 1);
    assert.equal(crashes[0][0], 1);
    assert.equal(crashes[0][2], chunks.join('').slice(-4000));
    // killed by a signal other than SIGTERM is a crash
    s.start();
    sp.procs[1].emit('exit', null, 'SIGKILL');
    assert.equal(crashes.length, 2);
    // SIGTERM, a clean exit, and a process killTree stopped are not
    s.start();
    sp.procs[2].emit('exit', null, 'SIGTERM');
    s.start();
    sp.procs[3].emit('exit', 0, null);
    s.start();
    killTree(sp.procs[4]);
    assert.equal(sp.procs[4].kills, 1);
    sp.procs[4].emit('exit', 1, null);
    assert.equal(crashes.length, 2);
    assert.equal(s.status, 'exited');
  });

  test('AppServer errors: an unspawnable binary lets the next send start again; a live process stays', () => {
    const sp = fakeSpawn([undefined, 7]);
    const s = new AppServer({ spawn: sp.spawn });
    const events: any[] = [];
    s.listeners.add((e: any) => events.push(e));
    s.start();
    sp.procs[0].emit('error', new Error('ENOENT'));
    assert.equal(s.proc, null);
    assert.equal(s.status, 'exited');
    assert.deepEqual(events.at(-1), { kind: 'error', error: 'ENOENT' });
    s.send({ method: 'initialized' });
    assert.equal(sp.calls.length, 2);
    assert.deepEqual(sp.procs[1].written, ['{"method":"initialized"}\n']);
    sp.procs[1].emit('error', null);
    assert.equal(s.proc, sp.procs[1]);
    assert.deepEqual(events.at(-1), { kind: 'error', error: 'null' });
  });

  test('AppServer stop kills the process; its later output, errors and exit are not news', () => {
    const sp = fakeSpawn();
    const s = new AppServer({ spawn: sp.spawn });
    const events: any[] = [];
    s.listeners.add((e: any) => events.push(e));
    s.stop();
    assert.deepEqual(events, []);
    s.start();
    const old = sp.procs[0];
    s.stop();
    assert.equal(old.kills, 1);
    assert.equal(old.stopped, true);
    assert.equal(s.status, 'stopped');
    assert.deepEqual(events, [{ kind: 'stopped' }]);
    old.stdout.emit('data', '{"method":"late"}\n');
    old.emit('error', new Error('late'));
    old.emit('exit', 1, null);
    assert.deepEqual(events, [{ kind: 'stopped' }]);
  });

  test('AppServer send is a no-op when no process could be started', () => {
    const s = new AppServer({ spawn: () => assert.fail('not spawned') });
    s.start = () => {};
    assert.doesNotThrow(() => s.send({ method: 'x' }));
  });

  test('AppServer spawns through the proc port by default, with no thread config until the relay gives one', (t) => {
    // the default reads the port when it spawns (electron/platform/ports/proc.cjs)
    const spawned: unknown[][] = [];
    useFakeProc(t, { spawn: (...a: unknown[]) => (spawned.push(a), 'child') });
    assert.equal(new AppServer().spawn('codex', ['app-server'], { cwd: '/w' }), 'child');
    assert.deepEqual(spawned, [['codex', ['app-server'], { cwd: '/w' }]]);
    const sp = fakeSpawn();
    const s = new AppServer({ spawn: sp.spawn });
    assert.equal(s.threadConfig, null);
    s.start();
    assert.equal(sp.calls[0].args.at(-1), 'app-server');
  });
}
