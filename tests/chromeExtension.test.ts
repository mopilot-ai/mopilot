// Main's end of MoPilot's own Chrome extension (B2 step 2): the loopback server and its mutual handshake, the per-chat ports over one connection, waiting for and pairing the extension, the saved pairing, the channel choice, the app wiring and the health record.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { rawConnect, clientFrame, serverFrames, until, tick } from './support/chrome-relay-kit.ts';
import { EXTENSION_ORIGIN, memoryPairing, extensionWorld, emptyChromeFolder } from './support/chrome-extension-kit.ts';

const require = createRequire(import.meta.url);
const ext = require('../electron/capabilities/browser/chromeExtension.cjs');
const { ChromeExtensionChannel, ChatPort, proofOf, claimUrl, OPTIONS_PAGE, SOCKET_PATH } = ext;
const { ChromePairing, PREFERRED_PORT } = require('../electron/capabilities/browser/chromePairing.cjs');
const { chromeChannelKind, chromeControlOn } = require('../electron/capabilities/browser/chromeControl.cjs');
const { chromeRelayHealth } = require('../electron/capabilities/capabilityHealth.cjs');
const appRelay = require('../electron/app/chromeRelay.cjs');
const { ToolVisibility } = require('../electron/capabilities/visibility.cjs');
const { DEFAULTS } = require('../electron/platform/flags.cjs');
const { heldText } = await import('../shared/handoff.mjs');

test('the extension entrypoint preserves shared transport constructors, helpers and metadata', () => {
  const transport = require('../electron/capabilities/browser/chromeExtensionTransport.cjs');
  for (const name of [
    'ExtensionPeer',
    'ChatPort',
    'proofOf',
    'pairingCode',
    'claimUrl',
    'EXTENSION_ID',
    'EXTENSION_ORIGIN',
    'OPTIONS_PAGE',
    'PROTOCOL_VERSION',
  ]) {
    assert.equal(ext[name], transport[name]);
  }
});

const stops: (() => void)[] = [];
after(() => stops.forEach((s) => s()));
const code = (c: string, re?: RegExp) => (e: any) => e?.code === c && (!re || re.test(e.message));

function channel(o: any = {}) {
  const pairing = o.pairing ?? memoryPairing();
  const opened: string[] = [];
  const ch = new ChromeExtensionChannel({
    pairing,
    openPage: o.openPage ?? (async (url: string) => opened.push(url)),
    connectMs: 300,
    commandMs: 300,
    openMs: 300,
    authMs: o.authMs ?? 300,
    port: 0,
    ...o,
  });
  stops.push(() => ch.stop());
  return { ch, pairing, opened };
}

/** A raw client on the channel's socket: reads the server's frames as JSON. */
async function rawPeer(port: number, { origin = EXTENSION_ORIGIN, pathName = SOCKET_PATH } = {}) {
  const sock = await rawConnect(`ws://127.0.0.1:${port}${pathName}`, { origin });
  const got: any[] = [];
  const closes: number[] = [];
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  sock.on('data', (chunk: Buffer) => {
    const { frames, rest } = serverFrames(Buffer.concat([buf, chunk]));
    buf = rest;
    for (const f of frames) {
      if (f.opcode === 0x8) closes.push(f.payload.readUInt16BE(0));
      else got.push(JSON.parse(f.payload.toString()));
    }
  });
  sock.on('error', () => undefined);
  const send = (m: any) => sock.write(clientFrame(0x1, Buffer.from(typeof m === 'string' ? m : JSON.stringify(m))));
  /** proves the secret as the extension does */
  const auth = async (secret: string, o: any = {}) => {
    await until(() => got.some((m) => m.type === 'hello'));
    const hello = got.find((m) => m.type === 'hello');
    const nonce = o.nonce ?? crypto.randomBytes(16).toString('hex');
    send({
      type: 'auth',
      protocol: 1,
      nonce,
      proof: o.proof ?? proofOf(secret, 'extension', hello.nonce, nonce),
      version: o.version ?? '0.3.0',
    });
    return { hello, nonce };
  };
  return { sock, got, closes, send, auth };
}

test('the server: only the extension’s origin on its path is upgraded; a plain request is not found', async () => {
  const { ch } = channel();
  const port = await ch.start();
  assert.equal(await ch.start(), port, 'started once');
  await assert.rejects(rawConnect(`ws://127.0.0.1:${port}${SOCKET_PATH}`, { origin: 'https://evil.example' }), { status: 403 });
  await assert.rejects(rawConnect(`ws://127.0.0.1:${port}/other`, { origin: EXTENSION_ORIGIN }), { status: 403 });
  await assert.rejects(rawConnect(`ws://127.0.0.1:${port}${SOCKET_PATH}`, { origin: EXTENSION_ORIGIN, version: '8' }), { status: 400 });
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 404);
});

test('the handshake: the extension proves the secret and MoPilot proves it back; the extension is paired from then on', async () => {
  const { ch, pairing } = channel();
  const port = await ch.start();
  const secret = pairing.get().secret;
  assert.equal(ch.status().paired, false);
  const peer = await rawPeer(port);
  const { hello, nonce } = await peer.auth(secret);
  await until(() => peer.got.some((m) => m.type === 'welcome'));
  const welcome = peer.got.find((m) => m.type === 'welcome');
  assert.equal(welcome.proof, proofOf(secret, 'app', nonce, hello.nonce));
  await until(() => ch.peer?.open);
  assert.deepEqual(ch.status(), { paired: true, connected: true, version: '0.3.0', asking: false });
  // keepalive
  peer.send({ type: 'ping' });
  await until(() => peer.got.some((m) => m.type === 'pong'));
  // a message the channel can't read, or with no chat, is dropped
  peer.send('not json');
  peer.send('null');
  peer.send({ method: 'x' });
  peer.send({ chat: 'nobody', method: 'chrome.tabs.onRemoved', params: [1] });
  await tick(20);
  assert.ok(ch.peer?.open);
});

test('an impostor: a wrong proof, an old protocol, a short nonce or no handshake at all is closed and never trusted', async () => {
  const { ch, pairing } = channel({ authMs: 100 });
  const port = await ch.start();
  const secret = pairing.get().secret;
  // a proof of the right length in characters but not in bytes is refused, never thrown on
  for (const o of [{ proof: 'f'.repeat(64) }, { proof: 'short' }, { proof: 42 }, { proof: 'é'.repeat(64) }, { nonce: 'abc' }]) {
    const p = await rawPeer(port);
    await p.auth(secret, o);
    await until(() => p.closes.length);
    assert.deepEqual(p.closes, [4401]);
  }
  const old = await rawPeer(port);
  await until(() => old.got.length);
  old.send({ type: 'auth', protocol: 0, nonce: 'x'.repeat(32), proof: 'x' });
  await until(() => old.closes.length);
  const early = await rawPeer(port);
  await until(() => early.got.length);
  early.send({ chat: 'a', id: 1, result: {} });
  await until(() => early.closes.length);
  assert.deepEqual(early.closes, [4401]);
  const silent = await rawPeer(port);
  await until(() => silent.closes.length);
  assert.deepEqual(silent.closes, [4408]);
  assert.equal(ch.peer, null);
  assert.equal(ch.status().paired, false);
});

test('no pairing at all: the extension is turned away', async () => {
  const pairing = memoryPairing();
  const { ch } = channel({ pairing });
  const port = await ch.start();
  pairing.set(null);
  const p = await rawPeer(port);
  await until(() => p.closes.length);
  assert.deepEqual(p.closes, [4401]);
});

test('a newer connection that proves the secret replaces the older one; the older one’s chats are let go', async () => {
  const w = await extensionWorld();
  stops.push(w.stop);
  const link = await w.channel.connect('a');
  const first = w.channel.peer;
  const p = await rawPeer(w.port);
  await p.auth(w.pairing.get().secret, { version: 99 });
  await until(() => w.channel.peer !== first);
  assert.equal(w.channel.peer.version, null, 'a version that is not text is not kept');
  await until(() => link.closed);
  assert.equal(w.channel.connected('a'), false);
  // the old connection's close comes after: it changes nothing
  assert.ok(w.channel.peer.open);
});

test('ports: a chat’s frames carry the chat; closing tells the extension the session is over, once', () => {
  const sent: any[] = [];
  const peer = { open: true, send: (m: any) => sent.push(m) };
  const port = new ChatPort(peer, 'c');
  assert.equal(port.open, true);
  port.send(JSON.stringify({ id: 1, method: 'chrome.tabs.create', params: [], turn: 2 }));
  assert.deepEqual(sent[0], { id: 1, method: 'chrome.tabs.create', params: [], turn: 2, chat: 'c' });
  const closes: any[] = [];
  port.on('close', (c: number, r: string) => closes.push([c, r]));
  port.close();
  port.close();
  port.gone();
  assert.deepEqual(sent[1], { chat: 'c', method: 'session.close', params: [] });
  assert.equal(sent.length, 2);
  assert.deepEqual(closes, [[1000, '']]);
  assert.equal(port.open, false);
  const other = new ChatPort(peer, 'd');
  other.gone();
  assert.deepEqual(sent.length, 2, 'gone tells the extension nothing');
});

test('not connected: a paired extension is waited for and the error says to open Chrome with it on; an unpaired one gets its pairing page, once per wait', async () => {
  const a = channel({ installHint: 'Load it unpacked.' });
  await a.ch.start();
  a.pairing.markPaired();
  await assert.rejects(
    a.ch.connect('c'),
    code('not_connected', /did not connect within 0 s\. Make sure Chrome is open .*Load it unpacked\./),
  );
  assert.deepEqual(a.opened, [], 'no pairing page within the grace period of a paired extension');
  const b = channel();
  await assert.rejects(Promise.all([b.ch.connect('c1'), b.ch.connect('c2')]), code('not_connected', /isn't paired\. MoPilot opened/));
  assert.equal(b.opened.length, 1);
  assert.ok(b.opened[0].startsWith(`${OPTIONS_PAGE}#pair=`));
  // the page's URL reaches Chrome on its command line: a one-time claim code, never the secret
  const offered = decodeURIComponent(b.opened[0].split('#pair=')[1]);
  assert.match(offered, new RegExp(`^mopilot-claim:1:${b.pairing.get().port}:[A-Za-z0-9_-]{32}$`));
  assert.ok(!b.opened[0].includes(b.pairing.get().secret));
  assert.equal(b.opened[0], claimUrl(b.pairing.get().port, offered.split(':')[3]));
  // a pairing page that can't be opened is noted; the wait still ends with the error
  const c = channel({ openPage: async () => Promise.reject(new Error('no Chrome')) });
  await assert.rejects(c.ch.connect('c'), code('not_connected', /isn't paired/));
  // no saved pairing at all (it could not be read): nothing to offer
  const none = memoryPairing();
  const d = channel({ pairing: none });
  await d.ch.start();
  none.set(null);
  await assert.rejects(d.ch.connect('c'), code('not_connected', /isn't paired/));
  assert.deepEqual(d.opened, []);
});

test('the user pairs while the call waits: the claim code is traded for the pairing, and the call goes on once the extension proved it', async () => {
  const w = await extensionWorld({ paired: false, connectMs: 3000 });
  stops.push(w.stop);
  const linking = w.channel.connect('c');
  await until(() => w.opened.length === 1);
  assert.match(w.opened[0], /options\.html#pair=mopilot-claim%3A1%3A/);
  const code = await w.pressPair();
  assert.equal(code, `mopilot-chrome:1:${w.port}:${w.pairing.get().secret}`);
  await w.connectExtension();
  const link = await linking;
  assert.equal(link.open, true);
  assert.equal(w.pairing.get().paired, true);
  // the claim code works once
  assert.equal(await w.pressPair(), null);
});

test('a claim code that is wrong, expired, not a string or without a pairing behind it gets nothing', async () => {
  const pairing = memoryPairing();
  const { ch, opened } = channel({ pairing });
  const port = await ch.start();
  const claimOf = async (token: unknown) => {
    const p = await rawPeer(port);
    await until(() => p.got.length);
    p.send({ type: 'claim', protocol: 1, token });
    await until(() => p.closes.length);
    return p;
  };
  // nothing offered yet
  assert.deepEqual((await claimOf('x'.repeat(32))).closes, [4401]);
  ch.connectMs = 50;
  await assert.rejects(ch.connect('c'), code('not_connected'));
  const token = decodeURIComponent(opened[0].split('#pair=')[1]).split(':')[3];
  assert.deepEqual((await claimOf('y'.repeat(32))).closes, [4401]);
  assert.deepEqual((await claimOf(42)).closes, [4401]);
  const old = (await claimOf('x'.repeat(32))).got;
  assert.equal(old.length, 1, 'a hello and nothing else');
  ch.offers.current.until = 0;
  assert.deepEqual((await claimOf(token)).closes, [4401], 'expired');
  ch.offers.current.until = Date.now() + 60_000;
  pairing.set(null);
  // the pairing went (it could not be read): nothing to hand over; a new connection is turned away first
  const p = await rawPeer(port);
  await until(() => p.closes.length);
  assert.deepEqual(p.closes, [4401]);
  // a valid claim answers with the code and ends the connection
  const again = channel();
  const port2 = await again.ch.start();
  again.ch.connectMs = 50;
  await assert.rejects(again.ch.connect('c'), code('not_connected'));
  const t2 = decodeURIComponent(again.opened[0].split('#pair=')[1]).split(':')[3];
  const q = await rawPeer(port2);
  await until(() => q.got.length);
  again.pairing.get = () => null;
  q.send({ type: 'claim', protocol: 1, token: t2 });
  await until(() => q.closes.length);
  assert.deepEqual(q.closes, [4401], 'a claim with no pairing behind it gets nothing');
});

test('a paired extension that hasn’t connected after the grace period gets the pairing page: it starts Chrome and wakes the extension, or pairs again', async () => {
  const a = channel({ graceMs: 20 });
  await a.ch.start();
  a.pairing.markPaired();
  await assert.rejects(a.ch.connect('c'), code('not_connected', /did not connect within/));
  assert.equal(a.opened.length, 1);
  assert.match(a.opened[0], /#pair=mopilot-claim%3A1%3A/);
  // the extension connecting within the grace period: no page
  const w = await extensionWorld({ paired: false, graceMs: 200, connectMs: 3000 });
  stops.push(w.stop);
  w.pairing.markPaired();
  w.setCode(`mopilot-chrome:1:${w.port}:${w.pairing.get().secret}`);
  const linking = w.channel.connect('c');
  await w.connectExtension();
  await linking;
  await tick(250);
  assert.deepEqual(w.opened, []);
});

test('opening a chat’s session: the extension’s answer is waited for, a peer dropping or the chat going meanwhile fails it', async () => {
  // an extension that proves the secret but never opens sessions
  const { ch, pairing } = channel();
  const port = await ch.start();
  const p = await rawPeer(port);
  await p.auth(pairing.get().secret);
  await until(() => ch.peer?.open);
  await assert.rejects(ch.connect('c'), code('not_connected', /did not open this chat's session/));
  await until(() => p.got.some((m) => m.method === 'session.close'));
  assert.deepEqual(p.got.at(-1), { chat: 'c', method: 'session.close', params: [] }, 'the unused session is closed');
  assert.ok(p.got.some((m) => m.method === 'session.open' && m.params[0].title === 'MoPilot'));
  // the connection drops while the session opens
  const opening = ch.connect('d');
  await until(() => p.got.some((m) => m.chat === 'd'));
  p.sock.destroy();
  await assert.rejects(opening, code('not_connected', /disconnected/));
  assert.equal(ch.peer, null);
  // the chat is deleted while its session opens
  const w = await extensionWorld();
  stops.push(w.stop);
  const slow = w.sessions.open.bind(w.sessions);
  w.sessions.open = async (chat: string, o: any) => {
    w.channel.disconnect(chat);
    return slow(chat, o);
  };
  await assert.rejects(w.channel.connect('e'), code('not_connected', /closed while it opened/));
});

test('serving can’t start: the call says so; the next call tries again', async () => {
  let n = 0;
  const { ch } = channel({
    createServer: () => {
      n++;
      const s: any = new EventEmitter();
      s.listen = () => s.emit('error', Object.assign(new Error('EPERM'), { code: 'EPERM' }));
      s.close = () => undefined;
      return s;
    },
  });
  await assert.rejects(ch.connect('c'), code('not_connected', /Couldn't start serving MoPilot's Chrome extension: EPERM/));
  assert.equal(ch.serving, null);
  await assert.rejects(ch.connect('c'), code('not_connected'));
  assert.equal(n, 2);
});

test('the port: the one asked for, else the saved one, else the preferred one; a taken port falls back to another and the pairing follows it', async () => {
  const fakeServer = (taken: number[], seen: number[]) => () => {
    const s: any = new EventEmitter();
    s.listen = (port: number, _host: string, cb: () => void) => {
      seen.push(port);
      if (taken.includes(port)) return void s.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' }));
      s.port = port || 40000;
      cb();
    };
    s.address = () => ({ port: s.port });
    s.close = () => undefined;
    return s;
  };
  const seen: number[] = [];
  const saved = memoryPairing({ secret: 'C'.repeat(43), port: 41000, paired: true });
  const a = channel({ pairing: saved, port: undefined, createServer: fakeServer([], seen) });
  assert.equal(await a.ch.start(), 41000);
  assert.equal(saved.get().paired, true, 'the same port keeps the pairing');
  const fresh = memoryPairing();
  const b = channel({ pairing: fresh, port: undefined, createServer: fakeServer([PREFERRED_PORT], seen) });
  assert.equal(await b.ch.start(), 40000);
  assert.deepEqual(seen, [41000, PREFERRED_PORT, 0]);
  assert.equal(fresh.get().port, 40000);
  assert.equal(fresh.get().paired, false);
});

test('status reads a pairing that can’t be read as unpaired; marking it paired may fail without losing the connection', async () => {
  const pairing = memoryPairing();
  const { ch } = channel({ pairing });
  const port = await ch.start();
  const secret = pairing.get().secret;
  const get = pairing.get;
  pairing.get = () => {
    throw new Error('locked');
  };
  assert.deepEqual(ch.status(), { paired: false, connected: false, version: null, asking: false });
  pairing.get = get;
  pairing.markPaired = () => {
    throw new Error('disk full');
  };
  const p = await rawPeer(port);
  await p.auth(secret);
  await until(() => ch.peer?.open);
});

test('turns: every command carries its turn, and the extension hears when the chat’s turn ends', async () => {
  const w = await extensionWorld();
  stops.push(w.stop);
  await w.channel.connect('c');
  const tab = await w.channel.createTab(w.channel.token('c'));
  assert.ok(Number.isInteger(tab.id));
  w.channel.advance('c');
  await until(() => w.sessions.chats.get('c').turn === 1);
  w.channel.advance('nobody');
  assert.deepEqual(w.channel.frameFields({ chatId: 'c', turn: 4 }), { turn: 4 });
  // a command main would have let through but that arrives after the turn ended in the extension
  await assert.rejects(
    w.channel.ports.get('c') && (await w.channel.link('c')).send('chrome.debugger.attach', [{ tabId: tab.id }], { turn: 0 }),
    /turn that already ended/,
  );
});

test('a chat deleted with no session open: closed in the extension now when it is connected, else once it is back', async () => {
  const w = await extensionWorld();
  stops.push(w.stop);
  // the extension still holds the chat's session from before a restart
  await w.sessions.open('old', { title: 'old' });
  await w.sessions.command('old', 'chrome.tabs.create', [{}]);
  w.channel.disconnect('old');
  await until(() => !w.sessions.chats.has('old'));
  // away: remembered, and sent once the extension is back
  await w.sessions.open('gone', {});
  w.sockets[0].sock.destroy();
  await until(() => !w.channel.peer);
  w.channel.disconnect('gone');
  assert.ok(w.channel.closing.has('gone'));
  await w.connectExtension();
  await until(() => !w.sessions.chats.has('gone'));
  assert.equal(w.channel.closing.size, 0);
  // a chat whose session is still opening closes through it, not twice
  const opening = w.channel.connect('mid');
  w.channel.disconnect('mid');
  await assert.rejects(opening, code('not_connected'));
  assert.equal(w.channel.closing.has('mid'), false);
});

test('stop: every chat’s session closes, the extension’s connection and the server go; stopping again is harmless', async () => {
  const w = await extensionWorld();
  await w.channel.connect('c');
  await until(() => w.sessions.chats.has('c'));
  const closed = new Promise((r) => w.sessions.chats.get('c') && setTimeout(r, 50));
  w.channel.stop();
  await closed;
  assert.equal(w.sessions.chats.has('c'), false, 'the extension closed the session');
  assert.equal(w.channel.peer, null);
  assert.equal(w.channel.extServer, null);
  w.channel.stop();
  w.stop();
});

/* ---------- the saved pairing ---------- */

const safeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => {
    const t = b.toString();
    if (!t.startsWith('enc:')) throw new Error('bad');
    return t.slice(4);
  },
});

test('the saved pairing: a secret per port, encrypted on disk, kept while the port is the same', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-pair-'));
  const file = path.join(dir, 'sub', 'chrome-extension-pairing.json');
  const p = new ChromePairing({ file, safeStorage: safeStorage() });
  assert.equal(p.get(), null);
  p.markPaired();
  const a = p.forPort(47615);
  assert.match(a.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.paired, false);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(a.secret), 'never in plain text');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  p.markPaired();
  p.markPaired();
  assert.deepEqual(p.get(), { ...a, paired: true });
  assert.deepEqual(p.forPort(47615), { ...a, paired: true });
  const b = p.forPort(50000);
  assert.notEqual(b.secret, a.secret);
  assert.equal(b.paired, false);
  // a file that can't be read or decrypted reads as no pairing
  // read once: later reads come from memory (only this process writes the file)
  assert.deepEqual(new ChromePairing({ file, safeStorage: safeStorage() }).get(), b);
  // a file that can't be read or decrypted reads as no pairing
  const fresh = () => new ChromePairing({ file, safeStorage: safeStorage() });
  fs.writeFileSync(file, JSON.stringify({ secret: Buffer.from('plain').toString('base64'), port: 1 }));
  assert.equal(fresh().get(), null);
  assert.deepEqual(p.get(), b, 'the running app keeps what it wrote');
  fs.writeFileSync(file, JSON.stringify({ secret: 5, port: 1 }));
  assert.equal(fresh().get(), null);
  fs.writeFileSync(file, JSON.stringify({ secret: 'x' }));
  assert.equal(fresh().get(), null);
});

test('without encryption the pairing is kept in memory only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-pair-'));
  const file = path.join(dir, 'p.json');
  const p = new ChromePairing({ file, safeStorage: safeStorage(false) });
  const a = p.forPort(47615);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(p.get(), a);
  p.markPaired();
  assert.equal(p.get().paired, true);
});

/* ---------- the channel choice, visibility, health ---------- */

test('the channel: MoPilot’s extension wins over the relay; both are off by default', () => {
  const on =
    (...keys: string[]) =>
    (k: string) =>
      keys.includes(k);
  assert.equal(chromeChannelKind(on()), null);
  assert.equal(chromeChannelKind(on('shared.browser.chromeRelay')), 'relay');
  assert.equal(chromeChannelKind(on('shared.browser.chromeExtension')), 'extension');
  assert.equal(chromeChannelKind(on('shared.browser.chromeExtension', 'shared.browser.chromeRelay')), 'extension');
  assert.equal(chromeControlOn(on()), false);
  assert.equal(chromeControlOn(on('shared.browser.chromeExtension')), true);
  assert.equal(DEFAULTS['shared.browser.chromeExtension'], false);
  // the chrome_* tools show with the extension's switch alone
  const vis = new ToolVisibility({
    registry: { has: () => true },
    isEnabled: on('shared.browser.chromeExtension', 'shared.browser.parityTools'),
  });
  assert.equal(vis.hides('chrome_navigate'), false);
  const off = new ToolVisibility({ registry: { has: () => true }, isEnabled: on('shared.browser.parityTools') });
  assert.equal(off.hides('chrome_navigate'), true);
});

test('health: the extension’s own states, worded for the extension', () => {
  const base = { enabled: true, running: true, kind: 'extension' as const };
  assert.match(chromeRelayHealth({ ...base, enabled: false }).reason, /Chrome extension is turned off/);
  assert.match(chromeRelayHealth({ ...base, running: false }).reason, /Chrome extension was switched on after/);
  assert.deepEqual(chromeRelayHealth({ ...base }).state, 'permission');
  assert.equal(chromeRelayHealth({ ...base }).usable, true);
  const away = chromeRelayHealth({ ...base, paired: true });
  assert.equal(away.state, 'unknown');
  assert.match(away.reason, /isn't connected right now/);
  assert.deepEqual(chromeRelayHealth({ ...base, paired: true, connected: true }), {
    state: 'ready',
    usable: true,
    reason: null,
    fix: null,
  });
  // the relay's wording is unchanged
  assert.match(chromeRelayHealth({ enabled: false, running: false }).reason, /Chrome relay is turned off/);
});

/* ---------- the app wiring ---------- */

test('the install hint names the folder to load unpacked, or says a packaged build doesn’t ship it yet', () => {
  assert.match(appRelay.installHint(), /chrome:\/\/extensions.*Load unpacked and pick .*electron[\\/]chrome-extension\./);
  assert.equal(
    appRelay.installHint('/Applications/MoPilot.app/Contents/Resources/app.asar/electron/chrome-extension', null),
    "This build of MoPilot doesn't ship its Chrome extension yet.",
  );
  assert.ok(fs.existsSync(path.join(appRelay.EXTENSION_DIR, 'manifest.json')));
});

test('setup with the extension: its channel serves from startup, the tools and host run on it, and stop lets everything go', async (ctx) => {
  const registry = { register: mock.fn(() => () => undefined) };
  const onStatus = mock.fn();
  const pairing = memoryPairing({ secret: 'D'.repeat(43), port: 0, paired: false });
  const opened: string[] = [];
  emptyChromeFolder(ctx);
  const s = appRelay.setupChromeRelay({
    registry,
    grants: {},
    token: () => null,
    profileDir: () => 'Profile 2',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: (k: string) => k === 'shared.browser.chromeExtension',
    kind: 'extension',
    pairing,
    onStatus,
    open: async (url: string, o: any) => opened.push(`${o.profileDir} ${url}`),
  });
  stops.push(() => s.stop());
  assert.equal(s.kind, 'extension');
  assert.ok(s.relay instanceof ChromeExtensionChannel);
  await until(() => s.relay.extServer?.listening);
  assert.ok(registry.register.mock.callCount() > 5);
  const tool = (registry.register.mock.calls[0] as any).arguments[0];
  assert.ok(tool.name.startsWith('chrome_'));
  // the pairing page opens in the user's Chrome profile
  s.relay.connectMs = 50;
  await assert.rejects(s.relay.connect('c'), code('not_connected'));
  assert.match(opened[0], /^Profile 2 chrome-extension:\/\/[a-p]{32}\/options\.html#pair=/);
  // the extension connecting or going away tells the health record's readers
  s.relay.emit('peer', {});
  s.relay.emit('peerGone');
  assert.equal(onStatus.mock.callCount(), 2);
  s.stop();
  assert.equal(s.relay.extServer, null);
  // serving that fails at startup is noted, not thrown
  const broken = memoryPairing();
  broken.forPort = () => {
    throw new Error('no disk');
  };
  const t = appRelay.setupChromeRelay({
    registry,
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => false,
    kind: 'extension',
    pairing: broken,
  });
  await tick(20);
  t.relay.emit('peer', {});
  t.stop();
  // the relay stays the default channel
  const r = appRelay.setupChromeRelay({
    registry,
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => true,
  });
  assert.equal(r.kind, 'relay');
  assert.ok(!(r.relay instanceof ChromeExtensionChannel));
  r.stop();
});

/* ---------- leases and the handoff ---------- */

test('a Chrome tab still opening is leased under the host’s own id until Chrome gives it one', async () => {
  const { chromeBrowserTabs } = require('../electron/capabilities/browser/chromeHost.cjs');
  const w = await extensionWorld({ commandMs: 200 });
  stops.push(w.stop);
  const tabs = chromeBrowserTabs({ relay: w.channel, images: { fromBuffer: (b: Buffer) => b } });
  w.chrome.tabs.create = () => new Promise(() => undefined);
  const opening = tabs.create('c');
  opening.catch(() => undefined);
  await until(() => tabs.list('c').length === 1);
  const [lease] = tabs.leases('c');
  assert.equal(lease.surface, 'chromeTab');
  assert.equal(lease.id, tabs.list('c')[0].id);
  await assert.rejects(opening, code('timeout'));
});

test('a switch’s handoff names the chat’s Chrome tabs by Chrome’s tab id, with their site', () => {
  const text = heldText([
    { surface: 'chromeTab', id: '512', origin: 'agent', openedBy: 'agent', site: 'https://example.com', mark: 'handoff' },
    { surface: 'chromeTab', id: '513', origin: 'user', site: null, userTook: true },
    { surface: 'iab', id: 't1', origin: 'agent', site: 'https://a.test', popup: true },
  ]);
  assert.match(
    text,
    /- Your Chrome tab 512 \(in this chat's MoPilot tab group\): https:\/\/example\.com, opened by the agent, marked handoff/,
  );
  assert.match(text, /- Your Chrome tab 513 \(in this chat's MoPilot tab group\): no site loaded, the user's, taken over by the user/);
  assert.match(text, /- Built-in browser popup t1: https:\/\/a\.test, opened by the agent/);
  assert.match(text, /the Chrome tools for a Your Chrome tab/);
});
