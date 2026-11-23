// The Chrome relay (B2 step 1, design D5): the WebSocket server end (wsServer.cjs), the relay protocol to the
// Playwright Extension (chromeRelay.cjs) and browser host over Chrome (chromeHost.cjs), against a fake extension
// on loopback. The in-memory tab contracts live in chromeTabContents.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { clientFrame, FakeExtension, fakeChrome, playExtension, rawConnect, NO_ANSWER, tick, until } from './support/chrome-relay-kit.ts';

import { assertLegacyReports } from './support/chrome-relay-report-contract.ts';

const require = createRequire(import.meta.url);
const ws = require('../electron/capabilities/browser/wsServer.cjs');
const { ChromeRelay, EXTENSION_ORIGIN, CONNECT_PAGE } = require('../electron/capabilities/browser/chromeRelay.cjs');

test('the relay preserves the shared ChromeLink constructor and connection metadata', () => {
  const relay = require('../electron/capabilities/browser/chromeRelay.cjs');
  const transport = require('../electron/capabilities/browser/chromeLink.cjs');
  for (const name of ['ChromeLink', 'EXTENSION_ID', 'EXTENSION_ORIGIN', 'EXTENSION_URL', 'CONNECT_PAGE']) {
    assert.equal(relay[name], transport[name]);
  }
});
const { ChromeTabContents } = require('../electron/capabilities/browser/chromeTab.cjs');
const { chromeBrowserTabs, ChromeTabs } = require('../electron/capabilities/browser/chromeHost.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

const relays: any[] = [];
after(() => {
  for (const r of relays) r.stop();
});
const code = (c: string, re?: RegExp) => (e: any) => e?.code === c && (!re || re.test(e.message));

/* ------------------------------------------------------------------ wsServer */

function fakeSocket() {
  const s: any = new EventEmitter();
  s.writes = [] as Buffer[];
  s.destroyed = false;
  s.ended = false;
  s.write = (b: any) => s.writes.push(Buffer.from(b));
  s.end = (b?: any) => {
    if (b) s.writes.push(Buffer.from(b));
    s.ended = true;
  };
  return s;
}

test('wsServer: the accept key, and frames of every length class', () => {
  assert.equal(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.deepEqual([...ws.encodeFrame(1, Buffer.from('hi'))], [0x81, 2, 104, 105]);
  const mid = ws.encodeFrame(1, Buffer.alloc(300));
  assert.equal(mid[1], 126);
  assert.equal(mid.readUInt16BE(2), 300);
  const big = ws.encodeFrame(2, Buffer.alloc(70000));
  assert.equal(big[0], 0x82);
  assert.equal(big[1], 127);
  assert.equal(Number(big.readBigUInt64BE(2)), 70000);
});

test('wsServer: the parser waits for whole frames, unmasks them, and refuses unmasked or oversized ones', () => {
  assert.deepEqual(new ws.FrameParser(100).push(Buffer.from([0x81])), []);
  const p = new ws.FrameParser(100);
  const f = clientFrame(1, Buffer.from('hello'));
  assert.deepEqual(p.push(f.subarray(0, 3)), []);
  const out = p.push(f.subarray(3));
  assert.equal(out[0].payload.toString(), 'hello');
  assert.equal(out[0].fin, true);
  // a 16-bit length still arriving, then whole
  const p2 = new ws.FrameParser(1000);
  const f2 = clientFrame(1, Buffer.alloc(200, 97));
  assert.deepEqual(p2.push(f2.subarray(0, 3)), []);
  assert.equal(p2.push(f2.subarray(3))[0].payload.length, 200);
  // a 64-bit length still arriving
  const p3 = new ws.FrameParser(1 << 20);
  const f3 = clientFrame(1, Buffer.alloc(70000, 97));
  assert.deepEqual(p3.push(f3.subarray(0, 6)), []);
  assert.equal(p3.push(f3.subarray(6))[0].payload.length, 70000);
  assert.throws(
    () => new ws.FrameParser().push(clientFrame(1, Buffer.from('x'), { mask: false })),
    (e: any) => e.code === 1002,
  );
  assert.throws(
    () => new ws.FrameParser(100).push(clientFrame(1, Buffer.alloc(200))),
    (e: any) => e.code === 1009,
  );
  assert.throws(
    () => new ws.FrameParser(100).push(clientFrame(1, Buffer.alloc(70000))),
    (e: any) => e.code === 1009,
  );
  assert.ok(new ws.WsProtocolError(1002, 'x') instanceof Error);
});

test('wsServer: messages, fragments, ping, close and protocol errors on a connection', () => {
  const s = fakeSocket();
  const c = new ws.WsConnection(s, { maxBytes: 50 });
  const got: string[] = [];
  const closed: any[] = [];
  c.on('message', (t: string) => got.push(t));
  c.on('close', (code: number, reason: string) => closed.push([code, reason]));
  s.emit('data', clientFrame(1, Buffer.from('one')));
  s.emit('data', Buffer.concat([clientFrame(1, Buffer.from('tw'), { fin: false }), clientFrame(0, Buffer.from('o'))]));
  s.emit('data', clientFrame(9, Buffer.from('p')));
  s.emit('data', clientFrame(10, Buffer.from('q')));
  assert.deepEqual(got, ['one', 'two']);
  assert.deepEqual([...s.writes.at(-1)], [0x8a, 1, 112]);
  assert.equal(c.send('out'), true);
  assert.equal(c.open, true);
  // a close with a code and reason is answered and ends the socket; then nothing more is sent
  const body = Buffer.concat([Buffer.from([0x0f, 0xa0]), Buffer.from('bye')]);
  s.emit('data', Buffer.concat([clientFrame(8, body), clientFrame(1, Buffer.from('late'))]));
  assert.deepEqual(closed, [[4000, 'bye']]);
  assert.equal(s.ended, true);
  assert.equal(c.send('x'), false);
  c.close();
  s.emit('close');
  assert.equal(closed.length, 1);

  const cases: [Buffer[], number][] = [
    [[clientFrame(8, Buffer.alloc(0))], 1000],
    [[clientFrame(2, Buffer.from('b'))], 1003],
    [[clientFrame(0, Buffer.from('c'))], 1002],
    [[clientFrame(1, Buffer.from('a'), { fin: false }), clientFrame(1, Buffer.from('b'))], 1002],
    [[clientFrame(3, Buffer.from('?'))], 1002],
    [[clientFrame(1, Buffer.alloc(40), { fin: false }), clientFrame(0, Buffer.alloc(40))], 1009],
    [[clientFrame(1, Buffer.from('x'), { mask: false })], 1002],
  ];
  for (const [frames, want] of cases) {
    const s2 = fakeSocket();
    const c2 = new ws.WsConnection(s2, { maxBytes: 50 });
    const codes: number[] = [];
    c2.on('close', (code: number) => codes.push(code));
    for (const f of frames) s2.emit('data', f);
    assert.deepEqual(codes, [want]);
  }
  // the socket going is a close too, and a socket error is only noted
  const s3 = fakeSocket();
  const c3 = new ws.WsConnection(s3);
  const codes3: number[] = [];
  c3.on('close', (code: number) => codes3.push(code));
  s3.emit('error', new Error('reset'));
  s3.emit('close');
  assert.deepEqual(codes3, [1006]);
  assert.ok(recentIgnored().some((e: any) => /Chrome relay socket/.test(e.context)));
  // a socket destroyed under an open connection is not open
  const s4 = fakeSocket();
  const c4 = new ws.WsConnection(s4);
  s4.destroyed = true;
  assert.equal(c4.open, false);
});

test('wsServer: a request that is not a WebSocket handshake gets 400; bytes that came with it are read', () => {
  const s = fakeSocket();
  assert.equal(ws.acceptWebSocket({ headers: { upgrade: 'websocket' } }, s, Buffer.alloc(0)), null);
  assert.match(String(s.writes[0]), /^HTTP\/1.1 400/);
  for (const headers of [{}, { upgrade: 'websocket', 'sec-websocket-key': 'k', 'sec-websocket-version': '8' }]) {
    const s1 = fakeSocket();
    assert.equal(ws.acceptWebSocket({ headers }, s1, null), null);
  }
  const s2 = fakeSocket();
  const got: string[] = [];
  const req = { headers: { upgrade: 'WebSocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } };
  const origEmit = s2.emit.bind(s2);
  // the head arrives before anyone listens for messages: capture it at the socket
  s2.emit = (ev: string, ...a: any[]) => {
    if (ev === 'data') got.push('data');
    return origEmit(ev, ...a);
  };
  const c = ws.acceptWebSocket(req, s2, clientFrame(1, Buffer.from('early')));
  assert.ok(c);
  assert.match(String(s2.writes[0]), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  assert.deepEqual(got, ['data']);
  const none = ws.acceptWebSocket(req, fakeSocket(), Buffer.alloc(0));
  assert.ok(none);
});

/* ------------------------------------------------------------------ relay */

function relay(o: any = {}) {
  const r = new ChromeRelay({ connectMs: 2000, commandMs: 500, ...o });
  relays.push(r);
  return r;
}

test('relay: the connect page carries the relay URL, client name, protocol version and token; one connection per chat', async () => {
  const x = playExtension();
  const r = relay({ openPage: x.openPage, token: () => 'tok-1', clientName: (id: string) => `MoPilot · ${id}` });
  const seen: string[] = [];
  r.on('connected', (id: string) => seen.push(id));
  const [a, a2] = await Promise.all([r.connect('chat-a'), r.connect('chat-a')]);
  assert.equal(a, a2);
  assert.equal(await r.connect('chat-a'), a);
  assert.equal(x.urls.length, 1);
  const u = new URL(x.urls[0]);
  assert.equal(`${u.protocol}//${u.host}${u.pathname}`, CONNECT_PAGE);
  assert.match(u.searchParams.get('mcpRelayUrl') as string, /^ws:\/\/127\.0\.0\.1:\d+\/extension\/[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(u.searchParams.get('client') as string), { name: 'MoPilot · chat-a' });
  assert.equal(u.searchParams.get('protocolVersion'), '2');
  assert.equal(u.searchParams.get('token'), 'tok-1');
  assert.equal(r.connected('chat-a'), true);
  assert.equal(r.link('chat-a'), a);
  assert.equal(r.link('nope'), null);
  assert.equal(a.connectTab, [...a.tabs.keys()][0]);
  const b = await r.connect('chat-b');
  assert.notEqual(a, b);
  assert.deepEqual(seen, ['chat-a', 'chat-b']);
  // a plain HTTP request to the relay is not found
  const port = new URL(new URL(x.urls[0]).searchParams.get('mcpRelayUrl') as string).port;
  const status = await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/`, (res) => resolve(res.statusCode)));
  assert.equal(status, 404);
});

test('relay: without a token (or when reading it fails) the connect page asks the user; the default client name', async () => {
  const x = playExtension();
  const r = relay({ openPage: x.openPage, token: () => null });
  await r.connect('c');
  assert.equal(new URL(x.urls[0]).searchParams.has('token'), false);
  assert.deepEqual(JSON.parse(new URL(x.urls[0]).searchParams.get('client') as string), { name: 'MoPilot' });
  const x2 = playExtension();
  const r2 = relay({
    openPage: x2.openPage,
    token: () => {
      throw new Error('keychain locked');
    },
  });
  await r2.connect('c');
  assert.equal(new URL(x2.urls[0]).searchParams.has('token'), false);
  assert.ok(recentIgnored().some((e: any) => /connection token/.test(e.context)));
  const x3 = playExtension();
  const r3 = relay({ openPage: x3.openPage });
  await r3.connect('c');
  assert.equal(new URL(x3.urls[0]).searchParams.has('token'), false);
});

test('relay: only the extension origin may open a path it was given; anything else is refused', async () => {
  let url = '';
  const r = relay({
    openPage: (u: string) => {
      url = u;
    },
    connectMs: 400,
  });
  const p = r.connect('c').catch((e: any) => e);
  await until(() => url);
  const relayUrl = new URL(url).searchParams.get('mcpRelayUrl') as string;
  await assert.rejects(rawConnect(relayUrl, { origin: 'https://evil.test' }), (e: any) => e.status === 403);
  await assert.rejects(rawConnect(relayUrl.replace(/extension\/.*/, 'extension/other')), (e: any) => e.status === 403);
  // a bad handshake on the right path is answered 400 and the path stays open for the extension
  await assert.rejects(rawConnect(relayUrl, { version: '8' }), (e: any) => e.status === 400);
  const e = await p;
  assert.equal(e.code, 'not_connected');
  assert.match(e.message, /did not connect within 0 s.*Playwright Extension installed \(https:\/\/chromewebstore/);
  assert.equal(r.waiting.size, 0);
  // too late: the path is gone
  await assert.rejects(rawConnect(relayUrl), (e: any) => e.status === 403);
});

test('relay: failing to open the connect page, the extension closing before it is ready, a server that cannot listen', async () => {
  const r = relay({
    openPage: () => {
      throw new Error('no Chrome');
    },
  });
  await assert.rejects(r.connect('c'), code('not_connected', /^Couldn't open Chrome's connect page: no Chrome$/));
  const r1 = relay({
    openPage: () => {
      throw 'plain';
    },
  });
  await assert.rejects(r1.connect('c'), code('not_connected', /connect page: plain$/));

  const x = playExtension(fakeChrome(), { initialize: false });
  const r2 = relay({ openPage: x.openPage });
  const p = r2.connect('c');
  await until(() => x.connections.length);
  x.connections[0].close();
  await assert.rejects(p, code('not_connected', /closed the connection: connection lost/));
  assert.equal(r2.connected('c'), false);

  // the extension answers a ToolError of its own: it stays as it is
  const x3 = playExtension(fakeChrome(), { initialize: false });
  const r3 = relay({ openPage: x3.openPage, connectMs: 300 });
  await assert.rejects(r3.connect('c'), code('not_connected', /did not connect/));
  // the link that arrived but never got ready was closed
  await until(() => x3.connections[0]?.closes.length);
  assert.equal(x3.connections[0].closes[0].reason, 'not used');

  const failing = () => {
    const s: any = new EventEmitter();
    s.listen = () => setImmediate(() => s.emit('error', new Error('EADDRINUSE')));
    s.close = () => undefined;
    return s;
  };
  const r4 = relay({ openPage: () => undefined, createServer: failing });
  await assert.rejects(r4.connect('c'), code('not_connected', /^Couldn't start the Chrome relay: EADDRINUSE$/));
  assert.equal(r4.listening, null);
  const r5 = relay({
    openPage: () => undefined,
    createServer: () => {
      const s: any = new EventEmitter();
      s.listen = () => setImmediate(() => s.emit('error', 'raw'));
      s.close = () => undefined;
      return s;
    },
  });
  await assert.rejects(r5.connect('c'), code('not_connected', /relay: raw$/));
});

test('relay: commands carry a turn token; stale turns, other chats, unknown tabs and closed connections are refused', async () => {
  const x = playExtension();
  const r = relay({ openPage: x.openPage });
  const link = await r.connect('c');
  const tabId = link.connectTab;
  const tok = r.token('c');
  assert.deepEqual(tok, { chatId: 'c', turn: 0 });
  assert.ok(Object.isFrozen(tok));
  await r.attach(tok, tabId);
  x.chrome.cdp['Runtime.evaluate'] = { result: { value: 2 } };
  assert.deepEqual(await r.cdp(tok, { tabId }, 'Runtime.evaluate', { expression: '1+1' }), { result: { value: 2 } });
  await r.cdp(tok, { tabId, sessionId: 'S1' }, 'Page.enable');
  assert.deepEqual(x.chrome.log.at(-1), ['chrome.debugger.sendCommand', [{ tabId, sessionId: 'S1' }, 'Page.enable', {}]]);
  await assert.rejects(r.command(null, 'chrome.tabs.create', []), code('bad_args'));
  await assert.rejects(r.command({ chatId: 'c', turn: 'x' }, 'chrome.tabs.create', []), code('bad_args'));
  await assert.rejects(r.command(tok, 'chrome.tabs.query', []), code('bad_args', /not a Chrome relay command/));
  await assert.rejects(r.cdp(tok, { tabId: 9999 }, 'Page.enable'), code('bad_target', /9999 is not one of this chat's tabs/));
  await assert.rejects(r.cdp(r.token('other'), { tabId }, 'Page.enable'), code('not_connected'));
  r.advance('c');
  const before = x.chrome.log.length;
  await assert.rejects(r.cdp(tok, { tabId }, 'Page.enable'), code('stale_turn'));
  assert.equal(x.chrome.log.length, before, 'a stale command never reaches Chrome');
  // letting go is never refused for its turn
  await r.detach(tok, tabId);
  assert.equal(x.chrome.attached.has(tabId), false);
  const fresh = r.token('c');
  assert.equal(fresh.turn, 1);
  const tab = await r.createTab(fresh, 'https://a.test/');
  assert.ok(link.tabs.has(tab.id));
  await r.removeTab(tok, tab.id);
  assert.equal(x.chrome.tabs.has(tab.id), false);
});

test('relay: Chrome errors, unanswered commands, a bad created tab and a connection that drops mid-command', async () => {
  const x = playExtension();
  const r = relay({ openPage: x.openPage, commandMs: 100 });
  const link = await r.connect('c');
  const tabId = link.connectTab;
  const tok = r.token('c');
  x.chrome.cdp['Page.navigate'] = new Error('Cannot navigate');
  await assert.rejects(
    r.cdp(tok, { tabId }, 'Page.navigate', { url: 'x' }),
    code('failed', /^Chrome refused chrome.debugger.sendCommand: Cannot navigate$/),
  );
  x.connections[0].handle = () => {
    throw Object.assign(new Error(''), { message: '' });
  };
  // an error object rather than a string
  x.connections[0].handle = async () => NO_ANSWER;
  const pending = r.cdp(tok, { tabId }, 'Page.enable');
  const [m] = await new Promise<any[]>((res) => x.connections[0].once('command', (c: any) => res([c])));
  x.connections[0].send({ id: m.id, error: { message: 'object error' } });
  await assert.rejects(pending, code('failed', /object error$/));
  await assert.rejects(r.cdp(tok, { tabId }, 'Page.enable'), code('timeout', /did not answer chrome.debugger.sendCommand within 0 s/));
  // a late answer to a command that timed out is dropped
  x.connections[0].send({ id: 9999, result: {} });
  x.connections[0].handle = () => ({ notATab: true });
  await assert.rejects(r.createTab(tok), code('failed', /didn't open a tab/));
  x.connections[0].handle = async () => NO_ANSWER;
  const dropped = r.cdp(tok, { tabId }, 'Page.enable');
  await tick(10);
  const gone: string[] = [];
  r.on('disconnected', (id: string) => gone.push(id));
  x.connections[0].close();
  await assert.rejects(dropped, code('not_connected', /disconnected from this chat/));
  await until(() => gone.length);
  assert.equal(r.connected('c'), false);
  await assert.rejects(link.send('chrome.tabs.create', []), code('not_connected'));
});

test('relay: what the extension reports - tabs, removals, CDP events, detaches - and what it is ignored', async () => {
  const x = playExtension();
  const r = relay({ openPage: x.openPage });
  const link = await r.connect('c');
  await assertLegacyReports(link, x.connections[0]);
});

test('relay: the default timeouts; a close frame without a reason', async () => {
  const d = new ChromeRelay({ openPage: () => undefined });
  assert.equal(d.connectMs, 30_000);
  assert.equal(d.commandMs, 20_000);
  const x = playExtension();
  const r = relay({ openPage: x.openPage });
  const link = await r.connect('c');
  const reasons: string[] = [];
  link.on('closed', (why: string) => reasons.push(why));
  x.connections[0].raw(clientFrame(8, Buffer.alloc(0)));
  await until(() => reasons.length);
  assert.deepEqual(reasons, ['closed']);
});

test('relay: disconnect and stop close the connections and the server', async () => {
  const x = playExtension();
  const r = relay({ openPage: x.openPage });
  await r.connect('a');
  await r.connect('b');
  r.advance('a');
  r.disconnect('a');
  assert.equal(r.connected('a'), false);
  assert.equal(r.token('a').turn, 1, 'an old token never becomes current again');
  await until(() => x.connections[0].closes.length);
  assert.equal(x.connections[0].closes[0].reason, 'MoPilot closed the connection');
  r.disconnect('nobody');
  r.stop();
  assert.equal(r.connected('b'), false);
  assert.equal(r.server, null);
  r.stop();
  // it starts again on the next connect
  const x2 = playExtension();
  r.o.openPage = x2.openPage;
  await r.connect('a');
  assert.equal(r.connected('a'), true);
});

/* ------------------------------------------------------------------ the host over Chrome */

const images = { fromBuffer: (b: Buffer) => ({ b, isEmpty: () => false, toBitmap: () => Buffer.from([255, 255, 255, 255]) }) };

async function chromeWorld(o: any = {}) {
  const x = playExtension(fakeChrome(), o.play);
  const r = relay({ openPage: x.openPage, ...o.relay });
  const changes: string[] = [];
  const tabs = chromeBrowserTabs({ relay: r, images, onChange: (id: string) => changes.push(id) });
  return { x, r, tabs, changes };
}

test('chromeHost: the first tab is the connect page tab, later ones are new tabs in Chrome; close removes them', async () => {
  const { x, r, tabs } = await chromeWorld();
  const t1 = await tabs.create('c', { focus: true });
  const link = r.link('c');
  assert.equal(t1.wc.tabId, [...link.tabs.keys()][0]);
  assert.equal(link.connectTab, null);
  assert.equal(t1.created, true);
  const t2 = await tabs.create('c');
  assert.ok(x.chrome.log.some((l: any) => l[0] === 'chrome.tabs.create'));
  assert.notEqual(t2.wc.tabId, t1.wc.tabId);
  assert.deepEqual(
    tabs.list('c').map((t: any) => t.id),
    [t1.id, t2.id],
  );
  await tabs.close('c', t2.id);
  assert.equal(x.chrome.tabs.has(t2.wc.tabId), false);
  assert.equal(tabs.list('c').length, 1);
  assert.equal(tabs.select('c', t1.id), t1);
});

test('chromeHost: a chat whose extension does not connect fails to open a tab with not_connected, and keeps no tab', async () => {
  const r = relay({ openPage: () => undefined, connectMs: 100 });
  const tabs = chromeBrowserTabs({ relay: r, images });
  await assert.rejects(tabs.create('c'), code('not_connected'));
  assert.equal(tabs.list('c').length, 0);
  // Chrome refusing to open a tab: the tab goes and the call fails with Chrome's reason
  const { x, tabs: t2 } = await chromeWorld();
  await t2.create('c');
  x.connections[0].handle = () => {
    throw new Error('Tabs cannot be edited right now');
  };
  await assert.rejects(t2.create('c'), /Tabs cannot be edited right now/);
  await until(() => t2.list('c').length === 1);
});

test('chromeHost: a tab asked for in a turn that ended while Chrome asked to approve the connection is not opened', async () => {
  const x = playExtension();
  let release: any;
  const r = relay({
    openPage: async (u: string) => {
      await new Promise((res) => (release = res));
      await x.openPage(u);
    },
  });
  const tabs = chromeBrowserTabs({ relay: r, images });
  const p = tabs.create('c');
  await until(() => release);
  await tabs.turnEnded('c');
  release();
  await assert.rejects(p, code('stale_turn'));
  assert.equal(tabs.list('c').length, 0);
  assert.equal(x.chrome.log.filter((l: any) => l[0] === 'chrome.tabs.create').length, 0);
});

test('chromeHost: closing a tab Chrome is still opening closes it in Chrome once it exists', async () => {
  const { x, r, tabs } = await chromeWorld();
  await tabs.create('c');
  let answer: any;
  x.connections[0].handle = async (m: string, p: any[]) => {
    if (m === 'chrome.tabs.create') await new Promise((res) => (answer = res));
    return x.chrome.handle(m, p);
  };
  const wc = new ChromeTabContents({ relay: r, chatId: 'c', open: r.createTab(r.token('c')) });
  tabs.o.close({ backend: wc, chatId: 'c' });
  assert.equal(wc.isDestroyed(), true);
  await until(() => answer);
  answer();
  await until(() => x.chrome.log.some((l: any) => l[0] === 'chrome.tabs.remove' && l[1][0] === wc.tabId));
  // one that never opens has nothing to close
  const never = new ChromeTabContents({ relay: r, chatId: 'c', open: Promise.reject(new Error('no')) });
  tabs.o.close({ backend: never, chatId: 'c' });
  await tick(5);
});

test('relay: deleting the chat or stopping the relay while it connects drops the connection that opens', async () => {
  for (const end of ['disconnect', 'stop']) {
    const x = playExtension();
    let release: any;
    const r = relay({
      openPage: async (u: string) => {
        await new Promise((res) => (release = res));
        await x.openPage(u);
      },
    });
    const p = r.connect('c');
    await until(() => release);
    if (end === 'disconnect') r.disconnect('c');
    else r.stop();
    release();
    // deleted: the connection that still arrives is closed; stopped: the server is gone, so it cannot arrive
    await assert.rejects(p, code('not_connected', end === 'disconnect' ? /closed while it opened/ : /ECONNREFUSED/));
    assert.equal(r.connected('c'), false);
    if (end === 'disconnect') await until(() => x.connections[0]?.closes.length);
  }
});

test('chromeHost: events reach the right tab; a popup joins the chat; Chrome closing a tab or the connection lets go', async () => {
  const { x, r, tabs, changes } = await chromeWorld();
  const t1 = await tabs.create('c');
  const ext = x.connections[0];
  await tabs.ready(t1, 'c');
  const msgs: string[] = [];
  t1.wc.debugger.on('message', (_e: any, m: string) => msgs.push(m));
  ext.event('chrome.debugger.onEvent', { tabId: t1.wc.tabId }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'hi' }] });
  ext.event('chrome.debugger.onEvent', { tabId: 4242 }, 'Runtime.consoleAPICalled', { type: 'log', args: [] });
  await until(() => msgs.length);
  assert.equal(t1.console.at(-1).text, 'hi');

  // a popup of the chat's tab joins its tabs; one of an unknown opener, a known tab or a connect page does not
  ext.event('chrome.tabs.onCreated', { id: 904, openerTabId: t1.wc.tabId });
  ext.event('chrome.tabs.onCreated', { id: 900, url: 'https://pop.test/', openerTabId: t1.wc.tabId });
  ext.event('chrome.tabs.onCreated', { id: 901, url: 'https://x.test/', openerTabId: 4242 });
  ext.event('chrome.tabs.onCreated', { id: 902, url: 'https://x.test/' });
  ext.event('chrome.tabs.onCreated', { id: 900, url: 'https://pop.test/', openerTabId: t1.wc.tabId });
  ext.event('chrome.tabs.onCreated', { id: 903, url: `${CONNECT_PAGE}?x`, openerTabId: t1.wc.tabId });
  await until(() => tabs.list('c').length === 3);
  await tick(20);
  assert.equal(tabs.list('c').length, 3);
  const pop = tabs.current('c');
  assert.equal(pop.wc.tabId, 900);
  assert.ok(changes.includes('c'));

  // the debugger lost, then the tab closed in Chrome
  await tabs.ready(pop, 'c');
  let detached = 0;
  pop.wc.debugger.on('detach', () => detached++);
  ext.event('chrome.debugger.onDetach', { tabId: 900 }, 'canceled_by_user');
  ext.event('chrome.debugger.onDetach', { tabId: 4242 }, 'canceled_by_user');
  await until(() => detached);
  ext.event('chrome.tabs.onRemoved', 900);
  ext.event('chrome.tabs.onRemoved', 4242);
  await until(() => tabs.list('c').length === 2);

  // the connection drops: every tab of the chat goes
  ext.close();
  await until(() => tabs.list('c').length === 0);
  assert.equal(r.connected('c'), false);
  // a chat that connected but opened no tab: its connection going has nothing to let go
  await r.connect('d');
  x.connections[1].close();
  await until(() => !r.connected('d'));
});

test('chromeHost: the turn end starts a new relay turn after the host let go; forgetting a chat drops its connection; dispose', async () => {
  const { x, r, tabs } = await chromeWorld();
  const kept = await tabs.create('c');
  kept.created = false;
  await tabs.ready(kept, 'c');
  const temp = await tabs.create('c');
  await tabs.ready(temp, 'c');
  const out = await tabs.turnEnded('c');
  assert.equal(r.token('c').turn, 1);
  assert.deepEqual(out.kept.sort(), [kept.id, temp.id].sort(), 'every Chrome tab stays in the chat’s group');
  assert.equal(kept.wc.debugger.isAttached(), false);
  await until(() => x.chrome.log.some((l: any) => l[0] === 'chrome.debugger.detach'));
  // a tab whose relay id never came is closed without Chrome
  const pending = new ChromeTabContents({ relay: r, chatId: 'c', open: new Promise(() => undefined) });
  tabs.o.close({ backend: pending, chatId: 'c' });
  assert.equal(pending.isDestroyed(), true);
  // a close Chrome refuses is only noted
  x.connections[0].handle = () => {
    throw new Error('No tab with id');
  };
  tabs.o.close({ backend: kept.wc, chatId: 'c' });
  await until(() => recentIgnored().some((e: any) => /close a Chrome tab over the relay/.test(e.context)));
  tabs.forget('c');
  await until(() => x.connections[0].closes.length);
  assert.equal(r.connected('c'), false);
  tabs.dispose();
  assert.equal(r.listenerCount('connected'), 0);
  // a host not wired to a relay's events has nothing to stop
  new ChromeTabs({ appContents: () => [], panelSession: () => null, open: () => true, close() {}, select() {}, images }, r).dispose();
  assert.equal(tabs.o.open(), true);
  assert.equal(tabs.o.select(), undefined);
  assert.deepEqual(tabs.o.appContents(), []);
  assert.equal(tabs.o.panelSession(), null);
  assert.equal(EXTENSION_ORIGIN, 'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm');
  void FakeExtension;
});
