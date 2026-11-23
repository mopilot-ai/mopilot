// The Host's Chromium launcher and CDP pipe (host/src/chromium.mjs, host/src/cdpPipe.mjs, package 2.6): the browser is started with --remote-debugging-pipe and spoken to in NUL-ended JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
// @ts-ignore: plain ESM without declarations
import { createCdpPipe, createPipeDecoder, PipeError, MAX_MESSAGE } from '../host/src/cdpPipe.mjs';
// @ts-ignore: plain ESM without declarations
import { browserEnv, findChromium, launchChromium, ChromiumError } from '../host/src/chromium.mjs';

const nul = (s: string) => Buffer.concat([Buffer.from(s), Buffer.from([0])]);
const pipeError = (code: string) => (e: any) => e instanceof PipeError && e.code === code;

test('B2: the decoder joins messages split across chunks and splits chunks holding several', () => {
  const d = createPipeDecoder();
  assert.deepEqual(d.push(nul('{"id":1}')), [{ id: 1 }]);
  assert.deepEqual(d.push(Buffer.from('{"id"')), []);
  assert.deepEqual(d.push(Buffer.from(':2}')), []);
  assert.deepEqual(d.push(Buffer.concat([Buffer.from([0]), nul('{"id":3}'), Buffer.from('{"id":4')])), [{ id: 2 }, { id: 3 }]);
  assert.deepEqual(d.push(Buffer.concat([Buffer.from('}'), Buffer.from([0])])), [{ id: 4 }]);
  assert.equal(PipeError.name, 'PipeError');
  assert.ok(MAX_MESSAGE > 1024 * 1024);
});

test('B1: a message that is not JSON, or larger than allowed, is a protocol error', () => {
  assert.throws(() => createPipeDecoder().push(nul('not json')), pipeError('not-json'));
  assert.throws(() => createPipeDecoder({ maxMessage: 8 }).push(nul('{"id":123456}')), pipeError('too-large'));
  const d = createPipeDecoder({ maxMessage: 8 });
  assert.deepEqual(d.push(Buffer.from('{"a":')), []);
  assert.throws(() => d.push(Buffer.from('123456789')), pipeError('too-large'));
});

function pipe() {
  const read = new PassThrough();
  const write = new PassThrough();
  const sent: Buffer[] = [];
  write.on('data', (c) => sent.push(c));
  const p = createCdpPipe({ read, write });
  const messages: any[] = [];
  const closes: string[] = [];
  p.onMessage((m: any) => messages.push(m));
  p.onClose((why: string) => closes.push(why));
  return { p, read, write, sent, messages, closes };
}

test('the pipe writes NUL-ended JSON and delivers what Chromium sends', async () => {
  const x = pipe();
  x.p.send({ id: 1, method: 'Page.enable' });
  await new Promise((r) => setImmediate(r));
  assert.equal(Buffer.concat(x.sent).toString(), '{"id":1,"method":"Page.enable"}\0');
  x.read.write(Buffer.concat([nul('{"id":1,"result":{}}'), nul('{"method":"Page.loadEventFired"}')]));
  assert.deepEqual(x.messages, [{ id: 1, result: {} }, { method: 'Page.loadEventFired' }]);
  // a listener that left hears nothing more
  const off = x.p.onMessage(() => assert.fail('left'));
  off();
  x.read.write(nul('{"id":2}'));
  assert.equal(x.messages.length, 3);
  assert.equal(x.p.closed, false);
});

test('the pipe closes once, with the reason, when it ends, errors, carries a bad message, or is closed (A5)', async () => {
  for (const [what, act, why] of [
    ['read end', (x: any) => x.read.end(), 'ended'],
    ['read destroyed', (x: any) => x.read.destroy(), 'ended'],
    ['read error', (x: any) => x.read.destroy(new Error('x')), 'error'],
    ['write error', (x: any) => x.write.destroy(new Error('x')), 'error'],
    ['bad message', (x: any) => x.read.write(nul('{')), 'not-json'],
    ['closed', (x: any) => x.p.close(), 'closed'],
  ] as const) {
    const x = pipe();
    act(x);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(x.closes, [why], what);
    assert.equal(x.p.closed, true);
    assert.throws(() => x.p.send({ id: 1 }), pipeError('closed'));
    x.p.close();
    assert.equal(x.closes.length, 1);
    // closing is not undone by a listener that left
    const off = x.p.onClose(() => undefined);
    off();
  }
});

function file(dir: string, name: string, mode: number) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, '#!/bin/sh\n', { mode });
  return f;
}

test('findChromium: the override must exist; macOS has its apps; Linux searches PATH in order; none is null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-'));
  try {
    const exe = file(dir, 'chromium', 0o755);
    file(dir, 'google-chrome', 0o644);
    fs.mkdirSync(path.join(dir, 'chromium-browser'));
    assert.equal(findChromium({ env: { MOPILOT_HOST_CHROME: exe }, platform: 'linux' }), exe);
    assert.equal(findChromium({ env: { MOPILOT_HOST_CHROME: path.join(dir, 'missing') }, platform: 'linux' }), null);
    // not executable (google-chrome) and a folder (chromium-browser) are skipped
    assert.equal(findChromium({ env: { PATH: `${path.join(dir, 'nope')}${path.delimiter}${dir}` }, platform: 'linux' }), exe);
    assert.equal(findChromium({ env: { PATH: '' }, platform: 'linux' }), null);
    assert.equal(findChromium({ env: {}, platform: 'linux' }), null);
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const chromium = '/Applications/Chromium.app/Contents/MacOS/Chromium';
    assert.equal(findChromium({ platform: 'darwin', env: {}, isFile: (f: string) => f === chromium }), chromium);
    assert.equal(findChromium({ platform: 'darwin', env: {}, isFile: (f: string) => f === chrome || f === chromium }), chrome);
    assert.equal(findChromium({ platform: 'darwin', env: {}, isFile: () => false }), null);
    assert.equal(ChromiumError.name, 'ChromiumError');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeSpawn() {
  const child: any = new EventEmitter();
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [] as string[];
  child.kill = (sig: string) => void child.kills.push(sig);
  const calls: any[] = [];
  const spawn = (exe: string, args: string[], opts: any) => (
    calls.push({ exe, args, opts }), setImmediate(() => child.emit('spawn')), child
  );
  return { child, spawn: spawn as any, calls };
}

test('launchChromium starts it headless on a pipe and its own profile; only root gets --no-sandbox (I2: never a TCP port)', async () => {
  for (const root of [false, true]) {
    const f = fakeSpawn();
    const l = await launchChromium({ executable: '/usr/bin/chromium', userDataDir: '/data/profile', spawn: f.spawn, root });
    const { args, opts } = f.calls[0];
    assert.ok(args.includes('--headless=new'));
    assert.ok(args.includes('--remote-debugging-pipe'));
    assert.ok(args.includes('--user-data-dir=/data/profile'));
    assert.equal(args.includes('--no-sandbox'), root);
    assert.equal(
      args.some((a: string) => a.startsWith('--remote-debugging-port')),
      false,
    );
    assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']);
    assert.equal(l.pid, 4242);
    // the pipe's write end is Chromium's fd 3 and its read end fd 4
    l.pipe.send({ id: 1 });
    assert.equal(f.child.stdio[3].read().toString(), '{"id":1}\0');
    f.child.stdio[4].write(nul('{"id":1,"result":{}}'));
  }
  // the default for root follows the process
  const f = fakeSpawn();
  await launchChromium({ executable: 'x', userDataDir: 'y', spawn: f.spawn });
  assert.equal(f.calls[0].args.includes('--no-sandbox'), process.getuid?.() === 0);
});

test('B2: a browser that cannot start rejects with the reason; one that exits says why from its stderr tail', async () => {
  const bad: any = new EventEmitter();
  bad.stderr = new PassThrough();
  const failing = launchChromium({
    executable: '/nope',
    userDataDir: 'y',
    spawn: () => (setImmediate(() => bad.emit('error', new Error('ENOENT'))), bad),
  });
  await assert.rejects(failing, (e: any) => e instanceof ChromiumError && e.code === 'spawn_failed' && /\/nope.*ENOENT/.test(e.message));
  const f = fakeSpawn();
  const l = await launchChromium({ executable: 'x', userDataDir: 'y', spawn: f.spawn });
  f.child.stderr.write('x'.repeat(5000));
  f.child.stderr.write('Missing X server');
  await new Promise((r) => setImmediate(r));
  f.child.emit('exit', 1, null);
  const exit = await l.exited;
  assert.equal(exit.code, 1);
  assert.equal(exit.stderr.length, 2000);
  assert.ok(exit.stderr.endsWith('Missing X server'));
});

test('stop closes the pipe, asks it to end, and kills it when it does not (A3); a browser that already ended is left alone', async () => {
  const timers: any[] = [];
  const setTimer: any = (fn: () => void, ms: number) => {
    const t = { fn, ms, unref() {} };
    timers.push(t);
    return t;
  };
  const cleared: any[] = [];
  const clearTimer: any = (t: any) => void cleared.push(t);
  const f = fakeSpawn();
  const l = await launchChromium({ executable: 'x', userDataDir: 'y', spawn: f.spawn, setTimer, clearTimer, killMs: 500 });
  l.stop();
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.equal(l.pipe.closed, true);
  assert.equal(timers[0].ms, 500);
  timers[0].fn();
  assert.deepEqual(f.child.kills, ['SIGTERM', 'SIGKILL']);
  // it ended in time: the kill timer is cleared
  f.child.emit('exit', 0, 'SIGTERM');
  await l.exited;
  assert.equal(cleared.at(-1), timers[0]);
  const g = fakeSpawn();
  const m = await launchChromium({ executable: 'x', userDataDir: 'y', spawn: g.spawn, setTimer, clearTimer });
  g.child.exitCode = 0;
  m.stop();
  assert.deepEqual(g.child.kills, []);
  const h = fakeSpawn();
  const n = await launchChromium({ executable: 'x', userDataDir: 'y', spawn: h.spawn, setTimer, clearTimer });
  h.child.signalCode = 'SIGKILL';
  n.stop();
  assert.deepEqual(h.child.kills, []);
});

test('L: the browser runs with the names it needs only, not the Host’s keys and tokens', async () => {
  const f = fakeSpawn();
  const host = {
    PATH: '/bin',
    HOME: '/home/u',
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    XDG_RUNTIME_DIR: '/run/user/1',
    TMPDIR: '/tmp',
    ANTHROPIC_API_KEY: 'sk-secret',
    OPENAI_API_KEY: 'sk-secret',
    GITHUB_TOKEN: 'ghp_secret',
    GIT_ASKPASS: 'x',
    MOPILOT_HOST_DATA: '/d',
    SSH_AUTH_SOCK: '/agent',
  };
  await launchChromium({ executable: 'x', userDataDir: 'y', spawn: f.spawn, env: host });
  assert.deepEqual(f.calls[0].opts.env, {
    PATH: '/bin',
    HOME: '/home/u',
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    XDG_RUNTIME_DIR: '/run/user/1',
    TMPDIR: '/tmp',
  });
  assert.deepEqual(browserEnv({}), {});
  // with no env given, the process's own is filtered the same way
  const g = fakeSpawn();
  process.env.MOPILOT_TEST_SECRET = 'x';
  await launchChromium({ executable: 'x', userDataDir: 'y', spawn: g.spawn });
  delete process.env.MOPILOT_TEST_SECRET;
  assert.equal('MOPILOT_TEST_SECRET' in g.calls[0].opts.env, false);
});
