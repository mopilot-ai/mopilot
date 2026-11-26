// A removed controller's relay link on the Host (host/src/relayLink.mjs retire, #5747): the link stays as a tombstone, kept on disk, whose streams never reach the Host's socket and only say the client was removed; no request authenticates through it, before or after a restart; it is forgotten when the other Mac removes the pair, when its time is up (on start, on use and by the sweep) or when it is the oldest past the most kept, and each step is told for the audit record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRelayLinks, retireEnrollments, APP_ID } from '../host/src/relayLink.mjs';
// @ts-ignore: plain ESM without declarations
import { MAX_TOMBSTONES, SWEEP_MS, TOMBSTONE_MS } from '../host/src/relayTombstone.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createCrypto } from '../shared/remote/crypto.mjs';
import { fromBase64, toBase64 } from '../shared/remote/envelope.mjs';
import { createRelaySession } from '../shared/host/relaySession.mjs';
// @ts-ignore
import { createDecoder, encodeControl } from '../shared/host/frames.mjs';

const prim = createNodePrimitives();
const c = createCrypto(prim);
const HOST = 'h_tomb000000000001';
const PAIR = 'p_tombpair01';
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await wait();
  }
  throw new Error(`timed out: ${what}`);
}

/** A fake relay: one socket per dial, the Host's frames handed to `app`. */
function fakeRelay() {
  const sockets: any[] = [];
  let toApp: (f: any) => void = () => undefined;
  const createSocket = () => {
    const s: any = { sent: [], onopen: null, onmessage: null, onclose: null, onerror: null };
    s.send = (text: string) => {
      const m = JSON.parse(text);
      if (m.t === 'frame') toApp(m);
      if (m.t === 'presence') s.onmessage?.({ data: JSON.stringify({ t: 'ok', op: 'presence', rid: m.rid }) });
    };
    s.close = () => undefined;
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rlt-')));
  const socketPath = path.join(dir, 'h.sock');
  // the Host's own socket: a tombstone must never reach it
  let reached = 0;
  const hostSocket = net.createServer((s) => (reached++, s.pipe(s)));
  await new Promise<void>((r) => hostSocket.listen(socketPath, r));
  const relay = fakeRelay();
  const clock = { now: 1_000_000 };
  const told: any[] = [];
  const sweeps: (() => void)[] = [];
  const stopped: number[] = [];
  const make = () => {
    const links = createRelayLinks({
      configDir: path.join(dir, 'config'),
      socketPath,
      createSocket: relay.createSocket,
      now: () => clock.now,
      every: (fn, ms) => (assert.equal(ms, SWEEP_MS), sweeps.push(fn), () => void stopped.push(1)),
    });
    links.onTombstone((e) => told.push(e));
    t.after(() => links.close());
    return links;
  };
  t.after(() => {
    hostSocket.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, relay, clock, told, sweeps, stopped, make, reached: () => reached, file: path.join(dir, 'config', 'relay.json') };
}

/** Enrolls the link as a pairing by code does (`createOnly`: a controller's link; false: the Mac app's own), and answers with the app's root for it. */
function enrollApp(links: any, hostId = HOST, pairId = PAIR, createOnly = true) {
  const sk = prim.randomBytes(32);
  const ephSk = prim.randomBytes(32);
  // made by pairing by code: a controller's link
  const answer = links.enroll(
    {
      relayUrl: 'wss://relay.example/v1/ws',
      hostId,
      secret: 'S'.repeat(43),
      pairId,
      appPub: toBase64(prim.x25519Base(sk)),
      appEphPub: toBase64(prim.x25519Base(ephSk)),
    },
    { createOnly },
  );
  return c.deriveRoot(sk, fromBase64(answer.hostPub), ephSk, fromBase64(answer.hostEphPub), APP_ID, hostId, pairId);
}

/** The app's side: a session on the relay's latest socket, and one request per stream with the Host's answer. */
async function appAsks(r: any, root: Uint8Array, lines: object[]) {
  const app = createRelaySession({ prim, root, pair: PAIR, role: 'app', send: (f) => (r.relay.last().say({ t: 'frame', ...f }), true) });
  r.relay.setApp((f: any) => app.handleFrame(f));
  await app.start();
  const answers: any[] = [];
  for (const line of lines) {
    const stream: any = app.openStream();
    const decoder = createDecoder();
    const got: any[] = [];
    stream.onData = (b: Uint8Array) => (stream.consumed(b.length), got.push(...decoder.push(b).map((f: any) => f.message)));
    stream.write(new Uint8Array(encodeControl(line)));
    await until(() => got.length > 0, `an answer to ${JSON.stringify(line)}`);
    answers.push(got[0]);
    stream.reset();
  }
  app.close('done');
  return answers;
}

const ASKS = [
  { id: 1, method: 'ping' },
  { id: 2, method: 'host.challenge' },
  { id: 3, method: 'host.auth', params: { publicKey: 'k', nonce: 'n', signature: 's' } },
  { id: 4, method: 'host.pair', params: { code: '123456', publicKey: 'k', nonce: 'n', signature: 's' } },
  { id: 5, method: 'host.hello', params: {} },
  { id: 6, method: 'status' },
];
const assertRefused = (answers: any[]) => {
  assert.deepEqual(answers[0], { id: 1, result: 'pong' });
  for (const a of answers.slice(1)) {
    assert.equal(a.code, 'unknown_client');
    assert.deepEqual(a.details, { linkRemoved: true });
    assert.equal('result' in a, false);
  }
};

test('a retired link is a tombstone: kept on disk, its session ended, and no request authenticates through it, before or after a Host restart', async (t) => {
  const r = await rig(t);
  const links = r.make();
  const root = enrollApp(links);
  await until(() => links.status().links[0]?.relay === 'open', 'the link opens');
  // before the removal a stream reaches the Host's socket (an echo here)
  assert.deepEqual(await appAsks(r, root, [{ id: 1, method: 'ping' }]), [{ id: 1, method: 'ping' }]);
  assert.equal(r.reached(), 1);

  assert.deepEqual(links.retire({ hostId: HOST }), { retired: true });
  assert.deepEqual(r.told, [{ kind: 'link.retired', outcome: 'kept' }]);
  assert.equal(JSON.parse(fs.readFileSync(r.file, 'utf8')).links[0].retiredAt, r.clock.now);
  assert.equal(links.status().links[0].session, 'closed', 'the session on it ends at once');
  assert.equal(links.status().links[0].retired, true);
  r.clock.now += 5;
  assert.deepEqual(links.retire({ hostId: HOST }), { retired: true }, 'retiring again is safe');
  assert.equal(JSON.parse(fs.readFileSync(r.file, 'utf8')).links[0].retiredAt, r.clock.now - 5, 'and keeps its time');
  assert.equal(r.told.length, 1);

  assertRefused(await appAsks(r, root, ASKS));
  assert.equal(r.reached(), 1, 'the Host socket is never reached through a tombstone');

  // a restart keeps the tombstone, and it still refuses
  links.close();
  const again = r.make();
  again.start();
  await until(() => again.status().links[0]?.relay === 'open', 'the tombstone dials again');
  assert.equal(again.status().links[0].retired, true);
  assertRefused(await appAsks(r, root, ASKS));
  assert.equal(r.reached(), 1);
  assert.deepEqual(again.pushTargets(), [], 'a tombstone is never a push target');
});

test('a tombstone goes when the other Mac removes the pair (or the relay revokes the credential), and that is told', async (t) => {
  const r = await rig(t);
  const links = r.make();
  enrollApp(links);
  await until(() => links.status().links[0]?.relay === 'open', 'open');
  links.retire({ hostId: HOST });
  r.relay.last().onclose({ code: 4403 });
  assert.deepEqual(links.status().links, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).links, []);
  enrollApp(links);
  await until(() => links.status().links[0]?.relay === 'open', 'open again');
  links.retire({ hostId: HOST });
  r.relay.last().say({ t: 'event', ev: 'pair.removed', pair: PAIR, reason: 'revoked' });
  assert.deepEqual(links.status().links, []);
  assert.deepEqual(
    r.told.map((e: any) => `${e.kind}:${e.outcome}`),
    ['link.retired:kept', 'link.forgotten:revoked', 'link.retired:kept', 'link.forgotten:pair_removed'],
  );
  // a link that is not a tombstone goes without an audit line
  enrollApp(links);
  assert.deepEqual(links.forget({ hostId: HOST }), { removed: true });
  assert.equal(r.told.length, 4);
});

test('a tombstone past its time is forgotten on start, on use and by the sweep; the sweep stops with the links', async (t) => {
  const r = await rig(t);
  const links = r.make();
  const root = enrollApp(links);
  await until(() => links.status().links[0]?.relay === 'open', 'open');
  links.retire({ hostId: HOST });
  // on use: the other Mac dials after the time is up
  r.clock.now += TOMBSTONE_MS;
  const app = createRelaySession({ prim, root, pair: PAIR, role: 'app', send: (f) => (r.relay.last().say({ t: 'frame', ...f }), true) });
  r.relay.setApp((f: any) => app.handleFrame(f));
  await app.start();
  const stream: any = app.openStream();
  stream.write(new Uint8Array(encodeControl({ id: 1, method: 'host.auth' })));
  await until(() => links.status().links.length === 0, 'the expired tombstone goes on use');
  app.close('done');
  assert.equal(r.reached(), 0);
  assert.deepEqual(r.told.at(-1), { kind: 'link.forgotten', outcome: 'expired' });

  // on start: a tombstone kept on disk past its time is never opened
  enrollApp(links);
  links.retire({ hostId: HOST });
  links.close();
  assert.deepEqual(r.stopped, [], 'no sweep was running before start');
  r.clock.now += TOMBSTONE_MS;
  const later = r.make();
  later.start();
  later.start();
  assert.deepEqual(later.status().links, []);
  assert.equal(r.sweeps.length, 1, 'one sweep per process');

  // by the sweep, while the Host runs
  enrollApp(later);
  later.retire({ hostId: HOST });
  r.clock.now += TOMBSTONE_MS;
  r.sweeps[0]();
  assert.deepEqual(later.status().links, []);
  later.close();
  assert.deepEqual(r.stopped, [1]);
});

test('past the most tombstones kept the oldest goes first; a link that was never kept is forgotten, not made a tombstone', async (t) => {
  const r = await rig(t);
  const links = r.make();
  const ids = Array.from({ length: MAX_TOMBSTONES + 1 }, (_, i) => `h_tomb${String(i).padStart(12, '0')}`);
  for (const [i, id] of ids.entries()) {
    enrollApp(links, id, `p_tombpair${String(i).padStart(2, '0')}`);
    r.clock.now += 1;
    links.retire({ hostId: id });
  }
  const kept = JSON.parse(fs.readFileSync(r.file, 'utf8')).links.map((e: any) => e.hostId);
  assert.equal(kept.length, MAX_TOMBSTONES);
  assert.equal(kept.includes(ids[0]), false, 'the oldest went');
  assert.deepEqual(r.told.at(-1), { kind: 'link.forgotten', outcome: 'evicted' });
  // open in this process but gone from the file (it was emptied by hand): nothing to keep, so the open link goes
  enrollApp(links, 'h_lone000000000001', 'p_lonepair01');
  fs.writeFileSync(r.file, JSON.stringify({ version: 1, links: [] }));
  assert.deepEqual(links.retire({ hostId: 'h_lone000000000001' }), { retired: false });
  assert.equal(
    links.status().links.some((l: any) => l.hostId === 'h_lone000000000001'),
    false,
  );
});

test('the command that runs while no Host serves makes tombstones in the file; an unreadable file stops it', async (t) => {
  const r = await rig(t);
  const links = r.make();
  enrollApp(links);
  enrollApp(links, 'h_other00000000001', 'p_otherpair1');
  links.close();
  const configDir = path.join(r.dir, 'config');
  assert.equal(retireEnrollments(configDir, [HOST, 'h_missing000000001'], 42), 1);
  assert.equal(retireEnrollments(configDir, [HOST], 43), 0, 'one already a tombstone keeps its time');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(r.file, 'utf8')).links.map((e: any) => [e.hostId, e.retiredAt]),
    [
      [HOST, 42],
      ['h_other00000000001', undefined],
    ],
  );
  fs.writeFileSync(r.file, '{');
  assert.throws(() => retireEnrollments(configDir, [HOST], 44), /cannot be read/);
});

test('a time that is not a number counts as past it; a Host with no audit listener still makes tombstones; an unreadable file stops retire before anything is written', async (t) => {
  const r = await rig(t);
  const plain = createRelayLinks({
    configDir: path.join(r.dir, 'config'),
    socketPath: path.join(r.dir, 'h.sock'),
    createSocket: r.relay.createSocket,
  });
  t.after(() => plain.close());
  enrollApp(plain);
  assert.deepEqual(plain.retire({ hostId: HOST }), { retired: true });
  plain.close();
  for (const odd of [null, 'soon']) {
    const kept = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    fs.writeFileSync(r.file, JSON.stringify({ ...kept, links: [{ ...kept.links[0], retiredAt: odd }] }));
    const links = r.make();
    links.start();
    assert.deepEqual(links.status().links, [], `retiredAt ${JSON.stringify(odd)} is past its time`);
    assert.deepEqual(r.told.at(-1), { kind: 'link.forgotten', outcome: 'expired' });
    links.close();
    fs.writeFileSync(r.file, JSON.stringify(kept));
  }
  const links = r.make();
  fs.writeFileSync(r.file, '{"version":1,"links":[');
  assert.throws(() => links.retire({ hostId: HOST }), /cannot be read/);
  assert.equal(fs.readFileSync(r.file, 'utf8'), '{"version":1,"links":[', 'the file is left as it was');
});
