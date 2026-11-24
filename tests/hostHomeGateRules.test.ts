// The limits and fences of what a MoMo home may do on a Host (host/src/homeGate.mjs, server.mjs): the running limit cannot be walked around by messages and restarts of ended sessions, a key's removal lets go of its own lease only, a stolen key cannot ratchet the lease, a home is told only which agents a machine has, and a Host with the switch off leaves no mark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHomeGate, homeStatus, MAX_LEASE_STEP, MAX_RUNNING } from '../host/src/homeGate.mjs';
// @ts-ignore
import { homeGateFor } from '../host/src/homeGate.mjs';
import { createRequire } from 'node:module';
import { servedHost, tmpDir } from './support/hostClientsWorld.ts';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
const { authenticate } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');

process.env.MOPILOT_MOMO_HOST_LINK = '1';
const fp = (c: string) => c.repeat(64);
const HOME = (c: string) => ({ fingerprint: fp(c), name: `MoMo ${c}`, kind: 'home' });
const stamp = (leaseEpoch: number, homeId = 'home-a') => ({ homeId, leaseEpoch });
const start = (chatId: string, over: object = {}) => ({
  chatId,
  epoch: 1,
  key: `key-${chatId.slice(-6).padStart(8, '0')}`,
  text: 'brief',
  harness: 'claude',
  permission: 'default',
  home: stamp(1),
  ...over,
});
const send = (chatId: string, over: object = {}) => ({ chatId, epoch: 1, key: 'key-00000090', text: 'go on', home: stamp(1), ...over });

function world(t: any, over: Record<string, unknown> = {}) {
  const dir = tmpDir(t);
  const running = new Set<string>();
  const existing = new Set<string>();
  const registered = new Set([fp('a'), fp('b'), fp('c')]);
  const gate = createHomeGate({
    configDir: path.join(dir, 'config'),
    workDir: path.join(dir, 'work'),
    knows: (f: string) => registered.has(f),
    known: (id: string) => existing.has(id),
    stop: async () => undefined,
    report: () => undefined,
    now: () => 5,
    cap: 1000,
    enabled: () => true,
    active: (id: string) => running.has(id),
    modeOf: () => undefined,
    settleMs: 0,
    ...over,
  });
  /** A turn begins on a chat the way the Host's own state says it. */
  const begin = (id: string) => (existing.add(id), running.add(id));
  return { dir, gate, running, existing, registered, begin };
}
const refuses = (fn: () => unknown, code: string) =>
  assert.rejects(
    async () => fn(),
    (e: any) => e.code === code,
    `expected ${code}`,
  );

test('the running limit holds for messages and restarts of ended sessions too, not only for new starts', async (t) => {
  const w = world(t);
  const a = HOME('a');
  for (let i = 0; i < MAX_RUNNING; i++) {
    await w.gate.admit(a, 'chat.start', start(`claude:c${i}`));
    w.begin(`claude:c${i}`);
  }
  // all four end; one is started again as a new session, so four run with one idle own session beside them
  for (let i = 0; i < MAX_RUNNING; i++) w.running.delete(`claude:c${i}`);
  await w.gate.admit(a, 'chat.start', start('claude:c4'));
  w.begin('claude:c4');
  for (const id of ['claude:c0', 'claude:c1', 'claude:c2']) {
    assert.ok(await w.gate.admit(a, 'chat.send', send(id)), 'a message to an idle session fits while fewer than four run');
    w.begin(id);
  }
  assert.equal(w.running.size, MAX_RUNNING);
  // four run: neither a message to the idle one nor a second start of it begins a fifth
  await refuses(() => w.gate.admit(a, 'chat.send', send('claude:c3')), 'home_too_many');
  await refuses(() => w.gate.admit(a, 'chat.start', start('claude:c3', { key: 'key-00000077' })), 'home_too_many');
  // a message to a session that is running (steering a live turn) is not another one
  assert.ok(await w.gate.admit(a, 'chat.send', send('claude:c4')));
  // one ends: room again
  w.running.delete('claude:c4');
  assert.ok(await w.gate.admit(a, 'chat.send', send('claude:c3')));
});

test("a key that does not hold the lease cannot take or ratchet it while the holder is registered: the reviewer's attack, step by step", async (t) => {
  const w = world(t);
  const [a, b] = [HOME('a'), HOME('b')];
  await w.gate.admit(a, 'host.status', { home: stamp(5) });
  assert.equal(w.gate.newest().by, fp('a'));
  // a stale or stolen key: its own epoch, or the lease's, is no change; anything above it is refused (never clamped), whatever home id it names
  assert.deepEqual(await w.gate.admit(b, 'host.status', { home: stamp(5) }), {});
  await refuses(() => w.gate.admit(b, 'host.status', { home: stamp(7, 'made-up') }), 'home_lease_held');
  await refuses(() => w.gate.admit(b, 'host.status', { home: stamp(7) }), 'home_lease_held');
  await refuses(() => w.gate.admit(b, 'host.status', { home: stamp(9) }), 'home_lease_held');
  await refuses(() => w.gate.admit(b, 'host.status', { home: stamp(11) }), 'home_lease_held');
  assert.deepEqual([w.gate.newest().leaseEpoch, w.gate.newest().by], [5, fp('a')], 'nothing moved');
  // the real home goes on, and moves it as far as moves allow
  assert.deepEqual(await w.gate.admit(a, 'host.status', { home: stamp(5) }), {});
  assert.deepEqual(await w.gate.admit(a, 'host.status', { home: stamp(6) }), {});
  await refuses(() => w.gate.admit(a, 'host.status', { home: stamp(6 + MAX_LEASE_STEP + 1) }), 'home_lease_jump');
  // an older epoch is stale for every key
  await refuses(() => w.gate.admit(b, 'host.status', { home: stamp(4) }), 'home_lease_stale');
});

/** A fresh gate over the same folder, as after a restart. */
const restarted = (w: ReturnType<typeof world>) =>
  createHomeGate({
    configDir: path.join(w.dir, 'config'),
    workDir: path.join(w.dir, 'work'),
    knows: (f: string) => w.registered.has(f),
    known: (id: string) => w.existing.has(id),
    stop: async () => undefined,
    report: () => undefined,
    now: () => 5,
    cap: 1000,
    enabled: () => true,
    active: (id: string) => w.running.has(id),
    modeOf: () => undefined,
    settleMs: 0,
  });

test('a lease nobody holds is not first-come: a stale registered key, a guessed home id and a key that merely asks first are all refused until the owner names a successor', async (t) => {
  const w = world(t);
  await w.gate.admit(HOME('a'), 'host.status', { home: stamp(5) });
  // 1. the owner removes the holder: the epoch stays as a floor, remembered as that key's
  w.registered.delete(fp('a'));
  await w.gate.revoke(fp('a'));
  assert.deepEqual([w.gate.newest().leaseEpoch, w.gate.newest().by, w.gate.newest().was], [5, null, fp('a')]);
  await refuses(() => w.gate.admit(HOME('b'), 'host.status', { home: stamp(7, 'evil') }), 'home_lease_unassigned');
  await refuses(() => w.gate.admit(HOME('c'), 'host.status', { home: stamp(6) }), 'home_lease_unassigned');
  // 2. a guessed home id at the next epoch gets nowhere either
  await refuses(() => w.gate.admit(HOME('b'), 'host.status', { home: stamp(6, 'home-n') }), 'home_lease_unassigned');
  // an older epoch is stale, and the floor's own epoch with its own home id is no change
  await refuses(() => w.gate.admit(HOME('b'), 'host.status', { home: stamp(4) }), 'home_lease_stale');
  assert.deepEqual(await w.gate.admit(HOME('b'), 'host.status', { home: stamp(5) }), {});
  assert.equal(w.gate.newest().by, null, 'nobody was made the holder by asking');
  // the owner's device registers c as the successor of the key that was removed: c holds it from the same epoch and moves it, and b is held out
  assert.equal(await w.gate.successor(fp('c'), fp('a')), true);
  assert.equal(w.gate.newest().by, fp('c'));
  assert.deepEqual(await w.gate.admit(HOME('c'), 'host.status', { home: stamp(6) }), {});
  await refuses(() => w.gate.admit(HOME('b'), 'host.status', { home: stamp(8) }), 'home_lease_held');
});

test('a holder removed while this Host was down is a floor too: the first key above it does not win, and the successor the owner names does', async (t) => {
  const w = world(t);
  await w.gate.admit(HOME('a'), 'host.status', { home: stamp(5) });
  // the key goes while the Host is off: no revoke ever ran
  w.registered.delete(fp('a'));
  const after = restarted(w);
  assert.deepEqual([after.newest().by, after.newest().was], [null, fp('a')], 'the state matches the rule from the first read');
  await refuses(() => after.admit(HOME('b'), 'host.status', { home: stamp(6) }), 'home_lease_unassigned');
  await refuses(() => after.admit(HOME('c'), 'host.status', { home: stamp(6) }), 'home_lease_unassigned');
  assert.equal(await after.successor(fp('c'), fp('a')), true);
  assert.deepEqual(await after.admit(HOME('c'), 'host.status', { home: stamp(6) }), {});
});

test('the successor is named by the owner: a claim that names no holder, or the wrong one, or a lease with none to hand over, changes nothing', async (t) => {
  const w = world(t);
  assert.equal(await w.gate.successor(fp('b'), fp('a')), false, 'no lease yet');
  await w.gate.admit(HOME('a'), 'host.status', { home: stamp(5) });
  assert.equal(await w.gate.successor(fp('b'), undefined), false);
  assert.equal(await w.gate.successor(fp('b'), fp('c')), false, 'c does not hold it');
  assert.equal(await w.gate.successor(fp('b'), 'floor'), false, 'a is registered and holds it');
  assert.equal(w.gate.newest().by, fp('a'));
  // while a is still registered, the owner can hand it over (the new key first, the old one removed after)
  assert.equal(await w.gate.successor(fp('b'), fp('a')), true);
  assert.equal(w.gate.newest().by, fp('b'));
  await refuses(() => w.gate.admit(HOME('a'), 'host.status', { home: stamp(6) }), 'home_lease_held');
  assert.deepEqual(await w.gate.admit(HOME('b'), 'host.status', { home: stamp(6) }), {});
  // `floor` names a lease nobody holds, when the owner does not know which key held it
  w.registered.delete(fp('b'));
  await w.gate.revoke(fp('b'));
  assert.equal(await w.gate.successor(fp('c'), 'floor'), true);
  assert.equal(w.gate.newest().by, fp('c'));
});

test('a successor removed before it was used leaves a floor again: the next successor is the one named for it, and each state survives a restart', async (t) => {
  const w = world(t);
  await w.gate.admit(HOME('a'), 'host.status', { home: stamp(5) });
  w.registered.delete(fp('a'));
  await w.gate.revoke(fp('a'));
  assert.equal(restarted(w).newest().by, null, 'a floor survives a restart');
  await w.gate.successor(fp('b'), fp('a'));
  assert.equal(restarted(w).newest().by, fp('b'), 'a handed-over lease survives a restart');
  // b is removed before it ever asked
  await w.gate.revoke(fp('b'));
  w.registered.delete(fp('b'));
  const again = restarted(w);
  assert.deepEqual([again.newest().by, again.newest().was, again.newest().leaseEpoch], [null, fp('b'), 5]);
  await refuses(() => again.admit(HOME('c'), 'host.status', { home: stamp(6) }), 'home_lease_unassigned');
  assert.equal(await again.successor(fp('a'), fp('a')), false, 'a is the removed first key, not the last holder');
  assert.equal(await again.successor(fp('c'), fp('b')), true);
  assert.deepEqual(await again.admit(HOME('c'), 'host.status', { home: stamp(6) }), {});
});

test('a state file from before keys were recorded is an unassigned floor: stale at or below it, refused above it, until the owner names a holder', async (t) => {
  const dir = tmpDir(t);
  const configDir = path.join(dir, 'config');
  // @ts-ignore
  const { createFileSafeStorage } = await import('../host/src/secretStore.mjs');
  const { SealedJson } = createRequire(import.meta.url)('../electron/gateway/sealedFile.cjs');
  await new SealedJson({
    file: path.join(configDir, 'home-link.json'),
    safeStorage: createFileSafeStorage(configDir),
    shape: (v: any) => v ?? {},
    now: () => 1,
  }).change((v: any) => void Object.assign(v, { newest: { homeId: 'home-a', leaseEpoch: 6 }, chats: [] }));
  const w = world(t, { configDir, workDir: path.join(dir, 'work') });
  assert.equal(w.gate.newest().by, null);
  await refuses(() => w.gate.admit(HOME('b'), 'host.status', { home: stamp(5) }), 'home_lease_stale');
  await refuses(() => w.gate.admit(HOME('b'), 'host.status', { home: stamp(7) }), 'home_lease_unassigned');
  assert.equal(await w.gate.successor(fp('b'), 'floor'), true);
  assert.deepEqual(await w.gate.admit(HOME('b'), 'host.status', { home: stamp(7) }), {});
});

test('on the wire: the owner device registers the new home key with the key it succeeds, and the lease is handed over; a claim by anyone else is refused', async (t) => {
  const dir = tmpDir(t);
  // @ts-ignore
  const { createPairing } = await import('../host/src/pairing.mjs');
  // @ts-ignore
  const { createHostClients } = await import('../host/src/hostClients.mjs');
  // @ts-ignore
  const { parseParams } = await import('../shared/host/schema.mjs');
  const pairing = createPairing({ configDir: path.join(dir, 'config') });
  const reports: string[] = [];
  const gate = homeGateFor({
    paths: { configDir: path.join(dir, 'config'), dataDir: path.join(dir, 'data') },
    pairing,
    sessions: { state: { has: () => false, get: () => ({}) } },
    policy: { modeOf: () => undefined },
    audit: { note: () => undefined },
    epochs: { current: () => 0 },
    report: (m: string) => void reports.push(m),
  });
  const clients = createHostClients({ pairing, connected: () => false, close: () => undefined });
  const { loadIdentity } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');
  // @ts-ignore
  const { keySafe } = await import('./support/hostKeySafe.ts');
  const key = (n: string) => loadIdentity(path.join(dir, `${n}.json`), keySafe).publicKey;
  const owner = { fingerprint: 'o'.repeat(64), name: 'Mac', kind: 'desktop' as const };
  const add = async (n: string, succeeds?: string) =>
    (
      await (clients.call as any)(
        'host.clientAdd',
        parseParams('host.clientAdd', { publicKey: key(n), kind: 'home', name: n, ...(succeeds ? { succeeds } : {}) }),
        owner,
      )
    ).fingerprint as string;
  const old = await add('old');
  await gate.admit({ fingerprint: old, name: 'old', kind: 'home' }, 'host.status', { home: stamp(5) });
  const next = await add('next', old);
  assert.equal(gate.newest().by, next, 'the lease went to the key the owner said succeeds it');
  // a key registered with no word about whom it succeeds takes nothing, and the old key is held out above the lease
  const other = await add('other');
  assert.equal(gate.newest().by, next);
  await refuses(
    () => gate.admit({ fingerprint: other, name: 'other', kind: 'home' }, 'host.status', { home: stamp(6) }),
    'home_lease_held',
  );
  // what does not parse is refused: only a home key can succeed, and only a fingerprint or `floor`
  for (const bad of [
    { kind: 'desktop', succeeds: old },
    { kind: 'home', succeeds: 'nobody' },
    { kind: 'home', succeeds: 7 },
  ])
    assert.throws(() => parseParams('host.clientAdd', { publicKey: key('x'), name: 'x', ...bad }), /./);
});

test("a folder that cannot be made is refused without the path of this machine's folders", async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'blocker'), 'a file, not a folder');
  const w = world(t, { workDir: path.join(dir, 'blocker', 'tasks') });
  await assert.rejects(
    w.gate.admit(HOME('a'), 'chat.start', start('claude:nofolder')),
    (e: any) => e.code === 'home_not_allowed' && !e.message.includes(dir) && !JSON.stringify(e.details ?? {}).includes(dir),
  );
  assert.equal(w.gate.startedBy('claude:nofolder'), null, 'nothing was recorded for it');
});

test("the move flow's order leaves no request from the old key accepted after the new key's first: the window is the gap between registering the successor and removing the old key", async (t) => {
  const w = world(t);
  await w.gate.admit(HOME('a'), 'host.status', { home: stamp(5) });
  // the owner's device registers b as the successor; a is still registered for the moment
  await w.gate.successor(fp('b'), fp('a'));
  // the window: a, at the old epoch and home id, is still taken for what it was (no change), and can do what a home may; anything above is held
  assert.deepEqual(await w.gate.admit(HOME('a'), 'host.status', { home: stamp(5) }), {});
  await refuses(() => w.gate.admit(HOME('a'), 'host.status', { home: stamp(6) }), 'home_lease_held');
  // b's first request advances the lease: from then on a's old epoch is stale, whatever happens to its key
  assert.deepEqual(await w.gate.admit(HOME('b'), 'host.status', { home: stamp(6, 'home-b') }), {});
  await refuses(() => w.gate.admit(HOME('a'), 'host.status', { home: stamp(5) }), 'home_lease_stale');
  await refuses(() => w.gate.admit(HOME('a'), 'host.status', { home: stamp(6, 'home-a') }), 'home_lease_stale');
  // the move flow removes the old key in the same step as it registers the successor: then there is no window at all
  const flow = world(t);
  await flow.gate.admit(HOME('a'), 'host.status', { home: stamp(5) });
  await flow.gate.successor(fp('b'), fp('a'));
  flow.registered.delete(fp('a'));
  await flow.gate.revoke(fp('a'));
  await refuses(() => flow.gate.admit(HOME('a'), 'host.status', { home: stamp(5) }), 'home_not_allowed');
});

test('a handover and a lease let go are audit lines, and the line that adds a home key says which key it succeeds', async (t) => {
  const lines: any[] = [];
  const w = world(t, { audit: { note: (e: any) => void lines.push(e) } });
  await w.gate.admit(HOME('a'), 'host.status', { home: stamp(5) });
  await w.gate.successor(fp('b'), fp('a'));
  w.registered.delete(fp('b'));
  await w.gate.revoke(fp('b'));
  assert.deepEqual(
    lines.map((l) => [l.kind, l.by.fingerprint, l.what.succeeds ?? l.what.status]),
    [
      ['lease.handed', fp('b'), fp('a')],
      ['lease.floor', fp('b'), 'floor'],
    ],
  );
  const dir = tmpDir(t);
  const added: any[] = [];
  // @ts-ignore
  const { createPairing } = await import('../host/src/pairing.mjs');
  const pairing = createPairing({ configDir: path.join(dir, 'config'), audit: (e: any) => void added.push(e) });
  // @ts-ignore
  const { keySafe } = await import('./support/hostKeySafe.ts');
  const { loadIdentity } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');
  pairing.add(loadIdentity(path.join(dir, 'k.json'), keySafe).publicKey, {
    kind: 'home',
    name: 'MoMo',
    addedBy: fp('o'),
    succeeds: fp('a'),
  });
  assert.deepEqual(added[0].what, { addedBy: fp('o'), succeeds: fp('a') });
});

test('a handover that did not finish is told to the owner device, not only reported: the key stays added and the reply is a refusal with words', async (t) => {
  const dir = tmpDir(t);
  // @ts-ignore
  const { createPairing } = await import('../host/src/pairing.mjs');
  // @ts-ignore
  const { createHostClients } = await import('../host/src/hostClients.mjs');
  // @ts-ignore
  const { keySafe } = await import('./support/hostKeySafe.ts');
  // @ts-ignore
  const { refusalWords } = await import('../shared/host/refusalWords.mjs');
  const { loadIdentity } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');
  const pairing = createPairing({ configDir: path.join(dir, 'config') });
  pairing.onAdded(() => Promise.reject(new Error('disk full')));
  const clients = createHostClients({ pairing, connected: () => false, close: () => undefined });
  const publicKey = loadIdentity(path.join(dir, 'k.json'), keySafe).publicKey;
  await assert.rejects(
    Promise.resolve(
      (clients.call as any)(
        'host.clientAdd',
        { publicKey, kind: 'home', name: 'MoMo', succeeds: fp('a') },
        { fingerprint: fp('o'), name: 'Mac', kind: 'desktop' },
      ),
    ),
    (e: any) => e.code === 'home_handover_failed' && !/disk full/.test(e.message),
  );
  assert.equal(pairing.list().length, 1, 'the key is added; the lease is not handed over, and that is what the owner is told');
  assert.match(refusalWords('home_handover_failed', { machine: 'Studio' })!.line, /Allow MoMo again/);
  // the words the owner meets when the key named is not the holder say the same
  for (const code of ['home_lease_held', 'home_lease_unassigned'])
    assert.match(refusalWords(code, { machine: 'Studio' })!.line, /Allow MoMo again/);
});

test('a handover the Host cannot keep (its lease state unreadable) is reported and told to the owner device as home_handover_failed, through the real gate', async (t) => {
  const dir = tmpDir(t);
  const configDir = path.join(dir, 'config');
  // @ts-ignore
  const { createPairing } = await import('../host/src/pairing.mjs');
  // @ts-ignore
  const { createHostClients } = await import('../host/src/hostClients.mjs');
  // @ts-ignore
  const { keySafe } = await import('./support/hostKeySafe.ts');
  const { loadIdentity } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');
  const pairing = createPairing({ configDir });
  const reports: string[] = [];
  homeGateFor({
    paths: { configDir, dataDir: path.join(dir, 'data') },
    pairing,
    sessions: { state: { has: () => false, get: () => ({}) } },
    policy: { modeOf: () => undefined },
    audit: { note: () => undefined },
    epochs: { current: () => 0 },
    report: (m: string) => void reports.push(m),
  });
  // the lease file is there and cannot be read: nothing can be handed over, and the Host says so rather than guessing
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'home-link.json'), '{not a sealed file');
  const clients = createHostClients({ pairing, connected: () => false, close: () => undefined });
  const publicKey = loadIdentity(path.join(dir, 'k.json'), keySafe).publicKey;
  await assert.rejects(
    Promise.resolve(
      (clients.call as any)(
        'host.clientAdd',
        { publicKey, kind: 'home', name: 'MoMo', succeeds: fp('a') },
        { fingerprint: fp('o'), name: 'Mac', kind: 'desktop' },
      ),
    ),
    (e: any) => e.code === 'home_handover_failed',
  );
  assert.match(reports.join(' '), /MoMo home sessions: This machine cannot read what MoMo may do here/);
});

test('a work folder that cannot be written is refused the same way, without its path', async (t) => {
  if (process.getuid?.() === 0) return;
  const dir = tmpDir(t);
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o500);
  try {
    const w = world(t, { workDir: path.join(locked, 'tasks') });
    await assert.rejects(
      w.gate.admit(HOME('a'), 'chat.start', start('claude:locked')),
      (e: any) => e.code === 'home_not_allowed' && !e.message.includes(dir),
    );
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test('a home is told which agents a machine has and nothing of its policy, spend, push or network', () => {
  assert.deepEqual(
    homeStatus({
      harnesses: [{ id: 'claude', detected: true }],
      policy: { max: 'x' },
      spend: { day: 1 },
      push: { on: true },
      localNetwork: {},
      startup: {},
    }),
    { harnesses: [{ id: 'claude', detected: true }] },
  );
  assert.deepEqual(homeStatus(undefined), { harnesses: [] });
  assert.deepEqual(homeStatus({ harnesses: 'no' }), { harnesses: [] });
});

test('on the wire: host.status to a home is the reduced status, and to an owner device the whole', async (t) => {
  const full = {
    running: true,
    harnesses: [{ id: 'claude', detected: true, signedIn: true }],
    policy: { permissionMax: 'default' },
    spend: {},
    push: { on: true },
  };
  const w = await servedHost(t, {
    status: () => full,
    homeGate: ({ pairing, paths, epochs }: any) =>
      homeGateFor({
        paths,
        pairing,
        sessions: { state: { has: () => false, get: () => ({}) } },
        policy: { modeOf: () => undefined },
        audit: { note: () => undefined },
        epochs,
        report: () => undefined,
      }),
  });
  const owner = await w.paired('owner', 'Mac');
  const home = w.identity('home');
  await owner.conn.request('host.clientAdd', { publicKey: home.publicKey, kind: 'home', name: 'MoMo' });
  const conn = w.line();
  await authenticate(conn.request, home);
  await conn.request('host.hello', { ...helloParams(), home: stamp(1) });
  const reduced = await conn.request('host.status', { home: stamp(1) });
  assert.deepEqual(Object.keys(reduced), ['harnesses']);
  const whole = await owner.conn.request('host.status', {});
  assert.deepEqual(whole.policy, full.policy);
});

test('with the host-link switch off nothing is written: a sweep or a removal on a Host that never had a home makes no file', async (t) => {
  const w = world(t, { enabled: () => false });
  assert.equal(await w.gate.sweep(() => false), 0);
  assert.equal(await w.gate.revoke(fp('a')), 0);
  assert.equal(fs.existsSync(path.join(w.dir, 'config', 'home-link.json')), false);
  assert.equal(fs.existsSync(path.join(w.dir, 'config')), false, 'not even the folder');
});
