// The Host desktop's lifecycle (G8 #3903, review of #3941): who may ask at all, a resend after a reconnect, a new owner, a helper that went, a client that vanished, a launch that never ends, and a Host that is refused its data dir.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createDesktopHost } from '../host/src/desktopHost.mjs';
// @ts-ignore: plain ESM without declarations
import { createHelperClient } from '../host/src/helperClient.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostDesktop } from '../host/src/desktopService.mjs';
// @ts-ignore: plain ESM without declarations
import { createDesktopProtocol } from '../host/src/desktopProtocol.mjs';
// @ts-ignore: plain ESM without declarations
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore: plain ESM without declarations
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore: plain ESM without declarations
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore: plain ESM without declarations
import { startServer } from '../host/src/server.mjs';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';
// @ts-ignore: plain ESM without declarations
import { DESKTOP_METHODS } from '../shared/host/desktop.mjs';
// @ts-ignore: plain ESM without declarations
import { helloParams } from '../shared/host/schema.mjs';
import { fakeHelper } from './support/host-desktop-kit.ts';
import { tick } from './support/async-scenarios.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
const tmp = () => {
  const dir = fs.mkdtempSync('/tmp/hdl-');
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const A = {};
const B = {};

function build(over: { idleMs?: number } = {}) {
  const f = fakeHelper();
  const probe = { ok: () => true, why: () => '', recheck: () => undefined };
  const timers: { fn: () => void; ms: number; cleared: boolean; unref: () => void }[] = [];
  let t = 0;
  const host = createDesktopHost({
    helper: f.helper,
    probe,
    epochOf: () => 1,
    maxReply: 1000,
    now: () => t,
    idleMs: over.idleMs ?? 600_000,
    setTimer: ((fn: () => void, ms: number) => {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    }) as any,
    clearTimer: ((timer: any) => void (timer && (timer.cleared = true))) as any,
  });
  return { ...f, host, timers, advance: (ms: number) => void (t += ms) };
}

test('an unpaired connection cannot take or use the desktop; once paired the request reaches the session', async () => {
  const dir = tmp();
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const f = fakeHelper();
  const desktop = createDesktopHost({
    helper: f.helper,
    probe: { ok: () => true, why: () => '', recheck: () => undefined },
    epochOf: (c: string) => epochs.current(c),
    maxReply: 1000,
  });
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }), send: async () => ({ turnId: 't1' }) };
  const protocol = createProtocol({
    runtime,
    epochs,
    guard: createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) }),
    status: () => ({ running: true }),
    desktop: createDesktopProtocol({ desktop, epochs }),
  });
  const paths = { dataDir: dir, socketPath: path.join(dir, 's.sock'), lockPath: path.join(dir, 'l.lock') };
  const pairing: any = { challenge: () => 'n', claim: () => ({}), verify: () => ({}), paired: () => 1 };
  const server = await startServer({ paths, protocol, pairing });
  const socket = net.connect(paths.socketPath);
  const lines: any[] = [];
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (c) => {
    buf += c;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) lines.push(JSON.parse(buf.slice(0, i))), (buf = buf.slice(i + 1));
  });
  const ask = async (id: number, method: string, params: object) => {
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    while (!lines.some((l) => l.id === id)) await tick();
    return lines.find((l) => l.id === id);
  };
  const scope = { chatId: 'claude:c1', epoch: 1 };
  try {
    for (const m of DESKTOP_METHODS) assert.equal((await ask(100 + DESKTOP_METHODS.indexOf(m), m, scope)).code, 'unknown_client');
    assert.deepEqual(f.calls, [], 'nothing reached the helper');
    await ask(1, 'host.auth', { publicKey: 'k', nonce: 'n', signature: 's' });
    assert.ok((await ask(2, 'host.hello', helloParams())).result.agreed);
    assert.deepEqual((await ask(3, 'desktop.lease', { ...scope, apps: '*' })).result, { leased: true });
  } finally {
    socket.destroy();
    await server.close();
  }
});

test('a resend after a reconnect gets the first answer: the click is not made twice', async () => {
  const s = build();
  let n = 0;
  s.helper.handler = async (m: string) => (m === 'input.click' ? { n: ++n } : {});
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  assert.deepEqual(await s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', { x: 1 }), { n: 1 });
  // the connection drops with the reply lost; the same chat leases again on a new connection and resends
  await s.host.closed(A);
  await s.host.lease(B, 'chat-a', 1, ['a.b']);
  assert.deepEqual(await s.host.call(B, 'chat-a', 1, 'call-0001', 'input.click', { x: 1 }), { n: 1 });
  assert.equal(s.calls.filter((c) => c.method === 'input.click').length, 1);
  // a new owner starts with an empty memory, and an old entry does not answer a new action
  await s.host.lease(B, 'chat-a', 2, ['a.b']);
  assert.deepEqual(await s.host.call(B, 'chat-a', 2, 'call-0001', 'input.click', { x: 1 }), { n: 2 });
  s.advance(10 * 60_000 + 1);
  assert.deepEqual(
    await s.host.call(B, 'chat-a', 2, 'call-0001', 'input.click', { x: 1 }),
    { n: 3 },
    'remembered for ten minutes, not for ever',
  );
});

test('only the latest chats’ memories are kept', async () => {
  const s = build();
  let n = 0;
  s.helper.handler = async (m: string) => (m === 'input.click' ? { n: ++n } : {});
  for (let i = 0; i < 17; i++) {
    await s.host.lease(A, `chat-${i}`, 1, ['a.b']);
    await s.host.call(A, `chat-${i}`, 1, 'call-0001', 'input.click', {});
    await s.host.release(A, `chat-${i}`, 1);
  }
  await s.host.lease(A, 'chat-0', 1, ['a.b']);
  assert.deepEqual(await s.host.call(A, 'chat-0', 1, 'call-0001', 'input.click', {}), { n: 18 }, 'the oldest chat’s memory was let go');
  assert.deepEqual(await s.host.call(A, 'chat-0', 1, 'call-0001', 'input.click', {}), { n: 18 }, 'its new one is kept');
});

test('a chat that moves to a new owner lets go of the desktop its old owner held', async () => {
  const s = build();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  const before = s.calls.length;
  await s.host.epochMoved('chat-other', 5);
  await s.host.epochMoved('chat-a', 1);
  assert.equal(s.host.state(A, 'chat-a').held, true, 'another chat, or the same epoch: nothing moves');
  await s.host.epochMoved('chat-a', 2);
  assert.equal(s.host.state(A, 'chat-a').held, false);
  assert.deepEqual(
    s.calls.slice(before).map((c) => c.method),
    ['input.release', 'control.release'],
  );
});

test('the service hears the epoch store: a request that advances the chat’s epoch ends the old lease at once', async () => {
  const dir = tmp();
  const epochs = createEpochStore(path.join(dir, 'e.json'), { report: () => undefined });
  const asked: string[] = [];
  const svc = createHostDesktop({
    dataDir: dir,
    env: {},
    epochs,
    platform: 'darwin',
    makeHelper: () =>
      ({
        installed: true,
        running: true,
        call: async (m: string) => (asked.push(m), { accessibility: true, screenRecording: true }),
        stop: () => undefined,
      }) as any,
  });
  svc.start();
  await tick();
  const seat = svc.protocol.connection();
  await seat.call('desktop.lease', { chatId: 'c1', epoch: 1, apps: ['a.b'] });
  assert.equal((await seat.call('desktop.state', { chatId: 'c1', epoch: 1 })).held, true);
  epochs.admit('c1', 2);
  await tick();
  assert.deepEqual(asked.slice(-2), ['input.release', 'control.release']);
  await svc.dispose();
  const after = asked.length;
  epochs.admit('c1', 3);
  await tick();
  assert.equal(asked.length, after, 'a disposed service no longer listens');
});

test('a helper that went and came back mid-lease: control is taken again, a write is refused once so the chat looks first, a read goes on', async () => {
  const s = build();
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  s.helper.running = false;
  const before = s.calls.length;
  await assert.rejects(
    s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', {}),
    (e: any) => e.code === 'helper_restarted' && /fresh screenshot/.test(e.message),
  );
  assert.deepEqual(
    s.calls.slice(before).map((c) => c.method),
    ['control.acquire'],
    'control again, and the click did not run',
  );
  s.helper.running = true;
  s.helper.generation += 1;
  // a helper another reading started since: it is up, but it is not the one that was given control
  await assert.rejects(s.host.call(A, 'chat-a', 1, 'call-0004', 'input.click', {}), (e: any) => e.code === 'helper_restarted');
  await s.host.call(A, 'chat-a', 1, 'call-0002', 'input.click', {});
  s.helper.running = false;
  await s.host.call(A, 'chat-a', 1, 'call-0003', 'screenshot', {});
  assert.deepEqual(
    s.calls.slice(-2).map((c) => c.method),
    ['control.acquire', 'screenshot'],
  );
});

test('a client that vanished without closing: the Host lets go of the lease when it has been idle too long, and any call keeps it', async () => {
  const s = build({ idleMs: 1000 });
  await s.host.lease(A, 'chat-a', 1, ['a.b']);
  const first = s.timers.at(-1)!;
  assert.equal(first.ms, 1000);
  await s.host.call(A, 'chat-a', 1, 'call-0001', 'input.click', {});
  assert.equal(first.cleared, true, 'a call starts the bound over');
  const second = s.timers.at(-1)!;
  assert.notEqual(second, first);
  const before = s.calls.length;
  second.fn();
  await tick();
  assert.equal(s.host.state(A, 'chat-a').held, false);
  assert.deepEqual(
    s.calls.slice(before).map((c) => c.method),
    ['input.release', 'control.release'],
  );
  // a bound that fires for a lease that already ended does nothing
  second.fn();
  await tick();
  assert.equal(s.calls.length, before + 2);
});

test('a launch that never ends is given up on: `open` is killed and the call fails, so the lease queue is not held behind it', async () => {
  const dir = tmp();
  let killed = 0;
  const client = createHelperClient({
    appPath: '/Apps/MoPilot Code.app',
    platform: 'darwin',
    exists: () => true,
    spawn: (() => Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: () => void killed++ })) as any,
    connectTimeoutMs: 50,
    callTimeoutMs: 50,
    tmp: dir,
  });
  await assert.rejects(
    client.call('screenshot'),
    (e: any) => e.reason === 'helper_unavailable' && /did not finish in 50 ms/.test(e.message),
  );
  assert.equal(killed, 1);
  assert.deepEqual(fs.readdirSync(dir), [], 'no private folder left behind');
  assert.equal(client.running, false);
});

test('a Host refused its data dir starts no desktop readings and lets its desktop go; one that serves starts them after it holds the dir', async () => {
  const dir = tmp();
  const paths = createPaths({ dataDir: dir, env: {} });
  const holder = await startServer({ paths });
  const log: string[] = [];
  const makeDesktop = () => ({
    protocol: { connection: () => ({ call: async () => ({}), close: () => undefined }) },
    available: () => false,
    start: () => void log.push('start'),
    dispose: async () => void log.push('dispose'),
  });
  const out: string[] = [];
  const quiet = { out: (l: string) => out.push(l), err: () => undefined, stopService: () => undefined, makeDesktop } as any;
  await assert.rejects(main(['serve', '--data-dir', dir], quiet), /already uses/);
  assert.deepEqual(log, ['dispose']);
  await holder.close();

  const dir2 = tmp();
  const signals: any = new EventEmitter();
  const log2: string[] = [];
  const served = main(['serve', '--data-dir', dir2], {
    out: (l: string) => log2.push(l.startsWith('Host serving') ? 'serving' : 'out'),
    err: () => undefined,
    stopService: () => undefined,
    signals,
    makeDesktop: () => ({ ...makeDesktop(), start: () => void log2.push('start'), dispose: async () => void log2.push('dispose') }),
  } as any);
  while (!log2.includes('start')) await tick();
  assert.ok(log2.indexOf('serving') < log2.indexOf('start'), 'the readings start once the Host serves');
  signals.emit('SIGTERM');
  assert.equal(await served, 0);
  assert.equal(log2.at(-1), 'dispose');
});
