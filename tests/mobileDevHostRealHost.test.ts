// The dev host's real Host (scripts/mobile-dev-host/realHost.mjs, --real-host): set up through the acceptance run's steps, joined to the made-up machines,
// and enrolled with a phone through the Mac's own courier (electron/host/phoneEnroll.cjs) via the real remote service; plus its switch, command and the log's redaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rig } from './support/remote-kit.ts';
import { ok } from './support/remoteHostKit.ts';
import { fakeKit, key } from './support/fakeRealHostKit.ts';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createFakeHosts } from '../scripts/mobile-dev-host/fakeHosts.mjs';
import { createControls } from '../scripts/mobile-dev-host/controls.mjs';
import { forwarderCommand, startRealHost, TART_GATEWAY } from '../scripts/mobile-dev-host/realHost.mjs';
import { createPhoneEnroll, kit, realHostFor } from '../scripts/mobile-dev-host/realHostKit.mjs';
import { hostSeesRelay, requestLine } from '../scripts/mobile-dev-host/format.mjs';

const VM = 'mopilot-bench';
const RELAY = { hostId: 'h_phone0000000000000001', secret: 's'.repeat(43), pairId: 'p_phone00001', relayUrl: 'wss://relay.example/v1/ws' };
const GOOD = { hostId: `ssh:${VM}`, relay: RELAY, appPub: key('A'), appEphPub: key('B'), edPub: key('C'), name: 'Pocket iPhone' };

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'real-host-'));
const start = (k: any, log: string[] = [], more: object = {}) =>
  startRealHost({
    vm: VM,
    dir: scratch(),
    log: (l: string) => void log.push(l),
    kit: k,
    createPhoneEnroll,
    relayPort: 8787,
    now: () => 77,
    wait: async () => undefined,
    ...more,
  });

test('the Host is set up through the acceptance steps, given the fake agent, restarted, and the relay made reachable on its loopback', async () => {
  const f = fakeKit();
  const log: string[] = [];
  const real = await start(f.k, log);
  assert.deepEqual(f.calls, [['makeCtx', VM], ['runSteps', ['A5'], true], ['provideFakeAgent'], ['restart'], ['hostUp']]);
  assert.ok(
    f.ran.some((c) => c.includes('signed-in.json')),
    'the test agent is signed in on the Host',
  );
  assert.match(log.join('\n'), /host: A5 PASS Pair/);
  assert.match(log.join('\n'), /runs a real Host \(ssh:mopilot-bench\)/);
  assert.equal(real.id, `ssh:${VM}`);
  assert.equal(real.relayUrl, 'ws://127.0.0.1:8787/v1/ws');
  assert.ok(
    f.ran.find((c) => c.includes('nohup'))!.includes('"/opt/node" -e') &&
      f.ran.find((c) => c.includes('nohup'))!.includes(`"${TART_GATEWAY}"`) &&
      f.ran.find((c) => c.includes('nohup'))!.includes('listen(8787,"127.0.0.1")'),
  );
  assert.deepEqual(real.record(), {
    name: VM,
    harnesses: [
      { id: 'fake', detected: true, signedIn: true },
      { id: 'claude', detected: true, signedIn: false },
      { id: 'codex', detected: false, signedIn: false },
    ],
  });
  const row = real.row();
  assert.deepEqual(
    row.agents.map((a: any) => [a.id, a.label, a.state, a.reason]),
    [
      ['fake', 'fake', 'ready', ''],
      ['claude', 'Claude Code', 'signin', `Sign in on ${VM}: login or api-key`],
      ['codex', 'Codex', 'missing', `Not installed on ${VM}`],
    ],
    'the row carries the Host’s own agents, named as the app names them, a signed-out one in the Host’s own words with the logins it lists (#4861)',
  );
  assert.equal(row.note, 'SSH · fake');
  assert.deepEqual([row.id, row.status, row.lastSeen, row.agents[0].id], [`ssh:${VM}`, 'online', 77, 'fake']);
  real.setOnline(false);
  assert.equal(real.row().status, 'offline');
  await real.stop();
  assert.deepEqual(f.calls.at(-1), ['cleanup']);
  assert.equal(f.ran.at(-1), 'kill 4321 2>/dev/null; true');
  await real.stop({ keep: true });
  assert.deepEqual(f.calls.at(-1), ['removeTestAgent', { restartHost: true }]);
});

test('a step that fails, or a forwarder that does not start, ends the set-up with what went wrong', async () => {
  await assert.rejects(() => start(fakeKit({ failStep: true }).k), /The Host could not be set up on mopilot-bench: A5 Pair: refused/);
  const bad = fakeKit({ forwarder: { code: 1, stdout: '', stderr: ' no node\n' } });
  await assert.rejects(() => start(bad.k), /The relay forwarder did not start in mopilot-bench: no node/);
  const odd = fakeKit({ forwarder: { code: 0, stdout: 'oops\n', stderr: '' } });
  await assert.rejects(() => start(odd.k), /did not start in mopilot-bench: oops/);
  assert.match(
    forwarderCommand('/n', 9, 'g'),
    /^\( nohup "\/n" -e '.*connect\(9,"g"\).*listen\(9,"127\.0\.0\.1"\)' >\/dev\/null 2>&1 & echo \$! \)$/,
  );
});

/** The made-up machines with the real Host among them, served by the real remote service. */
async function world() {
  const f = fakeKit();
  const dir = scratch();
  const real = await startRealHost({ vm: VM, dir, log: () => undefined, kit: f.k, createPhoneEnroll, relayPort: 8787, now: () => 1000 });
  const app = createFakeApp({
    repo: '/repo',
    log: () => undefined,
    now: () => 10 * 86_400_000,
    sleep: async () => undefined,
    status: async () => '',
  });
  const hosts = createFakeHosts({ app, log: () => undefined, now: () => 1000, real });
  const r = rig({ ops: app.ops, host: () => hosts, machineName: () => 'Dev Mac' });
  app.bind(r.service);
  return { f, real, hosts, r, p: r.phone('p1'), dir };
}

test('the real Host is a machine on the phone’s list, and a chat can be asked of its folders', async () => {
  const { p, hosts } = await world();
  const { machines } = ok(await p.ask('machines.list'));
  const mine = machines.find((m: any) => m.id === `ssh:${VM}`);
  assert.equal(mine.status, 'online');
  assert.equal(hosts.record(`ssh:${VM}`).name, VM);
  const folders = ok(await p.ask('machines.folders', { id: `ssh:${VM}` }));
  assert.equal(folders.path, '/Users/dev');
});

test('machines.enroll runs the Mac’s own courier against the Host: client added, link handed over, state on; forget takes both away', async () => {
  const { p, f, real } = await world();
  const setUp = f.hostCalls.length; // the Host's agents were read once, as it came up
  await real.direct.offer(`ssh:${VM}`, 'p1');
  const answer = ok(await p.ask('machines.enroll', GOOD));
  assert.deepEqual([answer.hostPub, answer.hostKey, answer.name, answer.features], [key('P'), 'hostkey1', VM, ['clients', 'relay']]);
  assert.deepEqual(
    f.hostCalls.slice(setUp).map((c) => c[0]),
    ['host.hello', 'host.challenge', 'host.clientAdd', 'host.relayEnroll', 'close'],
  );
  const relayCall = f.hostCalls.find((c) => c[0] === 'host.relayEnroll')![1];
  assert.deepEqual([relayCall.hostId, relayCall.client, relayCall.pairId], [RELAY.hostId, 'fp1', RELAY.pairId]);
  assert.equal(real.direct.stateOf(`ssh:${VM}`, 'p1'), 'on');
  ok(await p.ask('machines.forget', { hostId: `ssh:${VM}` }));
  assert.deepEqual(
    f.hostCalls.slice(setUp + 5).map((c) => c[0]),
    ['host.hello', 'host.clientRemove', 'host.relayForget', 'close'],
  );
  assert.equal(real.direct.stateOf(`ssh:${VM}`, 'p1'), 'off');
});

test('the courier is only handed a connection to this Host', async () => {
  let given: any;
  const f = fakeKit();
  await startRealHost({
    vm: VM,
    dir: scratch(),
    log: () => undefined,
    kit: f.k,
    relayPort: 1,
    createPhoneEnroll: (o: any) => ((given = o), createPhoneEnroll(o)),
  });
  assert.equal(given.allowed(), true);
  await assert.rejects(() => given.paired('ssh:other'), /ssh:other is not the Host in mopilot-bench/);
  const s = await given.paired(`ssh:${VM}`);
  assert.deepEqual(await s.call('host.challenge'), { hostId: 'hostkey1' });
  s.close();
  assert.match(given.file, /host-phone-direct\.json$/);
});

test('the Mac’s switch: on offers direct access to a phone, off takes it away; without a real Host there is none', async () => {
  const { hosts, real } = await world();
  await hosts.setDirect('p1', true);
  assert.equal(real.direct.stateOf(`ssh:${VM}`, 'p1'), 'offered');
  await hosts.setDirect('p1', false);
  assert.equal(real.direct.stateOf(`ssh:${VM}`, 'p1'), 'off');
  const app = createFakeApp({ repo: '/repo', log: () => undefined, now: () => 1, sleep: async () => undefined, status: async () => '' });
  const plain = createFakeHosts({ app, log: () => undefined, now: () => 1 });
  assert.equal(plain.phoneDirect, null);
  await assert.rejects(() => plain.setDirect('p1', true), /--real-host/);
});

test('the dev host command "direct": every paired phone, both ways, and the reasons it cannot', async () => {
  const set: any[][] = [];
  let changed = 0;
  const base = {
    bench: { momo: false, brain: false },
    relayClient: () => ({ state: 'open', setPresence: () => undefined }),
    cutMac: () => undefined,
    momoSwitched: () => undefined,
    restartRelay: async () => undefined,
    unpair: async () => true,
    changed: () => undefined,
    after: () => undefined,
    log: () => undefined,
    pushRequest: async () => 'sent',
    seal: () => null,
    setTitles: async () => undefined,
    chatTitle: () => null,
  };
  const hosts = {
    toggle: () => true,
    changed: () => void (changed += 1),
    direct: async (pair: string, on: boolean) => void set.push([pair, on]),
  };
  const phones = [
    { id: 'd1', name: 'A', pairId: 'p1' },
    { id: 'd2', name: 'B', pairId: 'p2' },
  ];
  const c = createControls({ ...base, devices: () => phones, hosts } as any);
  assert.match(await c.direct(true), /direct access is on for A, B: the phone hears machines\.changed/);
  assert.deepEqual(set, [
    ['p1', true],
    ['p2', true],
  ]);
  await c.direct(false);
  assert.equal(set.at(-1)?.[1], false);
  assert.equal(changed, 2);
  await assert.rejects(() => createControls({ ...base, devices: () => [], hosts } as any).direct(true), /No phone is paired/);
  await assert.rejects(() => createControls({ ...base, devices: () => phones } as any).direct(true), /--real-host/);
});

test('the enrollment the log shows has no credential, and the Host sees the relay by its own address', () => {
  const params = { ...GOOD, relay: { ...RELAY, secret: 'topsecret'.repeat(5) } };
  const text = requestLine('p_abcdef1234', 'machines.enroll', params);
  assert.ok(!text.includes('topsecret') && text.includes('…'));
  assert.match(requestLine('p_abcdef1234', 'machines.enroll', { hostId: 'x' }), /machines\.enroll \{"hostId":"x"\}/);
  assert.match(requestLine('p_abcdef1234', 'machines.list', undefined), /machines\.list \{\}/);
  assert.equal(hostSeesRelay('machines.enroll', GOOD, 'ws://127.0.0.1:8787/v1/ws').relay.relayUrl, 'ws://127.0.0.1:8787/v1/ws');
  assert.equal(hostSeesRelay('machines.enroll', GOOD, 'ws://127.0.0.1:8787/v1/ws').relay.secret, RELAY.secret);
  assert.equal(hostSeesRelay('machines.enroll', GOOD, undefined), GOOD);
  assert.equal(hostSeesRelay('machines.list', GOOD, 'ws://x'), GOOD);
  assert.equal(hostSeesRelay('machines.enroll', { hostId: 'x' }, 'ws://x').hostId, 'x');
});

test('the real kit makes a context as host-accept does, and realHostFor sets the Host up with the kit it is given', async () => {
  const ctx = kit.makeCtx(VM);
  assert.deepEqual(
    [ctx.target, ctx.root.endsWith('mopilot') || ctx.root.includes('mopilot'), typeof ctx.m.run, Object.keys(ctx.state).length],
    [VM, true, 'function', 0],
  );
  fs.rmSync(ctx.outDir, { recursive: true, force: true });
  const f = fakeKit();
  const real = await realHostFor({ vm: VM, dir: scratch(), log: () => undefined, relayPort: 8787 }, f.k as any);
  assert.equal(real.id, `ssh:${VM}`);
  assert.equal(kit.STEPS.length > 5, true);
});

test('the real Host raises a card with the app gone, and the app answers the cards it waits on', async () => {
  const card = {
    chatId: 'acp:fake:c1',
    epoch: 1,
    requestId: 'r1',
    options: [
      { optionId: 'o-allow', kind: 'allow' },
      { optionId: 'o-deny', kind: 'deny' },
    ],
  };
  const f = fakeKit({ pending: [card, { ...card, requestId: 'r2', options: [{ optionId: 'only', kind: 'other' }] }] });
  const real = await start(f.k);
  const chatId = await real.raise();
  assert.match(chatId, /^acp:fake:card1/);
  assert.deepEqual(
    f.hostCalls
      .filter((c) => c[0] === 'chat.subscribe' || c[0] === 'chat.start')
      .map((c) => [c[0], c[1].chatId === chatId, c[1].text ?? null]),
    [
      ['chat.subscribe', true, null],
      ['chat.start', true, 'PERMIT it'],
    ],
  );
  assert.equal(f.hostCalls.at(-1)?.[0], 'close', 'the app drops its connection');
  await real.raise('PERMIT again');
  assert.equal(f.hostCalls.filter((c) => c[0] === 'chat.start').at(-1)?.[1].text, 'PERMIT again');
  const before = f.hostCalls.length;
  assert.equal(await real.answerHere('deny'), 2);
  const answers = f.hostCalls
    .slice(before)
    .filter((c) => c[0] === 'chat.answer')
    .map((c) => [c[1].requestId, c[1].optionId]);
  assert.deepEqual(
    answers,
    [
      ['r1', 'o-deny'],
      ['r2', 'only'],
    ],
    'the wanted kind, else the first option',
  );
  assert.equal(f.hostCalls.at(-1)?.[0], 'close');
  assert.equal(await (await start(fakeKit().k)).answerHere('allow'), 0);
});

test('the made-up machines only raise or answer cards when a real Host is among them; the commands say what happened', async () => {
  const { hosts, real } = await world();
  assert.match(await hosts.hostCard('PERMIT x'), /^acp:fake:card/);
  assert.equal(await hosts.hostAnswer('allow'), 0);
  const app = createFakeApp({ repo: '/repo', log: () => undefined, now: () => 1, sleep: async () => undefined, status: async () => '' });
  const plain = createFakeHosts({ app, log: () => undefined, now: () => 1 });
  assert.throws(() => plain.hostCard(), /--real-host/);
  assert.throws(() => plain.hostAnswer('allow'), /--real-host/);
  const base = {
    bench: { momo: false, brain: false },
    relayClient: () => ({ state: 'open', setPresence: () => undefined }),
    cutMac: () => undefined,
    momoSwitched: () => undefined,
    restartRelay: async () => undefined,
    devices: () => [],
    unpair: async () => true,
    changed: () => undefined,
    after: () => undefined,
    log: () => undefined,
    pushRequest: async () => 'sent',
    seal: () => null,
    setTitles: async () => undefined,
    chatTitle: () => null,
  };
  const answered = [0, 1, 3];
  const c = createControls({
    ...base,
    hosts: {
      toggle: () => true,
      changed: () => undefined,
      direct: async () => undefined,
      card: async () => 'acp:fake:cardX',
      answer: async () => answered.shift(),
    },
  } as any);
  assert.match(await c.hostCard(undefined), /raised a card in acp:fake:cardX/);
  assert.equal(await c.hostAnswer('allow'), 'the Host has no card waiting');
  assert.equal(await c.hostAnswer('deny'), 'the app answered 1 card (deny)');
  assert.equal(await c.hostAnswer('deny'), 'the app answered 3 cards (deny)');
  const none = createControls(base as any);
  await assert.rejects(() => none.hostCard(undefined), /--real-host/);
  await assert.rejects(() => none.hostAnswer('allow'), /--real-host/);
  void real;
});

test('what the Host reports of an agent (the source it uses, the sources that exist) reaches the machine row as through a real Mac (#4953)', async () => {
  const sources = { own: true, key: false, org: false };
  const real = await start(fakeKit({ harnesses: [{ id: 'claude', detected: true, signedIn: true, using: 'own', sources }] }).k);
  const claude = real.row().agents[0];
  assert.deepEqual([claude.id, claude.state, claude.using, claude.sources], ['claude', 'ready', 'own', sources]);
});

test('the real Host says which agents it has, installed or absent and signed in or out', async () => {
  const real = await start(fakeKit().k);
  assert.equal(await real.status(), 'fake:installed/in claude:installed/out codex:absent/out');
  assert.equal(await (await start(fakeKit({ harnesses: [] }).k)).status(), '');
  assert.equal(await (await start(fakeKit({ harnesses: null as any }).k)).status(), '', 'a status without the list is no agents');
  const { hosts } = await world();
  assert.match(await hosts.hostStatus(), /fake:installed\/in/);
  const app = createFakeApp({ repo: '/repo', log: () => undefined, now: () => 1, sleep: async () => undefined, status: async () => '' });
  assert.throws(() => createFakeHosts({ app, log: () => undefined, now: () => 1 }).hostStatus(), /--real-host/);
  const base = {
    bench: { momo: false, brain: false },
    relayClient: () => ({ state: 'open', setPresence: () => undefined }),
    cutMac: () => undefined,
    momoSwitched: () => undefined,
    restartRelay: async () => undefined,
    devices: () => [],
    unpair: async () => true,
    changed: () => undefined,
    after: () => undefined,
    log: () => undefined,
    pushRequest: async () => 'sent',
    seal: () => null,
    setTitles: async () => undefined,
    chatTitle: () => null,
  };
  const states = ['fake:installed/in', ''];
  const c = createControls({
    ...base,
    hosts: {
      toggle: () => true,
      changed: () => undefined,
      direct: async () => undefined,
      card: async () => '',
      answer: async () => 0,
      status: async () => states.shift(),
    },
  } as any);
  assert.equal(await c.hostStatus(), "the Host's agents: fake:installed/in");
  assert.equal(await c.hostStatus(), "the Host's agents: none");
  await assert.rejects(() => createControls(base as any).hostStatus(), /--real-host/);
});

test('the real Host starts a chat on each of its agents with the cheapest model at low effort, and the app drops its connection', async () => {
  const f = fakeKit();
  const real = await start(f.k);
  const started = async (agent: 'fake' | 'claude' | 'codex') => {
    const before = f.hostCalls.length;
    const chatId = await real.startChat(agent, `ask ${agent}`);
    const call = f.hostCalls.slice(before).find((c) => c[0] === 'chat.start')![1];
    assert.equal(f.hostCalls.at(-1)?.[0], 'close');
    return { chatId, call };
  };
  const fake = await started('fake');
  assert.match(fake.chatId, /^acp:fake:chat/);
  assert.deepEqual([fake.call.harness, fake.call.model, fake.call.effort, fake.call.text], ['acp:fake', undefined, undefined, 'ask fake']);
  const claude = await started('claude');
  assert.match(claude.chatId, /^claude:[0-9a-f-]{36}$/);
  assert.deepEqual([claude.call.harness, claude.call.model, claude.call.effort], ['claude', 'haiku', 'low']);
  const codex = await started('codex');
  assert.match(codex.chatId, /^[0-9a-f-]{36}$/);
  assert.deepEqual([codex.call.harness, codex.call.model, codex.call.effort], ['codex', 'gpt-5.6-luna', 'low']);
  const { hosts } = await world();
  const adopted = await hosts.hostChat('fake', 'x\nsecond line');
  assert.match(adopted, /^acp:fake:chat/);
  assert.equal(hosts.hostOf(adopted), `ssh:${VM}`, 'the Mac lists the chat as the machine’s');
  assert.equal(hosts.hostOf(await hosts.hostChat('claude', 'hi')), `ssh:${VM}`);
  const app = createFakeApp({ repo: '/repo', log: () => undefined, now: () => 1, sleep: async () => undefined, status: async () => '' });
  await assert.rejects(() => createFakeHosts({ app, log: () => undefined, now: () => 1 }).hostChat('fake', 'x'), /--real-host/);
  const base = {
    bench: { momo: false, brain: false },
    relayClient: () => ({ state: 'open', setPresence: () => undefined }),
    cutMac: () => undefined,
    momoSwitched: () => undefined,
    restartRelay: async () => undefined,
    devices: () => [],
    unpair: async () => true,
    changed: () => undefined,
    after: () => undefined,
    log: () => undefined,
    pushRequest: async () => 'sent',
    seal: () => null,
    setTitles: async () => undefined,
    chatTitle: () => null,
  };
  const c = createControls({
    ...base,
    hosts: {
      toggle: () => true,
      changed: () => undefined,
      direct: async () => undefined,
      card: async () => '',
      answer: async () => 0,
      status: async () => '',
      chat: async (a: string, t: string) => `${a}-${t}`,
    },
  } as any);
  assert.equal(await c.hostChat('codex', 'hi'), 'the Host started codex chat codex-hi');
  await assert.rejects(() => createControls(base as any).hostChat('codex', 'hi'), /--real-host/);
});

test('a Host that reports no agent says so, its agents are read again when asked, and the test agent signed out is not a login the machine needs', async () => {
  const none = await start(fakeKit({ harnesses: null }).k);
  assert.equal(none.row().note, 'SSH · no agent ready');
  assert.deepEqual(none.row().agents, []);
  const real = await start(fakeKit().k);
  await real.refreshAgents();
  assert.equal(real.row().agents.length, 3);
  const out = await start(
    fakeKit({
      harnesses: [
        { id: 'fake', detected: true, signedIn: false },
        { id: 'claude', detected: true, signedIn: true },
      ],
    }).k,
  );
  assert.deepEqual(
    out.row().agents.map((a: any) => a.id),
    ['claude'],
  );
});

test('the row waits for a Host that is still looking for its agents, and gives up after the time it was given', async () => {
  const reads = [[], [], [{ id: 'claude', detected: true, signedIn: true }]];
  const f = fakeKit();
  let n = 0;
  const session = f.k.session;
  (f.k as any).session = async (c: any) => {
    const s = await (session as any)(c);
    return {
      ...s,
      request: async (m: string, p: any) => (m === 'status' ? { harnesses: reads[Math.min(n++, reads.length - 1)] } : s.request(m, p)),
    };
  };
  const waits: number[] = [];
  const real = await start(f.k, [], { wait: async (ms: number) => void waits.push(ms) });
  assert.deepEqual(waits, [2000, 2000]);
  assert.equal(real.row().note, 'SSH · Claude Code');
  const none = await start(fakeKit({ harnesses: [] }).k, [], { readyMs: 4000, wait: async (ms: number) => void waits.push(ms) });
  assert.equal(none.row().note, 'SSH · no agent ready');
  assert.deepEqual(waits.slice(2), [2000, 2000]);
});

test('the default wait is a real timer', async () => {
  const started = Date.now();
  await startRealHost({
    vm: VM,
    dir: scratch(),
    log: () => undefined,
    kit: fakeKit({ harnesses: [] }).k,
    createPhoneEnroll,
    relayPort: 8787,
    readyMs: 1,
  });
  assert.ok(Date.now() - started >= 1900, 'it waited the 2 s step once');
});
