// MoMo's home on the wire of a served Host (host/src/homeGate.mjs, server.mjs, methodHandlers.mjs, approvals.mjs): a forged key, the line protocol, the allow-list, removal mid-task, and the approval card line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { homeGateFor } from '../host/src/homeGate.mjs';
// @ts-ignore
import { createPairing } from '../host/src/pairing.mjs';
// @ts-ignore
import { createApprovals } from '../host/src/approvals.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { createRequire } from 'node:module';
import { servedHost, tmpDir } from './support/hostClientsWorld.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { loadIdentity, authenticate } = require('../electron/host/pairingClient.cjs');

const _HOME = { fingerprint: 'f'.repeat(64), name: 'MoMo on Studio', kind: 'home' };
process.env.MOPILOT_MOMO_HOST_LINK = '1';
const stamp = (leaseEpoch: number, homeId = 'home-a') => ({ homeId, leaseEpoch });
const start = (over: Record<string, unknown> = {}) => ({
  chatId: 'claude:c1',
  epoch: 1,
  key: 'key-00000001',
  text: 'brief',
  harness: 'claude',
  permission: 'default',
  cwd: '/etc',
  home: stamp(1),
  ...over,
});

// ----- the served Host: a forged key, the line protocol, the allow-list on the wire, removal mid-task --

/** A home's connection: it proves its key and says hello with its stamp, the way the home's client does. */
async function homeConn(w: any, id: any, home = stamp(1)) {
  const conn = w.line();
  await authenticate(conn.request, id);
  await conn.request('host.hello', { ...helloParams(), home });
  return conn;
}

/** The gate over a served world: its Stop is the protocol's own (`asHost('chat.stop')`), found once the world exists. */
const gateMaker =
  (ref: { protocol?: any } = {}, report: (m: string) => void = () => undefined) =>
  ({ pairing, paths, epochs }: any) =>
    homeGateFor({
      paths,
      pairing,
      sessions: { state: { has: () => false, get: () => ({}) } },
      policy: { modeOf: () => undefined },
      audit: { note: () => undefined },
      epochs,
      report,
    });

test('on the wire: a forged home key is not served; an allowed one reaches only its own task sessions', async (t) => {
  const ref: any = {};
  const w = await servedHost(t, { homeGate: gateMaker(ref) });
  await w.homeGate.sweep(() => true, w.protocol);
  const owner = await w.paired('owner', 'Mac');
  const home = w.identity('home');
  const forged = w.identity('forged');
  // the key is registered by the owner's device, and only then
  assert.ok((await owner.conn.request('host.clientAdd', { publicKey: home.publicKey, kind: 'home', name: 'MoMo on Studio' })).fingerprint);
  await assert.rejects(homeConn(w, forged), (e: any) => e.code === 'unknown_client');
  const conn = await homeConn(w, home);
  // the allow-list holds on the wire, and the line protocol is closed to it
  for (const method of ['host.clients', 'host.clientAdd', 'chat.remove', 'host.pending'])
    await assert.rejects(
      conn.request(method, { home: stamp(1), chatId: 'claude:c1', epoch: 1, key: 'key-00000001' }),
      (e: any) => e.code === 'home_not_allowed',
    );
  for (const method of ['fs.list', 'status', 'send', 'host.pair'])
    await assert.rejects(conn.request(method, {}), (e: any) => e.code === 'home_not_allowed');
  // a session it did not start cannot be written to
  await assert.rejects(
    conn.request('chat.send', { chatId: 'claude:c1', epoch: 1, key: 'key-00000002', text: 'hi', home: stamp(1) }),
    (e: any) => e.code === 'home_not_allowed',
  );
  assert.equal(w.sends.length, 0);
  // Full access is refused whatever the machine's default is
  await assert.rejects(
    conn.request('chat.start', {
      chatId: 'claude:t1',
      epoch: 1,
      key: 'key-00000003',
      text: 'x',
      harness: 'claude',
      permission: 'full-access',
      home: stamp(1),
    }),
    (e: any) => e.code === 'home_mode_refused',
  );
  assert.equal(w.sends.length, 0);
  // a stale lease is refused for good on a new connection
  const old = await homeConn(w, home, stamp(1));
  await homeConn(w, home, stamp(3, 'home-b'));
  await assert.rejects(old.request('host.status', { home: stamp(1) }), (e: any) => e.code === 'home_lease_stale');
});

test("on the wire: a home's task session is its own, and removing the home mid-task stops it and cuts it off", async (t) => {
  const ref: any = {};
  const w = await servedHost(t, { homeGate: gateMaker(ref) });
  await w.homeGate.sweep(() => true, w.protocol);
  const stopped: string[] = [];
  w.runtime.host.cancel = (id: string) => void stopped.push(id);
  const owner = await w.paired('owner', 'Mac');
  const home = w.identity('home');
  const fp = (await owner.conn.request('host.clientAdd', { publicKey: home.publicKey, kind: 'home', name: 'MoMo on Studio' })).fingerprint;
  const conn = await homeConn(w, home);
  // the home's session exists on this Host once the home has started it (the admitted request, as the protocol parses it)
  const admitted = await w.homeGate.admit(
    { fingerprint: fp, name: 'MoMo on Studio', kind: 'home' },
    'chat.start',
    start({ chatId: 'claude:t1' }),
  );
  assert.equal(admitted.permission, 'default');
  const sent = await conn.request('chat.send', { chatId: 'claude:t1', epoch: 1, key: 'key-00000009', text: 'go on', home: stamp(1) });
  assert.ok(sent);
  assert.equal(w.sends.length, 1);
  assert.equal(w.sends[0].cwd, admitted.cwd, "the follow-up runs in the Host's folder, not one the home named");
  assert.deepEqual(await owner.conn.request('host.clientRemove', { fingerprint: fp }), { removed: true });
  await conn.closed;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...new Set(stopped)], ['claude:t1']);
  await assert.rejects(homeConn(w, home), (e: any) => e.code === 'unknown_client');
});

test('a home with no gate behind the protocol may do nothing', async (t) => {
  const w = await servedHost(t);
  const owner = await w.paired('owner', 'Mac');
  const home = w.identity('home');
  await owner.conn.request('host.clientAdd', { publicKey: home.publicKey, kind: 'home', name: 'MoMo' });
  const conn = w.line();
  await authenticate(conn.request, home);
  await assert.rejects(conn.request('host.hello', helloParams()), (e: any) => e.code === 'home_not_allowed');
});

// ----- the approval card says who started the task ----------------------------------------------

test('an approval card of a MoMo task says it was started by MoMo, and from which home', () => {
  const told: any[] = [];
  const approvals = createApprovals({
    record: () => undefined,
    state: () => undefined,
    stop: () => undefined,
    epochOf: () => 1,
    familyOf: () => 'claude',
    notify: (e: any) => void told.push(e),
    startedBy: (chatId: string) => (chatId === 'claude:t1' ? { kind: 'momo', home: 'MoMo on Studio' } : null),
  });
  const ask = (chatId: string) =>
    approvals.seen(chatId, {
      kind: 'permission',
      requestId: 'r1',
      toolCall: { kind: 'execute', title: 'Run ls' },
      options: [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }],
    });
  ask('claude:t1');
  ask('claude:plain');
  const cardOf = (chatId: string) => told.find((e) => e.kind === 'needsYou' && e.chatId === chatId).card;
  assert.deepEqual(cardOf('claude:t1').startedBy, { kind: 'momo', home: 'MoMo on Studio' });
  assert.equal('startedBy' in cardOf('claude:plain'), false);
});

test('a Host with no gate still removes a home key', async (t) => {
  const w = await servedHost(t);
  const owner = await w.paired('owner', 'Mac');
  const home = w.identity('home');
  const { fingerprint } = await owner.conn.request('host.clientAdd', { publicKey: home.publicKey, kind: 'home', name: 'MoMo' });
  assert.deepEqual(await owner.conn.request('host.clientRemove', { fingerprint }), { removed: true });
});

test('the gate over the Host: a key forgotten by any path stops its sessions in full, also one forgotten while the Host was down; a failure is reported', async (t) => {
  const dir = tmpDir(t);
  const paths = { configDir: path.join(dir, 'config'), dataDir: path.join(dir, 'data') };
  const pairing = createPairing({ configDir: paths.configDir });
  const key = (n: string) => loadIdentity(path.join(dir, `${n}.json`), keySafe).publicKey;
  const stopped: string[] = [];
  const note = (id: string) => void stopped.push(id);
  const reports: string[] = [];
  /** The chats that became sessions on this Host (a start the protocol never took is not one). */
  const loaded = new Set<string>();
  const protocolOf = (stop: (id: string) => unknown) => ({
    asHost: (method: 'chat.stop', p: { chatId: string }) => (method === 'chat.stop' ? stop(p.chatId) : undefined),
  });
  const make = async (stop: (id: string) => unknown = note) => {
    const made = homeGateFor({
      paths,
      pairing,
      sessions: { state: { has: (id: string) => id === 'claude:live' || loaded.has(id), get: () => ({}) } },
      policy: { modeOf: () => undefined },
      audit: { note: () => undefined },
      epochs: { current: () => 0 },
      report: (m: string) => void reports.push(m),
    });
    // the serve entry arms it once the Host's sessions are recovered
    await made.sweep(() => true, protocolOf(stop));
    return made;
  };
  const gate = await make();
  const fp = pairing.add(key('home'), { kind: 'home', name: 'MoMo on Studio' });
  const principal = { fingerprint: fp, name: 'MoMo on Studio', kind: 'home' };
  await gate.admit(principal, 'chat.start', start({ chatId: 'claude:t1' }));
  loaded.add('claude:t1');
  await assert.rejects(gate.admit(principal, 'chat.start', start({ chatId: 'claude:live' })), (e: any) => e.code === 'home_not_allowed');
  // a desktop forgotten is not a home's end
  pairing.remove(pairing.add(key('mac'), { kind: 'desktop' }));
  assert.deepEqual(stopped, []);
  assert.equal(pairing.remove(fp), true);
  await new Promise((r) => setTimeout(r, 1700));
  assert.deepEqual(stopped, ['claude:t1'], 'stopped once: the second pass does not stop it again');
  // removed while the Host was down: the sweep after its sessions are recovered stops what it left
  const fp2 = pairing.add(key('home2'), { kind: 'home', name: 'MoMo again' });
  await gate.admit({ ...principal, fingerprint: fp2 }, 'chat.start', start({ chatId: 'claude:t2' }));
  loaded.add('claude:t2');
  const down = createPairing({ configDir: paths.configDir });
  down.remove(fp2);
  const restarted = await make();
  assert.equal(await restarted.sweep(pairing.stillKnows, protocolOf(note)), 1);
  assert.deepEqual([...new Set(stopped)], ['claude:t1', 'claude:t2']);
  // a removal whose stop fails is reported, never thrown
  const fp3 = pairing.add(key('home3'), { kind: 'home' });
  const failing = await make(() => Promise.reject(new Error('stuck')));
  await failing.admit({ ...principal, fingerprint: fp3 }, 'chat.start', start({ chatId: 'claude:t3' }));
  loaded.add('claude:t3');
  assert.equal(pairing.remove(fp3), true);
  await new Promise((r) => setTimeout(r, 1700));
  assert.match(reports.join(' '), /stuck/);
  // an unreadable state makes the removal report, not throw
  fs.writeFileSync(path.join(paths.configDir, 'home-link.json'), '{broken');
  await make();
  const fp4 = pairing.add(key('home4'), { kind: 'home' });
  pairing.remove(fp4);
  await new Promise((r) => setTimeout(r, 1700));
  assert.match(reports.join(' '), /MoMo home sessions: This machine cannot read/);
});

test("removing a home mid-task stops its session as a person's Stop does: the card it waits on closes and the turn is cancelled", async (t) => {
  const ref: any = {};
  const w = await servedHost(t, { homeGate: gateMaker(ref) });
  await w.homeGate.sweep(() => true, w.protocol);
  w.runtime.prepare = async () => undefined;
  w.runtime.setMode = async () => undefined;
  const cancelled: string[] = [];
  w.runtime.host.cancel = (id: string) => void cancelled.push(id);
  const owner = await w.paired('owner', 'Mac');
  const home = w.identity('home');
  const fp = (await owner.conn.request('host.clientAdd', { publicKey: home.publicKey, kind: 'home', name: 'MoMo on Studio' })).fingerprint;
  const conn = await homeConn(w, home);
  const chatId = 'claude:11111111-1111-4111-8111-111111111111';
  await conn.request('chat.start', {
    chatId,
    epoch: 1,
    key: 'key-00000001',
    text: 'work',
    harness: 'claude',
    permission: 'default',
    home: stamp(1),
  });
  // a second message queued behind the turn, and an approval card the turn waits on
  await conn.request('chat.send', { chatId, epoch: 1, key: 'key-00000002', text: 'and then this', home: stamp(1) });
  w.runtime.host.emit('event', { kind: 'turnStart', key: chatId, turnId: 't1' });
  w.runtime.host.emit('event', {
    kind: 'permission',
    key: chatId,
    turnId: 't1',
    requestId: 'r1',
    toolCall: { kind: 'execute', title: 'Run ls' },
    options: [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }],
  });
  const pending = async () => (await owner.conn.request('host.pending')).cards.length;
  assert.equal(await pending(), 1, 'the card waits on the owner');
  const sentBefore = w.sends.length;
  assert.deepEqual(await owner.conn.request('host.clientRemove', { fingerprint: fp }), { removed: true });
  await new Promise((r) => setTimeout(r, 1700));
  assert.deepEqual([...new Set(cancelled)], [chatId]);
  assert.equal(w.sends.length, sentBefore, 'the message queued behind the turn was not sent after the home was removed');
  await conn.closed;
  assert.equal(await pending(), 0, 'the card closed with the Stop');
});

test("a hello from a home cannot name chats that moved away: the owner's running chat is not retired", async (t) => {
  const ref: any = {};
  const acceptHello = async () => ({ poisoned: ['claude:owner'] });
  const w = await servedHost(t, { homeGate: gateMaker(ref), continueHost: { acceptHello, takesFamilies: false } });
  await w.homeGate.sweep(() => true, w.protocol);
  const owner = await w.paired('owner', 'Mac');
  const home = w.identity('home');
  await owner.conn.request('host.clientAdd', { publicKey: home.publicKey, kind: 'home', name: 'MoMo' });
  const conn = w.line();
  await authenticate(conn.request, home);
  const moved = [{ chatId: 'claude:owner', epoch: 99, rev: 1, targetHostId: 'h'.repeat(32) }];
  const hello: any = await conn.request('host.hello', { ...helloParams(), moved, home: stamp(1) });
  assert.equal(hello.continued, undefined, "the Host did not take the home's word that a chat moved");
});
