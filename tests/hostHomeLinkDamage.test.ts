// What the real two-Host run found (#5531): a start the protocol refuses holds no slot, a start that never became a session is forgotten silently at removal, and damaged link state refuses home clients only while the owner's devices see it and repair it in place (host/src/homeGate.mjs, hostClients.mjs, server.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createHomeGate, homeGateFor, MAX_RUNNING } from '../host/src/homeGate.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { servedHost, tmpDir } from './support/hostClientsWorld.ts';
import { line } from './support/host-line.ts';

const { authenticate } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');
process.env.MOPILOT_MOMO_HOST_LINK = '1';
const stamp = (leaseEpoch: number) => ({ homeId: 'home-a', leaseEpoch });
const fp = (c: string) => c.repeat(64);
const startOf = (chatId: string) => ({
  chatId,
  epoch: 1,
  key: 'key-00000001',
  text: 't',
  harness: 'claude',
  permission: 'default',
  home: stamp(1),
});

function linked(t: any, reports: string[] = [], notes: any[] = []) {
  return servedHost(t, {
    homeGate: ({ pairing, paths, epochs }: any) =>
      homeGateFor({
        paths,
        pairing,
        sessions: { state: { has: () => false, get: () => ({}) } },
        policy: { modeOf: () => undefined },
        audit: { note: (e: any) => void notes.push(e) },
        epochs,
        report: (m: string) => void reports.push(m),
      }),
  });
}

test('a start the protocol refuses holds no slot: five malformed starts leave room for a real one, and nothing of them stays on the machine', async (t) => {
  const w: any = await linked(t);
  w.runtime.prepare = async () => undefined;
  w.runtime.setMode = async () => undefined;
  const owner = await w.paired('owner', 'Mac');
  const home = w.identity('home');
  await owner.conn.request('host.clientAdd', { publicKey: home.publicKey, kind: 'home', name: 'MoMo' });
  const conn = w.line();
  await authenticate(conn.request, home);
  await conn.request('host.hello', { ...helloParams(), home: stamp(1) });
  const base = { epoch: 1, text: 'work', harness: 'claude', permission: 'default', home: stamp(1) };
  for (let i = 0; i <= MAX_RUNNING; i++) {
    const chatId = `claude:11111111-1111-4111-8111-11111111111${i}`;
    // a key the protocol cannot take: the gate had admitted it
    await assert.rejects(conn.request('chat.start', { ...base, chatId, key: 'bad' }), (e: any) => e.code !== 'home_too_many');
    assert.equal(w.homeGate.startedBy(chatId), null, 'its record went at once');
    assert.equal(fs.existsSync(`${w.dir}-momo-tasks`) && fs.readdirSync(`${w.dir}-momo-tasks`).length, 0, 'and its folder');
  }
  const real = 'claude:22222222-2222-4222-8222-222222222222';
  await conn.request('chat.start', { ...base, chatId: real, key: 'key-00000001' });
  assert.deepEqual(w.homeGate.startedBy(real), { kind: 'momo', home: 'MoMo' });
});

test('a start that never became a session is forgotten at removal and at the sweep without a word, and one that did is stopped', async (t) => {
  const dir = tmpDir(t);
  const stopped: string[] = [];
  const reports: string[] = [];
  const sessions = new Set<string>();
  const registered = new Set([fp('a')]);
  const make = () =>
    createHomeGate({
      configDir: path.join(dir, 'config'),
      workDir: path.join(dir, 'work'),
      knows: (f: string) => registered.has(f),
      known: (id: string) => sessions.has(id),
      stop: async (id: string) => void stopped.push(id),
      report: (m: string) => void reports.push(m),
      now: () => 5,
      cap: 1000,
      enabled: () => true,
      active: () => false,
      modeOf: () => undefined,
      settleMs: 0,
    });
  const gate = make();
  const a = { fingerprint: fp('a'), name: 'MoMo', kind: 'home' };
  const start = (chatId: string) => ({
    chatId,
    epoch: 1,
    key: 'key-00000001',
    text: 't',
    harness: 'claude',
    permission: 'default',
    home: stamp(1),
  });
  await gate.admit(a, 'chat.start', start('claude:never'));
  await gate.admit(a, 'chat.start', start('claude:real'));
  sessions.add('claude:real');
  await gate.revoke(fp('a'));
  assert.deepEqual([...new Set(stopped)], ['claude:real'], 'only what became a session is stopped');
  assert.deepEqual(reports, [], 'and nothing is logged for the rest');
  assert.equal(gate.startedBy('claude:never'), null);
  // the sweep forgets the same way, and does not repeat itself
  const after = make();
  registered.add(fp('b'));
  await after.admit({ ...a, fingerprint: fp('b') }, 'chat.start', start('claude:orphan'));
  registered.delete(fp('b'));
  assert.equal(await after.sweep((f: string) => registered.has(f)), 0);
  assert.equal(await after.sweep((f: string) => registered.has(f)), 0);
  assert.equal(after.startedBy('claude:orphan'), null);
  assert.deepEqual(reports, []);
});

test('damaged link state refuses a home and no one else: the owner device connects, sees a plain problem, repairs it in place, and allows MoMo again', async (t) => {
  const reports: string[] = [];
  const w: any = await linked(t, reports);
  const owner = await w.paired('owner', 'Mac');
  const home = w.identity('home');
  await owner.conn.request('host.clientAdd', { publicKey: home.publicKey, kind: 'home', name: 'MoMo' });
  // the file is damaged before this Host first reads it (as after a restart)
  fs.writeFileSync(path.join(w.paths.configDir, 'home-link.json'), '{damaged');
  // the home is refused, every time (a file the reader set aside does not make the next request look clean)
  for (let i = 0; i < 2; i++) {
    const conn = w.line();
    await authenticate(conn.request, home);
    await assert.rejects(conn.request('host.hello', { ...helloParams(), home: stamp(1) }), (e: any) => e.code === 'home_state_unreadable');
  }
  // the owner's device is not locked out: it is told what is wrong
  assert.ok(await owner.conn.request('host.status', {}));
  assert.deepEqual((await owner.conn.request('host.clients')).homeLink, { state: 'unreadable' });
  // a home may not repair it
  const conn = w.line();
  await authenticate(conn.request, home);
  await assert.rejects(conn.request('host.homeLinkRepair', {}), () => true);
  assert.deepEqual(await owner.conn.request('host.homeLinkRepair', {}), { repaired: true, stopped: 0, unverified: 0 });
  // no home is allowed after it, and nothing is damaged
  const list = await owner.conn.request('host.clients');
  assert.equal(list.homeLink, undefined);
  assert.equal(list.clients.filter((c: any) => c.kind === 'home').length, 0);
  assert.deepEqual(await owner.conn.request('host.homeLinkRepair', {}), { repaired: false }, 'nothing left to repair');
  // the owner allows MoMo again and the home works
  await owner.conn.request('host.clientAdd', { publicKey: home.publicKey, kind: 'home', name: 'MoMo' });
  const again = w.line();
  await authenticate(again.request, home);
  assert.ok(await again.request('host.hello', { ...helloParams(), home: stamp(1) }));
  assert.ok(
    fs.readdirSync(w.paths.configDir).some((f: string) => f.startsWith('home-link.json.damaged-') || f.includes('unreadable')),
    'the damaged file is kept aside',
  );
});

test('a state sealed with another key stays where it is until it is repaired, and is then kept aside; failed() leaves a real session alone', async (t) => {
  const dir = tmpDir(t);
  const configDir = path.join(dir, 'config');
  const sessions = new Set<string>();
  const make = () =>
    createHomeGate({
      configDir,
      workDir: path.join(dir, 'work'),
      knows: () => true,
      known: (id: string) => sessions.has(id),
      stop: async () => undefined,
      report: () => undefined,
      now: () => 9,
      cap: 1000,
      enabled: () => true,
      active: () => false,
      modeOf: () => undefined,
      settleMs: 0,
    });
  const home = { fingerprint: fp('a'), name: 'MoMo', kind: 'home' };
  const gate = make();
  await gate.admit(home, 'chat.start', {
    chatId: 'claude:keep',
    epoch: 1,
    key: 'key-00000001',
    text: 't',
    harness: 'claude',
    permission: 'default',
    home: stamp(1),
  });
  assert.equal(gate.health(), 'ok');
  // a refusal for a chat that became a session, or one that is not the home's, takes nothing
  sessions.add('claude:keep');
  await gate.landing(fp('a'), 'claude:keep')(false);
  await gate.landing(fp('b'), 'claude:keep')(false);
  await gate.landing(fp('a'), 'claude:nothing')(false);
  assert.ok(gate.startedBy('claude:keep'));
  assert.equal(await gate.repair(), false, 'nothing to repair while it can be read');
  // sealed with another key: it cannot be read, and reading does not set it aside
  const file = path.join(configDir, 'home-link.json');
  fs.writeFileSync(file, JSON.stringify({ enc: 'safe', data: Buffer.from('not made by this key').toString('base64') }));
  const other = make();
  assert.equal(other.health(), 'unreadable');
  assert.equal(other.health(), 'unreadable', 'and stays so');
  assert.equal(fs.existsSync(file), true);
  assert.equal(await other.repair(), true);
  assert.equal(other.health(), 'ok');
  assert.ok(
    fs.readdirSync(configDir).some((f) => f.startsWith('home-link.json.damaged-')),
    'the damaged file is kept aside',
  );
  assert.deepEqual(
    other.newest(),
    { homeId: 'home-a', leaseEpoch: 1, by: null, was: null },
    'the highest lease seen stays as a floor nobody holds',
  );
});

test('a Host with no gate behind its client table refuses the repair', async (t) => {
  const dir = tmpDir(t);
  // @ts-ignore
  const { createPairing } = await import('../host/src/pairing.mjs');
  // @ts-ignore
  const { createHostClients } = await import('../host/src/hostClients.mjs');
  const clients = createHostClients({
    pairing: createPairing({ configDir: path.join(dir, 'c') }),
    connected: () => false,
    close: () => undefined,
  });
  assert.throws(
    () => (clients.call as any)('host.homeLinkRepair', {}, { fingerprint: fp('o'), name: 'Mac', kind: 'desktop' }),
    (e: any) => e.code === 'forbidden',
  );
});

test("a stop that fails with a plain value is reported too, and a startup sweep stops a removed home's sessions; a sweep never fails the Host's start", async (t) => {
  const reports: string[] = [];
  const sessionIds = new Set<string>();
  const dir = tmpDir(t);
  const mk = (knows: (f: string) => boolean, stop: (id: string) => unknown) =>
    createHomeGate({
      now: () => 5,
      cap: 1000,
      enabled: () => true,
      active: () => false,
      modeOf: () => undefined,
      settleMs: 0,
      configDir: path.join(dir, 'c'),
      workDir: path.join(dir, 'w'),
      knows,
      known: (id: string) => sessionIds.has(id),
      stop,
      report: (m: string) => void reports.push(m),
    });
  const a = mk(
    () => true,
    () => undefined,
  );
  const live = { fingerprint: 'a'.repeat(64), name: 'MoMo', kind: 'home' };
  const dead = { fingerprint: 'd'.repeat(64), name: 'MoMo', kind: 'home' };
  await a.admit(live, 'chat.start', startOf('claude:l1'));
  await a.admit(dead, 'chat.start', startOf('claude:d1'));
  sessionIds.add('claude:d1');
  const stopped: string[] = [];
  const restarted = mk(
    () => true,
    (id) => (stopped.push(id), Promise.reject('plain')),
  );
  assert.equal(await restarted.sweep((f: string) => f === 'a'.repeat(64)), 0);
  assert.deepEqual(stopped, ['claude:d1']);
  assert.match(reports.at(-1) ?? '', /plain/);
  fs.writeFileSync(path.join(dir, 'c', 'home-link.json'), '{broken');
  assert.equal(
    await mk(
      () => true,
      () => undefined,
    ).sweep(() => false),
    0,
  );
  assert.match(reports.at(-1) ?? '', /MoMo home sessions: This machine cannot read/);
});

test('host.homeLinkRepair: a healthy state is not touched, the local command line may repair a damaged one, it is audited, the file is kept, and the switch off refuses it', async (t) => {
  const notes: any[] = [];
  const w: any = await linked(t, [], notes);
  const cli = line(w.paths.socketPath, fs.readFileSync(`${w.paths.socketPath}.token`, 'utf8'));
  t.after(cli.close);
  await cli.request('host.hello', helloParams());
  const owner = await w.paired('owner', 'Mac');
  const home = w.identity('home');
  await owner.conn.request('host.clientAdd', { publicKey: home.publicKey, kind: 'home', name: 'MoMo' });
  // a readable state is not cleared by asking: nothing changes and nothing is audited
  assert.deepEqual(await cli.request('host.homeLinkRepair', {}), { repaired: false });
  assert.equal((await owner.conn.request('host.clients')).clients.filter((c: any) => c.kind === 'home').length, 1);
  assert.equal(notes.length, 0);
  // damaged, with the switch off: refused, and the file stays as it was
  const second: any = await linked(t, [], notes);
  const cli2 = line(second.paths.socketPath, fs.readFileSync(`${second.paths.socketPath}.token`, 'utf8'));
  t.after(cli2.close);
  await cli2.request('host.hello', helloParams());
  fs.mkdirSync(second.paths.configDir, { recursive: true });
  fs.writeFileSync(path.join(second.paths.configDir, 'home-link.json'), '{damaged');
  assert.equal(second.homeGate.health(), 'unreadable');
  process.env.MOPILOT_MOMO_HOST_LINK = '0';
  await assert.rejects(cli2.request('host.homeLinkRepair', {}), (e: any) => e.code === 'forbidden');
  process.env.MOPILOT_MOMO_HOST_LINK = '1';
  assert.equal(second.homeGate.health(), 'unreadable', 'still damaged after the refused call');
  // the local command line repairs it: audited with who did it, the damaged file kept aside, and what is left is a readable floor that a restart reads the same
  assert.deepEqual(await cli2.request('host.homeLinkRepair', {}), { repaired: true, stopped: 0, unverified: 0 });
  assert.deepEqual(
    notes.map((n) => [n.kind, n.by.kind]),
    [['lease.repaired', 'cli']],
  );
  const kept = fs.readdirSync(second.paths.configDir).filter((f: string) => f.startsWith('home-link.json.') && f !== 'home-link.json');
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(second.paths.configDir, kept[0]), 'utf8'), '{damaged', 'set aside, not deleted');
  const restarted = homeGateFor({
    paths: second.paths,
    pairing: second.pairing,
    sessions: { state: { has: () => false, get: () => ({}) } },
    policy: { modeOf: () => undefined },
    audit: { note: () => undefined },
    epochs: { current: () => 0 },
    report: () => undefined,
  });
  assert.equal(restarted.health(), 'ok');
  assert.equal(restarted.newest(), null);
});

test('host.homeLinkRepair is refused for a kind that is not an owner or the local command line', async (t) => {
  // @ts-ignore
  const { createPairing } = await import('../host/src/pairing.mjs');
  // @ts-ignore
  const { createHostClients } = await import('../host/src/hostClients.mjs');
  const clients = createHostClients({
    pairing: createPairing({ configDir: path.join(tmpDir(t), 'c') }),
    connected: () => false,
    close: () => undefined,
    homeLink: { health: () => 'unreadable', repair: async () => true, lastRepair: () => ({ stopped: 1, unverified: 0 }) },
  });
  for (const kind of ['home', 'controller', 'unknown']) {
    assert.throws(
      () => (clients.call as any)('host.homeLinkRepair', {}, { fingerprint: fp('o'), name: 'x', kind }),
      (e: any) => e.code === 'forbidden',
      kind,
    );
  }
  for (const kind of ['phone', 'desktop', 'cli']) {
    assert.deepEqual(await (clients.call as any)('host.homeLinkRepair', {}, { fingerprint: fp('o'), name: 'x', kind }), {
      repaired: true,
      stopped: 1,
      unverified: 0,
    });
  }
});

test('after a repair that could not name some sessions the owner is told they may still be running', async (t) => {
  // @ts-ignore
  const { createPairing } = await import('../host/src/pairing.mjs');
  // @ts-ignore
  const { createHostClients } = await import('../host/src/hostClients.mjs');
  const owner = { fingerprint: fp('o'), name: 'Mac', kind: 'desktop' };
  for (const [unverified, notice] of [
    [1, '1 task on this machine may still be running; stop it from the chat list.'],
    [3, '3 tasks on this machine may still be running; stop them from the chat list.'],
  ] as const) {
    const clients = createHostClients({
      pairing: createPairing({ configDir: path.join(tmpDir(t), 'c') }),
      connected: () => false,
      close: () => undefined,
      homeLink: { health: () => 'unreadable', repair: async () => true, lastRepair: () => ({ stopped: 0, unverified }) },
    });
    assert.deepEqual(await (clients.call as any)('host.homeLinkRepair', {}, owner), { repaired: true, stopped: 0, unverified, notice });
  }
  // nothing to repair: nothing more is said
  const none = createHostClients({
    pairing: createPairing({ configDir: path.join(tmpDir(t), 'c') }),
    connected: () => false,
    close: () => undefined,
    homeLink: { health: () => 'ok', repair: async () => false, lastRepair: () => ({ stopped: 0, unverified: 0 }) },
  });
  assert.deepEqual(await (none.call as any)('host.homeLinkRepair', {}, owner), { repaired: false });
});
