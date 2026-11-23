// The browser requests on the Host wire (shared/host/browser.mjs, host/src/protocol.mjs and server.mjs, host/src/browserService.mjs, electron/host/remote.cjs; package 2.6): parsers, the feature gate, the Host's routing and pairing, and the proxy's side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
// @ts-ignore: plain ESM without declarations
import {
  PARSERS,
  REQUIRES,
  FEATURES,
  SchemaError,
  GateError,
  helloParams,
  negotiate,
  parseParams,
  requireFeatures,
} from '../shared/host/schema.mjs';
// @ts-ignore
import { BROWSER_METHODS } from '../shared/host/browser.mjs';
// @ts-ignore
import { createProtocol, UnsupportedError } from '../host/src/protocol.mjs';
// @ts-ignore
import { createBrowserProtocol } from '../host/src/browserProtocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { startServer } from '../host/src/server.mjs';
// @ts-ignore
import { createHostBrowser } from '../host/src/browserService.mjs';
// @ts-ignore
import { ChromiumError } from '../host/src/chromium.mjs';
import { world } from './support/browser-service-kit.ts';
import { hostWorld, onlineRemote, tick } from './support/host-wire-kit.ts';

const quiet = { report: () => undefined };
const scope = { chatId: 'claude:c1', epoch: 1 };

test('B1: every browser request has a parser that takes only what it names and refuses the rest', () => {
  assert.deepEqual(
    BROWSER_METHODS.filter((m: string) => !(m in PARSERS)),
    [],
  );
  assert.deepEqual(parseParams('browser.open', { ...scope, junk: 1 }), scope);
  for (const m of ['browser.tabs', 'browser.release', 'browser.abort']) assert.deepEqual(parseParams(m, scope), scope);
  for (const m of ['browser.attach', 'browser.detach', 'browser.close']) {
    assert.deepEqual(parseParams(m, { ...scope, targetId: 'AB12-cd:3' }), { ...scope, targetId: 'AB12-cd:3' });
    for (const targetId of [undefined, 7, '', 'has space', 'x'.repeat(201)])
      assert.throws(() => parseParams(m, { ...scope, targetId }), SchemaError);
    assert.throws(() => parseParams(m, { chatId: 'claude:c1', targetId: 'T' }), SchemaError);
    assert.throws(() => parseParams(m, { chatId: '', epoch: 1, targetId: 'T' }), SchemaError);
  }
  const base = { ...scope, targetId: 'T1', method: 'Page.navigate' };
  assert.deepEqual(parseParams('browser.command', base), { ...base, sessionId: '', params: {} });
  assert.deepEqual(parseParams('browser.command', { ...base, sessionId: 'S-1', params: { url: 'https://x.test/' } }).sessionId, 'S-1');
  assert.equal(parseParams('browser.command', { ...base, sessionId: null }).sessionId, '');
  for (const bad of [
    { sessionId: 5 },
    { sessionId: 'a b' },
    { method: 'nodot' },
    { method: 7 },
    { params: [] },
    { params: 'x' },
    { targetId: 5 },
  ])
    assert.throws(() => parseParams('browser.command', { ...base, ...bad }), SchemaError);
});

test('the browser feature gates every browser request: a Host or app without it is refused, not served degraded', () => {
  assert.ok(FEATURES.includes('browser'));
  for (const m of BROWSER_METHODS) assert.deepEqual(REQUIRES[m], ['epoch', 'browser']);
  const both = negotiate(helloParams(), helloParams());
  for (const m of BROWSER_METHODS) requireFeatures(m, both);
  const old = negotiate(helloParams(), { protocol: helloParams().protocol, features: ['epoch', 'dedupe', 'isolation', 'lanes'] });
  assert.throws(
    () => requireFeatures('browser.open', old),
    (e: any) => e instanceof GateError && e.missing.join() === 'browser',
  );
});

function host() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-wire-'));
  const w = world();
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }), send: async () => ({ turnId: 't1' }) };
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const make = (withBrowser: boolean) =>
    createProtocol({
      runtime,
      epochs,
      guard,
      status: () => ({ running: true }),
      ...(withBrowser ? { browser: createBrowserProtocol({ browser: w.host, epochs }) } : {}),
    });
  return { dir, w, make };
}

test("the protocol serves browser.* after hello, closes its tabs' events with the connection, and says so when the Host has no browser", async () => {
  const h = host();
  try {
    const out: any[] = [];
    const conn = h.make(true).connection((m: object) => out.push(m));
    await assert.rejects(conn.call('browser.open', scope), (e: any) => e.code === 'hello_required');
    await conn.call('host.hello', helloParams());
    const { targetId } = await conn.call('browser.open', scope);
    await conn.call('browser.attach', { ...scope, targetId });
    assert.equal((await conn.call('browser.command', { ...scope, targetId, method: 'Page.enable' })).constructor, Object);
    h.w.chromium.emit('Page.frameStartedLoading', { frameId: targetId }, h.w.chromium.sessionOf(targetId));
    assert.deepEqual(
      out.map((m) => [m.event, m.chatId, m.payload.method]),
      [['browser', 'claude:c1', 'Page.frameStartedLoading']],
    );
    conn.close();
    h.w.chromium.emit('Page.frameStoppedLoading', { frameId: targetId }, h.w.chromium.sessionOf(targetId));
    assert.equal(out.length, 1);
    // a peer without the browser feature is refused
    const old = h.make(true).connection(() => undefined);
    await old.call('host.hello', { protocol: helloParams().protocol, features: ['epoch', 'dedupe', 'isolation', 'lanes'] });
    await assert.rejects(old.call('browser.open', scope), (e: any) => e.code === 'feature_missing' && e.missing.includes('browser'));
    // a Host built without a browser
    const none = h.make(false).connection(() => undefined);
    await none.call('host.hello', helloParams());
    await assert.rejects(none.call('browser.open', scope), (e: any) => e instanceof UnsupportedError && e.code === 'unsupported');
    none.close();
  } finally {
    h.w.host.dispose();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the server routes browser.* to the connection's session, and an unpaired client cannot drive the browser", async () => {
  const h = host();
  const socketPaths = { dataDir: h.dir, socketPath: path.join(h.dir, 's.sock'), lockPath: path.join(h.dir, 'l.lock') };
  const pairing: any = { challenge: () => 'n', claim: () => ({}), verify: () => ({}), paired: () => 1 };
  const server = await startServer({ paths: socketPaths, protocol: h.make(true), pairing });
  const socket = net.connect(socketPaths.socketPath);
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
  try {
    for (const m of BROWSER_METHODS) assert.equal((await ask(100 + BROWSER_METHODS.indexOf(m), m, scope)).code, 'unknown_client');
    assert.equal(h.w.chromium.launches, 0);
    // once paired the request reaches the session; its failures keep their codes
    await ask(1, 'host.auth', { publicKey: 'k', nonce: 'n', signature: 's' });
    assert.ok((await ask(2, 'host.hello', helloParams())).result.agreed);
    const opened = await ask(3, 'browser.open', scope);
    assert.match(opened.result.targetId, /^T/);
    assert.equal((await ask(4, 'browser.attach', { ...scope, targetId: 'nope' })).code, 'not_owned');
    assert.equal((await ask(5, 'browser.open', { chatId: 'claude:c1' })).code, 'invalid');
  } finally {
    socket.destroy();
    await server.close();
    h.w.host.dispose();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('the Host builds its browser lazily on the Chromium it finds, under its data dir, and says so when there is none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-service-'));
  try {
    const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
    const launched: any[] = [];
    let found: string | null = null;
    const w = world();
    const svc = createHostBrowser({
      dataDir: dir,
      env: { MOPILOT_HOST_CHROME: '/opt/chrome', MOPILOT_HOST_BROWSER_DOWNLOAD: '0' },
      epochs,
      find: ({ env }: any) => (launched.push(['find', env.MOPILOT_HOST_CHROME]), found),
      launch: (async (o: any) => (launched.push(['launch', o]), w.chromium.launch())) as any,
    });
    assert.deepEqual(launched, []);
    const conn = svc.protocol.connection(() => undefined);
    await assert.rejects(
      conn.call('browser.open', scope),
      (e: any) => e instanceof ChromiumError && e.code === 'no_chromium' && /MOPILOT_HOST_CHROME/.test(e.message),
    );
    found = '/opt/chrome';
    await conn.call('browser.open', scope);
    assert.deepEqual(launched.at(-1), ['launch', { executable: '/opt/chrome', userDataDir: path.join(dir, 'browser') }]);
    assert.equal(path.dirname(w.chromium.sent('Browser.setDownloadBehavior')[0].params.downloadPath), path.join(dir, 'downloads'));
    svc.dispose();
    assert.equal(w.chromium.stops, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const withBrowser = () => ({ protocol: { minor: 1, floor: 1 }, features: [...FEATURES] });

test("the proxy sends browser.* under the chat's epoch, hands the Host's tab events to the app, and refuses what the Host cannot do", async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = withBrowser;
  const { host } = await onlineRemote(w, {}, { epochOf: (id: string) => (id === 'a' ? 4 : 0) });
  const seen: any[] = [];
  w.net.handlers['browser.open'] = (p) => (seen.push(p), { targetId: 'T1' });
  assert.deepEqual(await host.browser.request('browser.open', { chatId: 'a', extra: 1 }), { targetId: 'T1' });
  assert.deepEqual(seen[0], { chatId: 'a', epoch: 4 });
  // B1: a request the schema refuses never reaches the wire
  const writes = w.net.last.written.length;
  await assert.rejects(host.browser.request('browser.attach', { chatId: 'a' }), (e: any) => e.code === 'invalid');
  await assert.rejects(host.browser.request('browser.open', undefined as any), (e: any) => e.code === 'invalid');
  assert.equal(w.net.last.written.length, writes);
  // events of the chat's tabs
  const heard: any[] = [];
  const off = host.browser.onEvent((e: any) => heard.push(e));
  w.net.last.feed({ event: 'browser', chatId: 'a', payload: { type: 'cdp', targetId: 'T1' } });
  w.net.last.feed({ event: 'browser', chatId: 7, payload: { type: 'cdp' } });
  assert.deepEqual(heard, [{ chatId: 'a', payload: { type: 'cdp', targetId: 'T1' } }]);
  off();
  w.net.last.feed({ event: 'browser', chatId: 'a', payload: { type: 'cdp' } });
  assert.equal(heard.length, 1);
  host.browser.onEvent(() => undefined);
  host.dispose();
  assert.throws(
    () => host.browser.onEvent(() => undefined),
    (e: any) => e.code === 'disposed',
  );
});

test('a Host without the browser feature refuses browser.* before anything is sent', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = () => ({ protocol: { minor: 1, floor: 1 }, features: ['epoch', 'dedupe', 'isolation', 'lanes'] });
  const { host } = await onlineRemote(w);
  const before = w.net.last.written.length;
  await assert.rejects(
    host.browser.request('browser.open', { chatId: 'a' }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes('browser'),
  );
  assert.equal(w.net.last.written.length, before);
});
