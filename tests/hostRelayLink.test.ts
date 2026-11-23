// The Host's relay link (host/src/relayLink.mjs): an enrollment is kept owner-only and opens a link with the app's credential; the
// app, deriving the same root from the keys the Host answered with, opens a session and its streams reach the Host's own socket;
// the app going away ends the session; a 4403 or a removed pair forgets the enrollment; status never shows the secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRelayLinks, APP_ID } from '../host/src/relayLink.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createCrypto } from '../shared/remote/crypto.mjs';
import { fromBase64, toBase64 } from '../shared/remote/envelope.mjs';
import { createRelaySession, pipeSocket } from '../shared/host/relaySession.mjs';

const prim = createNodePrimitives();
const c = createCrypto(prim);
const HOST = 'h_host0000000000001';
const PAIR = 'p_hostpair01';
const SECRET = 'S'.repeat(43);
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await wait();
  }
  throw new Error(`timed out: ${what}`);
}

/** A fake relay: one socket per open, recording the token, delivering the Host's frames to `app`. */
function fakeRelay() {
  const sockets: any[] = [];
  let toApp: (f: any) => void = () => undefined;
  const createSocket = (url: string, headers: Record<string, string>) => {
    const s: any = {
      url,
      headers,
      sent: [] as any[],
      closed: null as number | null,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    s.send = (text: string) => {
      const m = JSON.parse(text);
      s.sent.push(m);
      if (m.t === 'frame') toApp(m);
      if (m.t === 'presence') s.onmessage?.({ data: JSON.stringify({ t: 'ok', op: 'presence', rid: m.rid }) });
    };
    s.close = (code: number) => (s.closed = code);
    s.say = (m: object) => s.onmessage?.({ data: JSON.stringify(m) });
    sockets.push(s);
    setImmediate(() => {
      s.onopen?.();
      s.say({ t: 'hello', device: HOST, kind: 'host', pairs: [{ pair: PAIR, role: 'phone', joined: true, peerOnline: true }] });
    });
    return s;
  };
  return { sockets, createSocket, setApp: (fn: (f: any) => void) => (toApp = fn), last: () => sockets[sockets.length - 1] };
}

async function rig(t: any) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rl-')));
  const socketPath = path.join(dir, 'h.sock');
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(socketPath, r));
  const relay = fakeRelay();
  const reports: string[] = [];
  const links = createRelayLinks({
    configDir: path.join(dir, 'config'),
    socketPath,
    createSocket: relay.createSocket,
    report: (m) => reports.push(m),
  });
  t.after(async () => {
    links.close();
    echo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, socketPath, relay, links, reports, file: path.join(dir, 'config', 'relay.json') };
}

/** The app's half of an enrollment: its keys, then the root from the Host's answer. */
function appHalf() {
  const sk = prim.randomBytes(32);
  const ephSk = prim.randomBytes(32);
  return {
    params: {
      relayUrl: 'wss://relay.example/v1/ws',
      hostId: HOST,
      secret: SECRET,
      pairId: PAIR,
      appPub: toBase64(prim.x25519Base(sk)),
      appEphPub: toBase64(prim.x25519Base(ephSk)),
    },
    root: (answer: { hostPub: string; hostEphPub: string }) =>
      c.deriveRoot(sk, fromBase64(answer.hostPub), ephSk, fromBase64(answer.hostEphPub), APP_ID, HOST, PAIR),
  };
}

test('an enrollment made for a phone keeps the client it belongs to; one made for an app names none', async (t) => {
  const r = await rig(t);
  const half = appHalf();
  r.links.enroll({ ...half.params, client: 'c'.repeat(64) });
  assert.equal(JSON.parse(fs.readFileSync(r.file, 'utf8')).links[0].client, 'c'.repeat(64));
  r.links.enroll(appHalf().params);
  assert.equal('client' in JSON.parse(fs.readFileSync(r.file, 'utf8')).links[0], false);
});

test('enroll keeps the credential owner-only, dials with it, and the app reaches the Host socket through a session', async (t) => {
  const r = await rig(t);
  const half = appHalf();
  const answer = r.links.enroll(half.params);
  assert.equal((fs.statSync(r.file).mode & 0o777).toString(8), '600');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(r.file, 'utf8')).links.map((e: any) => e.hostId),
    [HOST],
  );
  await until(() => r.relay.sockets.length === 1, 'the link dials');
  assert.equal(r.relay.last().headers.authorization, `Bearer mh1.${HOST}.${SECRET}`);
  assert.equal(r.relay.last().url, 'wss://relay.example/v1/ws');
  await until(() => r.links.status().links[0]?.relay === 'open', 'the link opens');
  const status = JSON.stringify(r.links.status());
  assert.ok(!status.includes(SECRET), 'status never shows the secret');

  const app = createRelaySession({
    prim,
    root: half.root(answer),
    pair: PAIR,
    role: 'app',
    send: (f) => (r.relay.last().say({ t: 'frame', ...f }), true),
  });
  r.relay.setApp((f) => app.handleFrame(f));
  await app.start();
  assert.equal(r.links.status().links[0].session, 'open');
  // a stream through the session reaches the echo server on the Host's socket
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rl-app-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const local = net.createServer();
  await new Promise<void>((res) => local.listen(path.join(dir, 'l.sock'), res));
  const accepted = new Promise<net.Socket>((res) => local.once('connection', res));
  const client = net.connect(path.join(dir, 'l.sock'));
  pipeSocket(app.openStream(), await accepted);
  const got: Buffer[] = [];
  client.on('data', (d) => got.push(d as Buffer));
  client.write('ping over the relay');
  await until(() => Buffer.concat(got).toString() === 'ping over the relay', 'the echo comes back');
  client.destroy();
  local.close();

  // the app goes away: the session ends; a peer_offline refusal does the same
  r.relay.last().say({ t: 'event', ev: 'peer', pair: PAIR, online: false });
  assert.equal(r.links.status().links[0].session, 'closed');
  r.relay.last().say({ t: 'error', code: 'peer_offline', pair: PAIR, ctr: 1 });
  r.relay.last().say({ t: 'event', ev: 'peer', pair: PAIR, online: true });
});

test('a 4403 from the relay or a removed pair forgets the enrollment; forget and a second enroll replace it', async (t) => {
  const r = await rig(t);
  r.links.enroll(appHalf().params);
  await until(() => r.links.status().links[0]?.relay === 'open', 'open');
  r.relay.last().onclose({ code: 4403 });
  assert.deepEqual(r.links.status().links, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).links, []);

  r.links.enroll(appHalf().params);
  r.links.enroll(appHalf().params);
  assert.equal(JSON.parse(fs.readFileSync(r.file, 'utf8')).links.length, 1, 'the same Host id is replaced');
  await until(() => r.links.status().links[0]?.relay === 'open', 'open again');
  r.relay.last().say({ t: 'event', ev: 'pair.removed', pair: PAIR, reason: 'revoked' });
  assert.deepEqual(r.links.status().links, []);
  assert.deepEqual(r.links.forget({ hostId: HOST }), { removed: false });
  r.links.enroll(appHalf().params);
  assert.deepEqual(r.links.forget({ hostId: HOST }), { removed: true });
  r.links.close();
  assert.throws(() => r.links.enroll(appHalf().params), /stopping/);
});

test('start opens a link for each kept enrollment, once; an unreadable file is reported and read as none', async (t) => {
  const r = await rig(t);
  r.links.enroll(appHalf().params);
  r.links.close();
  const again = createRelayLinks({ configDir: path.join(r.dir, 'config'), socketPath: r.socketPath, createSocket: r.relay.createSocket });
  t.after(() => again.close());
  again.start();
  again.start();
  assert.equal(again.status().links.length, 1);
  fs.writeFileSync(r.file, '{not json');
  const broken = createRelayLinks({
    configDir: path.join(r.dir, 'config'),
    socketPath: r.socketPath,
    createSocket: r.relay.createSocket,
    report: (m) => r.reports.push(m),
  });
  broken.start();
  assert.deepEqual(broken.status().links, []);
  assert.match(r.reports[0], /cannot be read/);
  fs.writeFileSync(r.file, JSON.stringify({ version: 1 }));
  broken.start();
  // the default report is quiet
  fs.writeFileSync(r.file, '{not json');
  const quiet = createRelayLinks({ configDir: path.join(r.dir, 'config'), socketPath: r.socketPath, createSocket: r.relay.createSocket });
  quiet.start();
  quiet.close();
  assert.deepEqual(broken.status().links, []);
  broken.close();
  // the default socket factory is Node's own WebSocket
  const plain = createRelayLinks({ configDir: path.join(r.dir, 'none'), socketPath: r.socketPath });
  plain.start();
  plain.close();
});
