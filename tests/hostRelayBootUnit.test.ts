// Add by command's edges, on stand-ins (#2709): the app's boot (relayBoot.cjs) against a fake lane: a relay that is down, a bundle
// that does not match its hash, a hello in the wrong direction or with keys that are not keys, a hello that names little, the same
// machine asking again after Allow, the timer running out, a window listener that throws; the Host's `enroll` against a fake relay
// socket: a frame it cannot open, the app coming back to the relay, an answer it cannot use; and the shared seal's refusals.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createCrypto } from '../shared/remote/crypto.mjs';
import { toBase64 } from '../shared/remote/envelope.mjs';
import { enrollKeys, openEnroll, sealEnroll } from '../shared/host/relayEnroll.mjs';
import { enroll, parseInput } from '../host/src/relayEnroll.mjs';
import { keepEnrollment } from '../host/src/relayLink.mjs';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createRelayBoot, httpBase } = require('../electron/host/relayBoot.cjs');
const { NO_RELAY } = require('../electron/host/relayLane.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const prim = createNodePrimitives();
const c = createCrypto(prim);
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** A lane that records what the boot asks of it; `fail` makes its open reject. */
function fakeLane({ fail = false } = {}) {
  const lane: any = {
    sent: [] as any[],
    notes: [] as any[],
    revoked: [] as string[],
    route: (pair: string, r: any) => ((lane.routes[pair] = r), () => delete lane.routes[pair]),
    routes: {} as Record<string, any>,
    onBoot: (fn: any) => ((lane.boot = fn), () => (lane.boot = null)),
    whenOpen: async () => {
      if (fail) throw new Error('relay down');
    },
    intend: () => undefined,
    settle: () => undefined,
    register: async () => undefined,
    request: async () => undefined,
    revoke: async (h: string) => void lane.revoked.push(h),
    send: (f: any) => (lane.sent.push(f), true),
    notify: (m: any) => (lane.notes.push(m), true),
    device: 'mac~h',
  };
  return lane;
}
const bundleFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rbu-')), 'b.tgz');
fs.writeFileSync(bundleFile, 'bundle bytes');
const sha = crypto.createHash('sha256').update('bundle bytes').digest('hex');

test('a build that names no relay fails Add by command at once, saying how to name one, and asks the lane nothing', async () => {
  const lane = fakeLane();
  const boot = createRelayBoot({
    lane,
    paths: { adopt: () => undefined },
    url: () => null,
    bundle: () => ({ file: bundleFile, sha256: sha, version: '1' }),
  });
  const v = await boot.start();
  assert.equal(v.state, 'failed');
  assert.equal(v.error, NO_RELAY);
  assert.deepEqual([lane.sent, lane.revoked], [[], []]);
});

test('httpBase follows the relay scheme', () => {
  assert.equal(httpBase('wss://relay.example/v1/ws'), 'https://relay.example');
  assert.equal(httpBase('ws://127.0.0.1:9/v1/ws'), 'http://127.0.0.1:9');
});

test('a relay that cannot be reached fails the command; defaults and a listener that throws are quiet', async () => {
  const lane = fakeLane({ fail: true });
  clearIgnored();
  const boot = createRelayBoot({
    lane,
    paths: { adopt: () => undefined },
    url: () => 'wss://r/v1/ws',
    bundle: () => ({ file: bundleFile, sha256: sha, version: '1' }),
  });
  const v = await boot.start();
  assert.equal(v.state, 'failed');
  assert.equal(lane.revoked.length, 1);
  const noisy = createRelayBoot({
    lane: fakeLane(),
    paths: { adopt: () => undefined },
    url: () => 'wss://r/v1/ws',
    bundle: () => ({ file: bundleFile, sha256: sha, version: '1' }),
    onChange: () => {
      throw new Error('window gone');
    },
  });
  await noisy.start();
  assert.ok(recentIgnored().some((e: any) => /how a command stands/.test(e.context)));
  noisy.dispose();
});

test('the boot on a fake lane: hellos it ignores, a sparse hello, the same machine again, the timer', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const lane = fakeLane();
  const bundleSha = sha;
  const adopted: any[] = [];
  const boot = createRelayBoot({
    lane,
    paths: { adopt: (d: string, e: any) => adopted.push([d, e]) },
    url: () => 'wss://r/v1/ws',
    bundle: () => ({ file: bundleFile, sha256: bundleSha, version: '1' }),
    updateKeyPem: () => null,
  });
  const v = await boot.start();
  const code = /sh "\$f" ([\w-]+);/.exec(v.command)![1];
  const pair = Object.keys(lane.routes)[0];
  const route = lane.routes[pair];
  // the script is served
  lane.boot({ boot: 'b_other', req: 'r0', what: 'script', ip: '' });
  assert.equal(lane.notes.length, 0, 'another boot’s request is not this one’s');
  const bootId = /\/v1\/boot\/(b_[\w-]+)' -o/.exec(v.command)![1];
  lane.boot({ boot: bootId, req: 'r1', what: 'script', ip: '5.5.5.5' });
  await flush();
  assert.equal(lane.notes.at(-1).end, true);
  // hellos it ignores: the other direction, keys that are not keys
  const keys = enrollKeys(c, code, pair);
  route.onFrame(sealEnroll(prim, keys.m2p, pair, 'm2p', { hostPub: 'x' }));
  route.onFrame(sealEnroll(prim, keys.p2m, pair, 'p2m', { hostPub: 'x', hostEphPub: 'y' }));
  assert.equal(boot.view.state, 'waiting');
  // a hello that names little: the card shows what there is, with the address the script was fetched from
  const pub = toBase64(prim.x25519Base(prim.randomBytes(32)));
  const hello = sealEnroll(prim, keys.p2m, pair, 'p2m', { hostPub: pub, hostEphPub: pub, name: 7 });
  route.onPeer(false);
  route.onFrame(hello);
  assert.deepEqual(boot.view.machine, { name: '', os: '', arch: '', user: '', ip: '5.5.5.5' });
  const joined = boot.allow();
  assert.deepEqual([joined.name, joined.socketPath, joined.hostKey, joined.pairingCode], ['Machine', '', '', '']);
  assert.equal(adopted.length, 1);
  // the same machine again (it missed the answer): the same answer; another hello: nothing
  const before = lane.sent.length;
  route.onFrame(hello);
  assert.equal(lane.sent.length, before + 1);
  assert.deepEqual(lane.sent.at(-1), lane.sent.at(-2));
  route.onFrame(sealEnroll(prim, keys.p2m, pair, 'p2m', { hostPub: toBase64(prim.x25519Base(prim.randomBytes(32))), hostEphPub: pub }));
  assert.equal(lane.sent.length, before + 1);
  // a new command that runs out: revoked, and the card says so
  await boot.start();
  mock.timers.tick(15 * 60_000);
  assert.equal(boot.view.state, 'expired');
  // a hello with no address seen: empty
  await boot.start();
  const p2 = Object.keys(lane.routes).at(-1)!;
  const code2 = /sh "\$f" ([\w-]+);/.exec(boot.view.command)![1];
  lane.routes[p2].onFrame(sealEnroll(prim, enrollKeys(c, code2, p2).p2m, p2, 'p2m', { hostPub: pub, hostEphPub: pub, name: 'n' }));
  assert.equal(boot.view.machine.ip, '');
  lane.routes[p2].onPeer(true, '7.7.7.7');
  boot.deny();
  boot.deny();
  assert.equal(boot.view.state, 'denied');
});

test('enroll on a fake relay: a frame it cannot open, the app coming back, an answer it cannot use; the default machine facts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = parseInput(
    JSON.stringify({
      relayUrl: 'wss://r/v1/ws',
      hostId: 'h_host0000000000001',
      secret: 'S'.repeat(43),
      pairId: 'p_hostpair01',
      code: 'K'.repeat(22),
    }),
  );
  const keys = enrollKeys(c, input.code, input.pairId);
  const sockets: any[] = [];
  const createSocket = () => {
    const s: any = { sent: [] as any[], send: (text: string) => s.sent.push(JSON.parse(text)), close: () => undefined };
    s.say = (m: object) => s.onmessage?.({ data: JSON.stringify(m) });
    sockets.push(s);
    setImmediate(() => (s.onopen?.(), s.say({ t: 'hello', pairs: [] })));
    return s;
  };
  const joining = enroll({
    input,
    configDir: dir,
    socketPath: '/s',
    pairing: { issueCode: () => 'ABCD-EFGH-JKMN', hostId: () => 'id' },
    createSocket,
  });
  await waitFor(() => sockets[0]?.sent.some((m: any) => m.t === 'frame'), 'the first frame to be sent');
  const s = sockets[0];
  const hellos = () => s.sent.filter((m: any) => m.t === 'frame').length;
  assert.equal(hellos(), 1);
  // the app comes (back) to the relay: the hello goes again
  s.say({ t: 'event', ev: 'peer', pair: input.pairId, online: true });
  s.say({ t: 'event', ev: 'peer', pair: input.pairId, online: false });
  assert.equal(hellos(), 2);
  const opened = openEnroll(
    prim,
    keys.p2m,
    s.sent.find((m: any) => m.t === 'frame'),
  );
  assert.equal(opened!.name, os.hostname(), 'the machine’s own name');
  assert.equal(opened!.user, os.userInfo().username);
  // a frame it cannot open, then an answer whose keys cannot be used
  s.say({ t: 'frame', ...sealEnroll(prim, keys.p2m, input.pairId, 'p2m', { allow: true }) });
  s.say({ t: 'frame', ...sealEnroll(prim, keys.m2p, input.pairId, 'm2p', { allow: true, appPub: 'bad', appEphPub: 'bad' }) });
  await assert.rejects(joining, (e: any) => e.code === 'denied' && /cannot use/.test(e.message));
});

test('the shared seal opens only a counter-0 object sealed with its key; keepEnrollment reads a broken file as none', () => {
  const key = prim.randomBytes(32);
  const f = sealEnroll(prim, key, 'p_hostpair01', 'p2m', { a: 1 });
  assert.deepEqual(openEnroll(prim, key, f), { a: 1 });
  assert.equal(openEnroll(prim, key, { ...f, ctr: 1 }), null);
  assert.equal(openEnroll(prim, key, { ...f, box: '!!' }), null);
  assert.equal(openEnroll(prim, key, sealEnroll(prim, key, 'p_hostpair01', 'p2m', [1] as any)), null);
  assert.equal(openEnroll(prim, prim.randomBytes(32), f), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'relay.json'), '{broken');
  keepEnrollment(dir, { relayUrl: 'wss://r/v1/ws', hostId: 'h_x', secret: 's', pairId: 'p_x', root: 'r' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8')).links.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
