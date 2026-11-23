// Host sign-in process ownership: cancellation, descendants and failed cleanup cannot overlap credential writers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createLogin } from '../host/src/login.mjs';

const { retireGroup } = createRequire(import.meta.url)('../electron/platform/winbin.cjs');
const { installProc } = createRequire(import.meta.url)('../electron/platform/ports/proc.cjs');
const fixture = path.join(import.meta.dirname, 'fixtures/fake-cli-login.mjs');
const until = async (fn: () => unknown) => {
  for (let n = 0; n < 1200; n++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Sign-in shutdown did not finish');
};

function world(t: any, mode: string, retire = retireGroup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-login-retirement-'));
  const out = path.join(dir, 'descendant');
  const children: ChildProcess[] = [];
  const login = createLogin({
    runtime: { host: {} } as any,
    env: {},
    which: () => '/remote/gh',
    spawnFn: (_bin, args, options) => {
      const child = spawn(process.execPath, [fixture, ...args], {
        ...options,
        env: { ...process.env, FAKE_CLI_MODE: mode, FAKE_CLI_OUT: out },
      });
      children.push(child);
      return child;
    },
    retire,
    gitSignInCheck: Object.assign(async () => ({ 'github.com': 'yes' as const }), { invalidate() {} }),
  });
  t.after(async () => {
    login.close();
    await until(() => login.idle());
    fs.rmSync(dir, { recursive: true });
  });
  return { login, children, out };
}

test('replacement waits for real delayed CLI closure, and a cancelled queued replacement never spawns', async (t) => {
  const h = world(t, 'delayed-stop');
  const first = h.login.start({ harness: 'git:github.com' });
  await until(() => first.codes.length);
  h.login.cancel('git:github.com');
  assert.equal(first.state, 'cancelled', 'cancellation is visible while the CLI is shutting down');
  const second = h.login.start({ harness: 'git:github.com' });
  assert.equal(second.state, 'starting');
  assert.equal(h.children.length, 1);
  await until(() => h.children.length === 2);
  assert.equal(h.children[0].exitCode, 0, 'the old CLI completed its shutdown before another starts');
  await until(() => second.codes.length);
  h.login.cancel('git:github.com');
  h.login.start({ harness: 'git:github.com' });
  h.login.cancel('git:github.com');
  await until(() => h.login.idle());
  assert.equal(h.children.length, 2);
});

test('joining a live Host sign-in leaves its CLI running and returns the same device flow', async (t) => {
  const h = world(t, 'delayed-stop');
  const first = h.login.start({ harness: 'git:github.com' });
  await until(() => first.codes.length);
  assert.equal(h.login.start({ harness: 'git:github.com' }), first);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(first.state, 'waiting');
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].exitCode, null);
  assert.equal(h.children[0].signalCode, null);
});

test('cancelling during retirement of an old gh flag rejection never starts its fallback', async (t) => {
  let finishRetiring!: () => void;
  const h = world(t, 'github-legacy', async (child) => {
    await new Promise<void>((resolve) => {
      finishRetiring = resolve;
    });
    await retireGroup(child);
  });
  const attempt = h.login.start({ harness: 'git:github.com' });
  await until(() => finishRetiring);
  h.login.cancel('git:github.com');
  finishRetiring();
  await until(() => h.login.idle());
  assert.equal(attempt.state, 'cancelled');
  assert.equal(h.children.length, 1);
});

test('a parent exit with a surviving descendant retires its whole group before close and replacement', async (t) => {
  const h = world(t, 'tree');
  const first = h.login.start({ harness: 'git:github.com' });
  await until(() => first.codes.length);
  const descendant = Number(fs.readFileSync(h.out, 'utf8'));
  h.login.cancel('git:github.com');
  const second = h.login.start({ harness: 'git:github.com' });
  await until(() => h.children.length === 2);
  assert.equal(h.children[0].signalCode, 'SIGTERM');
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  await until(() => second.codes.length);
});

test('a CLI refusing SIGTERM is force-stopped before its writer is released', async (t) => {
  const h = world(t, 'ignore-stop');
  const first = h.login.start({ harness: 'codex' });
  await until(() => first.codes.length);
  h.login.cancel('codex');
  await until(() => h.login.idle());
  assert.equal(h.children[0].signalCode, 'SIGKILL');
  assert.equal(first.state, 'cancelled');
});

test('cleanup rejection retains ownership and an explicit retry cleans up before starting a replacement', async (t) => {
  let blocked = true;
  const h = world(t, 'delayed-stop', async (child: ChildProcess) => {
    if (blocked) throw new Error('Unverified process identities');
    return retireGroup(child);
  });
  const first = h.login.start({ harness: 'codex' });
  await until(() => first.codes.length);
  h.login.cancel('codex');
  await until(() => first.state === 'failed');
  assert.match(first.error!, /retry cleanup/);
  assert.equal(h.login.idle(), false);
  assert.equal((await h.login.logout('codex')).signedOut, false);
  assert.equal(h.children.length, 1, 'sign-out cannot bypass unverified cleanup');
  const second = h.login.start({ harness: 'codex' });
  await until(() => second.state === 'failed');
  assert.equal(h.children.length, 1, 'failed cleanup never releases the writer');
  blocked = false;
  const third = h.login.start({ harness: 'codex' });
  assert.notEqual(third, second, 'a failed queued attempt is replaced behind the same cleanup barrier');
  await until(() => h.children.length === 2);
  assert.equal(h.children[0].exitCode, 0);
  assert.equal(first.state, 'cancelled');
  assert.equal(second.state, 'cancelled');
  await until(() => third.codes.length);
});

test('both closure and verified retirement are required, in either completion order', async () => {
  for (const closesFirst of [true, false]) {
    let retired!: () => void;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    const login = createLogin({
      runtime: { host: {} } as any,
      which: () => '/remote/codex',
      spawnFn: () => child as any,
      retire: () =>
        new Promise<void>((r) => {
          retired = r;
        }),
      probe: async () => true,
    });
    const attempt = login.start({ harness: 'codex' });
    child.emit('exit', 0);
    await until(() => retired);
    if (closesFirst) child.emit('close', 0);
    else retired();
    await new Promise((r) => setImmediate(r));
    assert.equal(login.idle(), false);
    assert.equal(attempt.state, 'waiting');
    if (closesFirst) retired();
    else child.emit('close', 0);
    await until(() => login.idle());
    assert.equal(attempt.state, 'done');
  }
});

test('the default CLI spawn reads the current Host process port, preserving crash-recovery tracking', async (t) => {
  const ran: any[] = [];
  const login = createLogin({
    runtime: { host: {} } as any,
    env: {},
    which: () => '/remote/codex',
    probe: async () => true,
  });
  const previous = installProc({
    spawn: (bin: string, args: string[], options: any) => {
      ran.push({ bin, args, detached: options.detached });
      return spawn(process.execPath, [fixture], { ...options, env: { ...process.env, FAKE_CLI_MODE: 'ok' } });
    },
  });
  t.after(() => installProc(previous));
  login.start({ harness: 'codex' });
  await until(() => login.idle());
  assert.equal(login.status('codex')?.state, 'done');
  assert.deepEqual(ran, [{ bin: '/remote/codex', args: ['login', '--device-auth'], detached: true }]);
});

test('expired and failed attempts queue a fresh sign-in while their cleanup still owns the writer', async () => {
  for (const ending of ['expired', 'failed'] as const) {
    const children: any[] = [];
    let unverified = ending === 'failed';
    let release!: () => void;
    const login = createLogin({
      runtime: { host: {} } as any,
      which: () => '/remote/codex',
      loginMs: 30,
      spawnFn: () => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => true,
        });
        children.push(child);
        return child as any;
      },
      retire: (child) => {
        if (child !== children[0]) return Promise.resolve();
        if (unverified) return Promise.reject(new Error('Cleanup unverified'));
        return new Promise<void>((r) => {
          release = r;
        });
      },
      probe: async () => true,
    });
    try {
      const first = login.start({ harness: 'codex' });
      if (ending === 'failed') children[0].emit('close', 3);
      await until(() => first.state === ending);
      unverified = false;
      const replacement = login.start({ harness: 'codex' });
      assert.notEqual(replacement, first);
      assert.equal(replacement.state, 'starting');
      assert.equal(login.start({ harness: 'codex' }), replacement, 'the pending replacement still coalesces');
      assert.equal(children.length, 1);
      await until(() => release);
      release();
      if (ending === 'expired') children[0].emit('close', null);
      await until(() => children.length === 2);
      assert.equal(first.state, ending, 'cleanup does not rewrite the original terminal reason');
      children[1].emit('close', 0);
      await until(() => login.idle());
      assert.equal(replacement.state, 'done');
    } finally {
      login.close();
      release?.();
      for (const child of children) child.emit('close', 0);
    }
  }
});
