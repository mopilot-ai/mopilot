// The user's remote machines on a phone (electron/remote/methods/host.cjs, phoneMachines.cjs, service.cjs): machines.list with this Mac first and each machine in the Mac's own words, machines.changed, machines.folders, chat.move, chat.start on a machine for Claude Code, Codex and an ACP agent, and a chat's or a task's machine. An account without Host sees none of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';
import { parseParams } from '../shared/remote/schema.mjs';

const require = createRequire(import.meta.url);
const { phoneMachine, machinesSignature, HOST_METHODS } = require('../electron/remote/phoneMachines.cjs');
const { asRefusal, RefusalError } = require('../electron/remote/serviceErrors.cjs');
import { ok, fail, refusal, row, record, fakeHost } from './support/remoteHostKit.ts';

test('machines.list: this Mac first as local, then each machine in the Mac’s words; how each ready agent runs, never a key', async () => {
  const { host } = fakeHost();
  const r = rig({ host: () => host, machineName: () => 'Studio' });
  const { machines } = ok(await r.phone('p1').ask('machines.list'));
  assert.deepEqual(machines[0], {
    id: 'local',
    name: 'Studio',
    status: 'online',
    line: 'Online · Codex',
    tone: 'ok',
    path: 'direct',
    lastSeen: 1000,
    localNetwork: 'unknown',
    waitingForLogin: null,
    keepRunning: null,
    agents: [{ id: 'codex', label: 'Codex', state: 'ready', via: 'own' }],
  });
  assert.deepEqual(machines[1], {
    id: 'ssh:box',
    name: 'box',
    status: 'online',
    line: 'Online · Claude Code, Codex, Gemini',
    tone: 'ok',
    path: 'direct',
    lastSeen: 900,
    localNetwork: 'allowed',
    waitingForLogin: null,
    keepRunning: null,
    agents: [
      { id: 'claude', label: 'Claude Code', state: 'ready', via: 'own' },
      { id: 'codex', label: 'Codex', state: 'ready', via: 'key' },
      { id: 'gemini', label: 'Gemini', state: 'ready', via: 'org' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(machines), /reason|lent|takes/);
  // a Mac with no usable harness and no name a phone can show, and an agent row with no state
  const bare = rig({
    host: () => ({ ...host, rows: () => [row({ agents: [{ id: 'claude', label: 'Claude Code' }] })] }),
    machineName: () => '',
    ops: { harnesses: async () => [] },
  });
  const [here, there] = ok(await bare.phone('p1').ask('machines.list')).machines;
  assert.deepEqual([here.name, here.line, here.agents], ['This Mac', 'Online', []]);
  assert.deepEqual(there.agents, [], 'an agent the machine reported no state for is not shown, as on the Mac');
});

test('machines.list carries what a chat on each agent would use, what else exists, and whether it holds several logins, only when the Host reports them', async () => {
  const sources = { own: true, key: true, org: false };
  const agents = [
    { id: 'claude', label: 'Claude Code', state: 'ready', via: 'own', using: 'own', sources, loginsSupported: true },
    { id: 'codex', label: 'Codex', state: 'ready', via: 'own' },
  ];
  const r = rig({ host: () => ({ ...fakeHost().host, rows: () => [row({ agents })] }) });
  const [, there] = ok(await r.phone('p1').ask('machines.list')).machines;
  assert.deepEqual(there.agents, [
    { id: 'claude', label: 'Claude Code', state: 'ready', via: 'own', using: 'own', sources, loginsSupported: true },
    // how Codex runs is the machine's record's word, as in the list above; the fields the Host did not report are not made up
    { id: 'codex', label: 'Codex', state: 'ready', via: 'key' },
  ]);
});

test('a machine’s row as a phone’s: each status, the relay path, odd fields read safely, no harness reported', () => {
  const at = { now: 1000 + 2 * 3_600_000, orgCovers: () => false };
  const offline = phoneMachine(row({ status: 'offline', note: 'No answer for 90 seconds.' }), null, at);
  assert.deepEqual([offline.status, offline.line, offline.tone], ['offline', 'Offline · No answer · seen 2 h ago', 'off']);
  const restarted = phoneMachine(row({ status: 'offline', waitingForLogin: 'restarted' }), null, at);
  assert.deepEqual([restarted.line, restarted.tone, restarted.waitingForLogin], ['Restarted · waiting for sign-in', 'warn', 'restarted']);
  const setup = phoneMachine(
    row({
      status: 'attention',
      note: 'Codex is not signed in on this machine.',
      agents: [{ id: 'codex', label: 'Codex', state: 'signin' }],
    }),
    record,
    at,
  );
  assert.deepEqual([setup.status, setup.line, setup.tone], ['needs-setup', 'Codex needs sign-in', 'warn']);
  assert.deepEqual(setup.agents, [{ id: 'codex', label: 'Codex', state: 'signin', via: null }]);
  // the Host's own words for a signed-out agent reach the phone (#4861), bounded
  const worded = phoneMachine(
    row({ agents: [{ id: 'kimi', label: 'Kimi', state: 'signin', reason: `Sign in on Studio: ${'x'.repeat(300)}` }] }),
    record,
    at,
  );
  assert.equal(worded.agents[0].reason!.length, 200);
  assert.match(worded.agents[0].reason!, /^Sign in on Studio: x/);
  const odd = phoneMachine(
    { id: 'm', name: 'm', status: 'weird', note: '', path: { path: 'relay' }, lastSeen: 'x', localNetwork: 'maybe', waitingForLogin: 'x' },
    null,
    at,
  );
  assert.deepEqual(
    [odd.status, odd.path, odd.lastSeen, odd.localNetwork, odd.waitingForLogin, odd.agents],
    ['needs-setup', 'relay', null, 'unknown', null, []],
  );
  const signedOut = phoneMachine(row({ status: 'offline', waitingForLogin: 'signed-out' }), null, at);
  assert.equal(signedOut.waitingForLogin, 'signed-out');
  // an agent with no state of its own and a ready one the machine did not report
  const bare = phoneMachine(row({ agents: [{ id: 'claude', label: 'Claude Code', state: 'ready' }] }), null, at);
  assert.deepEqual(bare.agents, [{ id: 'claude', label: 'Claude Code', state: 'ready', via: 'key' }]);
});

test('an account without Host: no machine method, no capability, no machine on a chat or a task; this Mac alone if asked anyway', async () => {
  const { host } = fakeHost({ open: false });
  const r = rig({
    host: () => host,
    ops: { scheduled: async () => [{ id: 't', name: 'T', next: null, hostId: 'ssh:box', firesWhileMacAway: true }] },
  });
  const p = r.phone('p1');
  const hello = ok(await p.ask('machine.hello'));
  assert.equal(hello.capabilities.machines, false);
  for (const m of HOST_METHODS) assert.ok(!hello.capabilities.methods.includes(m), m);
  fail(await p.ask('machines.list'), 'forbidden', /aren't available/);
  fail(await p.ask('machines.folders', { id: 'ssh:box' }), 'forbidden');
  fail(await p.ask('chat.move', { chatId: 'c1', hostId: 'ssh:box', folder: '/srv', carry: 'none' }), 'forbidden');
  fail(await p.ask('chat.start', { harness: 'claude', text: 'hi', hostId: 'ssh:box', folder: '/srv' }), 'forbidden');
  const recent = ok(await p.ask('chats.recent'));
  assert.ok(!('hostId' in recent.chats[0]), 'no machine field at all');
  assert.deepEqual(ok(await p.ask('scheduled.list')).tasks, [{ id: 't', name: 'T', next: null }]);
  // the facade asked directly while the gate is closed lists this Mac alone
  const { machinesOf } = require('../electron/remote/phoneMachines.cjs');
  assert.deepEqual(
    (await machinesOf(r.service)).map((m: any) => m.id),
    ['local'],
  );
  // no Host wiring at all is the same
  const none = rig().phone('p1');
  assert.equal(ok(await none.ask('machine.hello')).capabilities.machines, false);
  fail(await none.ask('machines.list'), 'forbidden');
});

test('with Host: the capability and methods; a chat’s machine (null on this Mac); a task’s machine and whether it fires while the Mac is away', async () => {
  const { host } = fakeHost();
  const r = rig({
    host: () => host,
    ops: {
      recent: async () => [
        { id: 'c1', title: 'On box', harness: 'claude', at: 1, project: null, pinned: false },
        { id: 'c2', title: 'Here', harness: 'codex', at: 1, project: null, pinned: false },
      ],
      scheduled: async () => [
        { id: 'a', name: 'A', next: 1, hostId: 'ssh:box', firesWhileMacAway: true },
        { id: 'b', name: 'B', next: 2 },
      ],
    },
  });
  const p = r.phone('p1');
  const hello = ok(await p.ask('machine.hello'));
  assert.equal(hello.capabilities.machines, true);
  for (const m of HOST_METHODS) assert.ok(hello.capabilities.methods.includes(m), m);
  const { chats } = ok(await p.ask('chats.recent'));
  assert.deepEqual(
    chats.map((c: any) => [c.id, c.hostId]),
    [
      ['c1', 'ssh:box'],
      ['c2', null],
    ],
  );
  assert.deepEqual(ok(await p.ask('scheduled.list')).tasks, [
    { id: 'a', name: 'A', next: 1, hostId: 'ssh:box', firesWhileMacAway: true },
    { id: 'b', name: 'B', next: 2, hostId: null, firesWhileMacAway: false },
  ]);
  // the panel never gets machine methods
  await assert.rejects(r.service.call({ kind: 'panel' }, 'machines.list', {}), /doesn't allow/);
});

test('machines.folders: a bounded list on a machine, a path checked first, this Mac refused, the machine’s refusal kept', async () => {
  const many = Array.from({ length: 205 }, (_v, i) => ({ name: `f${i}`, path: `/srv/f${i}`, git: false }));
  const { host, calls } = fakeHost();
  const r = rig({ host: () => host });
  const p = r.phone('p1');
  assert.deepEqual(ok(await p.ask('machines.folders', { id: 'ssh:box' })), {
    path: '/srv',
    roots: ['/srv'],
    entries: [{ name: 'a', path: '/srv/a', git: true }],
    more: false,
  });
  ok(await p.ask('machines.folders', { id: 'ssh:box', path: '/srv/a' }));
  assert.deepEqual(calls, [
    ['folders', 'ssh:box', undefined],
    ['folders', 'ssh:box', '/srv/a'],
  ]);
  host.folders = async () => ({ path: '/srv', roots: ['/srv'], entries: many });
  const big = ok(await p.ask('machines.folders', { id: 'ssh:box' }));
  assert.deepEqual([big.entries.length, big.more], [200, true]);
  fail(await p.ask('machines.folders', { id: 'local' }), 'invalid', /project/);
  fail(await p.ask('machines.folders', { id: 'ssh:box', path: 'relative' }), 'invalid', /folder/);
  fail(await p.ask('machines.folders', { id: 'bad id!' }), 'invalid', /machine/);
  host.folders = async () => {
    throw refusal('That folder is outside what box shares.', 'outside_roots');
  };
  fail(await p.ask('machines.folders', { id: 'ssh:box' }), 'outside_roots', /outside/);
  host.folders = async () => {
    throw new Error('socket closed');
  };
  // the facade says a transport failure as a coded refusal (tests/hostPhone.test.ts); an error that still gets here uncoded is a plain failure
  fail(await p.ask('machines.folders', { id: 'ssh:box' }), 'failed', /socket/);
  host.folders = async () => {
    throw refusal("box isn't reachable. Check it's online, then try again.", 'offline');
  };
  fail(await p.ask('machines.folders', { id: 'ssh:box' }), 'offline', /isn't reachable/);
  // the gate closing between the service's check and the method is refused too
  host.allowed = () => ((host.allowed = () => false), true);
  fail(await p.ask('machines.folders', { id: 'ssh:box' }), 'forbidden');
});

test('the schema: a machine and its folder for a new chat, this Mac by default', () => {
  const parsed = (p: object) => parseParams('chat.start', p) as any;
  assert.equal(parsed({ harness: 'codex', text: 'x' }).hostId, undefined);
  assert.equal(parsed({ harness: 'codex', text: 'x', hostId: 'local', folder: 'ignored' }).folder, undefined);
  const { hostId, folder } = parsed({ harness: 'codex', text: 'x', hostId: 'ssh:a@b', folder: '/x' });
  assert.deepEqual({ hostId, folder }, { hostId: 'ssh:a@b', folder: '/x' });
  assert.throws(() => parseParams('chat.start', { harness: 'codex', text: 'x', hostId: 'ssh:a', folder: '/'.repeat(4097) }), /folder/);
  assert.deepEqual(parseParams('machines.list', {}), {});
});

test('machines.changed: every phone allowed is told, a heartbeat alone is no change, a closed gate tells this Mac alone once', async () => {
  const { host } = fakeHost();
  let rows = [row()];
  host.rows = () => rows;
  const allowList = new Set(['p1']);
  const r = rig({ host: () => host, policy: { allow: (pair: string, m: string) => m !== 'machines.list' || allowList.has(pair) } });
  const p1 = r.phone('p1');
  const p2 = r.phone('p2');
  await r.service.onMachinesChanged();
  await settle();
  assert.equal(p1.events('machines.changed').length, 1);
  assert.equal(p2.events('machines.changed').length, 0, 'a phone the Mac does not allow the list is not told');
  assert.deepEqual(
    p1.events('machines.changed')[0].machines.map((m: any) => m.id),
    ['local', 'ssh:box'],
  );
  rows = [row({ lastSeen: 950 })];
  await r.service.onMachinesChanged();
  assert.equal(p1.events('machines.changed').length, 1, 'an online machine answering again is no change');
  rows = [row({ status: 'offline' })];
  await r.service.onMachinesChanged();
  rows = [row({ status: 'offline', lastSeen: 960 })];
  await r.service.onMachinesChanged();
  await settle();
  assert.equal(p1.events('machines.changed').length, 3, 'an offline machine’s last answer is part of its line');
  host.open = false;
  await r.service.onMachinesChanged();
  await settle();
  const last = p1.events('machines.changed').at(-1);
  assert.deepEqual(
    last.machines.map((m: any) => m.id),
    ['local'],
  );
  assert.equal(p2.events('machines.changed').length, 0, 'a phone never allowed the list is not told it closed either');
  await r.service.onMachinesChanged();
  await settle();
  assert.equal(p1.events('machines.changed').length, 4, 'told once');
});

test('machines.changed: a phone that only listed the machines is told when the gate closes, until it hears it', async () => {
  const { host } = fakeHost();
  const r = rig({ host: () => host });
  const p = r.phone('p1');
  ok(await p.ask('machines.list'));
  // nothing changes, then access is revoked: the phone still draws machines, so it is told
  host.open = false;
  const send = r.service.transport.send;
  r.service.transport.send = async () => {
    throw new Error('relay down');
  };
  await r.service.onMachinesChanged();
  assert.equal(p.events('machines.changed').length, 0);
  r.service.transport.send = send;
  await r.service.onMachinesChanged();
  await settle();
  assert.deepEqual(
    p.events('machines.changed').map((e: any) => e.machines.map((m: any) => m.id)),
    [['local']],
  );
  await r.service.onMachinesChanged();
  await settle();
  assert.equal(p.events('machines.changed').length, 1, 'told once');
  // a phone that never held machines is not told the gate closed
  assert.equal(r.phone('p2').events('machines.changed').length, 0);
});

test('machines.changed: nothing with no phone paired; a list that fails is reported and the next change still goes', async () => {
  const { host } = fakeHost();
  const r = rig({ host: () => host });
  r.service.phones.clear();
  await r.service.onMachinesChanged();
  assert.equal(r.service.machinesSent.size, 0);
  const r2 = rig({ host: () => host });
  const p = r2.phone('p1');
  host.rows = () => {
    throw new Error('registry gone');
  };
  await r2.service.onMachinesChanged();
  host.rows = () => [row()];
  await r2.service.onMachinesChanged();
  await settle();
  assert.equal(p.events('machines.changed').length, 1);
});

test('signature and refusals: what a phone draws decides a change; only main’s own codes pass through', () => {
  const a = [{ id: 'm', status: 'online', lastSeen: 1 }];
  assert.equal(machinesSignature(a), machinesSignature([{ id: 'm', status: 'online', lastSeen: 2 }]));
  assert.notEqual(
    machinesSignature([{ id: 'm', status: 'offline', lastSeen: 1 }]),
    machinesSignature([{ id: 'm', status: 'offline', lastSeen: 2 }]),
  );
  const kept = asRefusal(refusal('No.', 'directory_missing'));
  assert.ok(kept instanceof RefusalError);
  assert.deepEqual([kept.code, kept.message], ['directory_missing', 'No.']);
  const plain = new Error('x');
  assert.equal(asRefusal(plain), plain);
  const odd = refusal('x', 'Not A Code');
  assert.equal(asRefusal(odd), odd);
  assert.equal(asRefusal('text'), 'text');
});

test('machines.list carries a signed-out agent’s own words, with the logins its Host lists, to the phone (#4861)', async () => {
  const words = 'Sign in on box: login or api-key';
  const { host } = fakeHost({ rows: () => [row({ agents: [{ id: 'kimi', label: 'Kimi Code', state: 'signin', reason: words }] })] });
  const r = rig({ host: () => host });
  const { machines } = ok(await r.phone('p1').ask('machines.list'));
  assert.deepEqual(
    machines.find((m: any) => m.id === 'ssh:box').agents.map((a: any) => [a.id, a.state, a.reason]),
    [['kimi', 'signin', words]],
  );
});
