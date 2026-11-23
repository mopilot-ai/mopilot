// The Mac's machines on the phone (mobile/src/remote/machines.ts and useMachines): read defensively, words as the Mac gives them, kept current by machines.changed, hidden without Host access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
const linkPath = '../mobile/src/macLink';
const { MacLinkProvider, useMachines } = await import(linkPath);
const { parseMachines, agentLine, hostOfflineLine, hostCardLine, followMachines } = await import('../mobile/src/remote/machines');

const local = {
  id: 'local',
  name: 'MacBook Pro',
  status: 'online',
  line: 'Online',
  tone: 'ok',
  path: 'direct',
  keepRunning: true,
  agents: [
    { id: 'claude', label: 'Claude Code', state: 'ready', via: 'own' },
    { id: 'codex', label: 'Codex', state: 'signin', via: null },
  ],
};
const host = {
  id: 'h1',
  name: 'Studio',
  status: 'offline',
  line: 'Restarted · waiting for sign-in',
  tone: 'warn',
  keepRunning: false,
  agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', via: 'key' }],
};

test('the list keeps the Mac’s own line and tone, drops rows without an id or a line, and quiets unknown words', () => {
  const list = parseMachines({ machines: [local, host, { id: 'x' }, { line: 'Online' }, null, 'junk'] });
  assert.deepEqual(
    list.map((m: any) => [m.id, m.name, m.line, m.tone, m.keepRunning]),
    [
      ['local', 'MacBook Pro', 'Online', 'ok', true],
      ['h1', 'Studio', 'Restarted · waiting for sign-in', 'warn', false],
    ],
  );
  const odd = parseMachines({
    machines: [
      { id: 'local', line: 'Online', status: 'melting', tone: 'pink', agents: [{ id: 'a', state: 'weird', via: 'magic' }, {}, 7] },
    ],
  })[0];
  assert.deepEqual([odd.name, odd.status, odd.tone, odd.keepRunning], ['This Mac', 'offline', 'off', null]);
  assert.deepEqual(odd.agents, [{ id: 'a', label: 'a', state: 'missing', via: null }]);
  assert.equal(parseMachines({ machines: [{ id: 'h9', line: 'Online', agents: 'no' }] })[0].name, 'h9');
  assert.deepEqual(parseMachines({ machines: [{ id: 'h9', line: 'Online', agents: 'no' }] })[0].agents, []);
  assert.deepEqual(parseMachines(null), []);
  assert.deepEqual(parseMachines({ machines: 'no' }), []);
});

test('an agent says where its sign-in lives, and never asks the phone to sign in', () => {
  const line = (state: string, via: string | null) => agentLine({ id: 'a', label: 'A', state, via } as any);
  assert.equal(line('signin', null), 'Sign in on your Mac');
  assert.equal(line('missing', null), 'Not installed');
  assert.equal(line('ready', 'key'), "Uses your Mac's key · new turns need your Mac online");
  assert.equal(line('ready', 'org'), 'Organization sign-in');
  assert.equal(line('ready', 'own'), 'Ready');
});

test('a signed-out agent of a machine says the Host’s words, with the logins it lists (#4861); one without words keeps pointing at the Mac', () => {
  const [machine] = parseMachines({
    machines: [
      {
        id: 'h1',
        line: 'Online',
        agents: [
          { id: 'kimi', label: 'Kimi', state: 'signin', reason: 'Sign in on mopilot-bench: OAuth or API key' },
          { id: 'qwen', label: 'Qwen', state: 'signin', reason: '  ' },
          { id: 'ghost', label: 'Ghost', state: 'signin' },
        ],
      },
    ],
  });
  assert.deepEqual(
    machine.agents.map((a: any) => agentLine(a, 'mopilot-bench')),
    ['Sign in on mopilot-bench: OAuth or API key', 'Sign in on your Mac', 'Sign in on your Mac'],
  );
  // the phone's own list can carry an empty reason: that is no words, so the line is never blank
  assert.equal(agentLine({ id: 'a', label: 'A', state: 'signin', via: null, reason: '' }), 'Sign in on your Mac');
});

test('the agents a Host reports reach the phone with their logins end to end: what the Host words is what the line says (#4861)', async () => {
  const { agentsOf } = await import('../shared/host/agentReadiness.mjs');
  const { shownAgents } = await import('../shared/host/machineLine.mjs');
  const harnesses = [
    { id: 'claude', detected: true, signedIn: true },
    { id: 'dsh', detected: true, signedIn: false },
    { id: 'kimi', detected: true, signedIn: false, signIn: ['login', 'api-key'] },
    { id: 'goose', detected: false, signedIn: false },
  ];
  const [machine] = parseMachines({ machines: [{ id: 'h1', line: 'Online', agents: shownAgents(agentsOf(harnesses, 'bench')) }] });
  assert.deepEqual(
    machine.agents.map((a: any) => [a.id, agentLine(a, 'bench')]),
    [
      ['claude', 'Ready'],
      ['dsh', 'Sign in on bench'],
      ['kimi', 'Sign in on bench: login or api-key'],
    ],
    'an agent the machine lacks and the user never runs is not listed; none is a blank line',
  );
});

test('a chat on a Host while the Mac is away says where it runs', () => {
  const machines = parseMachines({ machines: [local, host] });
  assert.equal(hostOfflineLine(machines, 'h1'), 'Running on Studio · Your Mac is offline');
  assert.equal(hostOfflineLine(null, 'h1'), 'Running on another machine · Your Mac is offline');
  assert.equal(hostOfflineLine(machines, null), null, 'a chat on this Mac has no such line');
  assert.equal(hostOfflineLine(machines, undefined), null);
});

function fakeRuntime(hello: unknown = { capabilities: { machines: true } }) {
  const listeners = new Set<(m: any) => void>();
  const reads: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const runtime: any = {
    calls: 0,
    request: (method: string) => {
      if (method === 'machine.hello') return hello instanceof Error ? Promise.reject(hello) : Promise.resolve(hello);
      assert.equal(method, 'machines.list');
      runtime.calls++;
      return new Promise((resolve, reject) => reads.push({ resolve, reject }));
    },
    onEvent: (f: (m: any) => void) => (listeners.add(f), () => listeners.delete(f)),
  };
  const emit = (m: any) => listeners.forEach((f) => f(m));
  return { runtime, reads, emit, listeners };
}

test('followMachines hands the Mac’s host.phoneChat answer to the phone’s paths, with or without Host access', async () => {
  const told: boolean[] = [];
  for (const hello of [
    { capabilities: { machines: true, phoneChat: true } },
    { capabilities: { machines: true } },
    { capabilities: { phoneChat: true } },
  ]) {
    const { runtime } = fakeRuntime(hello);
    runtime.direct = { chat: { told: (on: boolean, mac?: string) => told.push(on, mac as any) } };
    runtime.snapshot = () => ({ selectedPair: 'p1' });
    const stop = followMachines(runtime, () => undefined);
    await flush();
    stop();
  }
  assert.deepEqual(told, [true, 'p1', false, 'p1', true, 'p1']);
  // before any Mac is selected the answer is kept under no Mac's name
  const none = fakeRuntime({ capabilities: { machines: true, phoneChat: true } });
  none.runtime.direct = { chat: { told: (on: boolean, mac?: string) => told.push(on, mac as any) } };
  none.runtime.snapshot = () => ({ selectedPair: null });
  const stopNone = followMachines(none.runtime, () => undefined);
  await flush();
  stopNone();
  assert.deepEqual(told.slice(-2), [true, '']);
  // a phone with no paths of its own has nobody to tell
  const bare = fakeRuntime();
  const stop = followMachines(bare.runtime, () => undefined);
  await flush();
  stop();
});

test('followMachines: the read, then each change; a read that answers after a change, or after stop, is dropped; a refusal hides', async () => {
  const seen: any[] = [];
  const { runtime, reads, emit, listeners } = fakeRuntime();
  const stop = followMachines(runtime, (m: any) => seen.push(m && m.map((x: any) => x.id)));
  await flush();
  emit({ ev: 'chat.changed' });
  emit({ ev: 'machines.changed', machines: [local, host] });
  reads[0].resolve({ machines: [local] });
  await flush();
  assert.deepEqual(seen, [['local', 'h1']], 'the older read does not undo the change');
  emit({ ev: 'machines.changed', machines: [local] });
  assert.equal(seen.at(-1), null, 'Host access closed: the Mac sends only itself, and the machines hide');
  stop();
  assert.equal(listeners.size, 0);
  emit({ ev: 'machines.changed', machines: [local, host] });
  assert.equal(seen.length, 2, 'nothing after stop');

  const refused: any[] = [];
  const two = fakeRuntime();
  const stop2 = followMachines(two.runtime, (m: any) => refused.push(m));
  await flush();
  two.reads[0].reject(Object.assign(new Error('No Host access'), { code: 'forbidden' }));
  await flush();
  assert.deepEqual(refused, [null], 'a Mac without Host access shows no machines');
  stop2();

  const late: any[] = [];
  const three = fakeRuntime();
  const stop3 = followMachines(three.runtime, (m: any) => late.push(m));
  await flush();
  stop3();
  three.reads[0].resolve({ machines: [local, host] });
  await flush();
  assert.deepEqual(late, [], 'a read that answers after stop is dropped');
  const four = fakeRuntime();
  const afterStop: any[] = [];
  const stop4 = followMachines(four.runtime, (m: any) => afterStop.push(m));
  await flush();
  stop4();
  four.reads[0].reject(new Error('cut off'));
  await flush();
  assert.deepEqual(afterStop, [], 'a failure after stop is dropped too');
});

test('followMachines asks machine.hello first: a Mac without capabilities.machines is never asked for the list, and a list of only itself hides', async () => {
  for (const hello of [{ capabilities: { machines: false } }, { capabilities: {} }, {}, null, new Error('old Mac')]) {
    const seen: any[] = [];
    const rig = fakeRuntime(hello);
    const stop = followMachines(rig.runtime, (m: any) => seen.push(m));
    await flush();
    assert.deepEqual(seen, [null]);
    assert.equal(rig.runtime.calls, 0, 'no machines.list without Host support');
    stop();
  }
  const quiet: any[] = [];
  const gone = fakeRuntime({ capabilities: { machines: false } });
  const stop = followMachines(gone.runtime, (m: any) => quiet.push(m));
  stop();
  await flush();
  assert.deepEqual(quiet, [], 'a hello answered after stop says nothing');
  const alone: any[] = [];
  const only = fakeRuntime();
  followMachines(only.runtime, (m: any) => alone.push(m));
  await flush();
  only.reads[0].resolve({ machines: [local] });
  await flush();
  assert.deepEqual(alone, [null], 'no Hosts: nothing to show beyond the Mac itself');
});

test('useMachines: read while connected and shown, null while not; a new connection reads again and the old one is let go', async () => {
  const base = {
    phase: 'online',
    generation: 1,
    user: { id: 'u' },
    pairs: [{ pairId: 'p1', macId: 'm1', name: 'MacBook Pro' }],
    selectedPair: 'p1',
    presence: {},
    reconnect: null,
    outbox: [],
    error: null,
  };
  const { runtime, reads, emit, listeners } = fakeRuntime();
  const seen: any[] = [];
  const Probe = () => (seen.push(useMachines()), null);
  const el = document.createElement('div');
  const root = createRoot(el);
  const render = (state: any, rt: any = runtime) =>
    act(async () => root.render(createElement(MacLinkProvider, { state, runtime: rt }, createElement(Probe))));
  await render(base);
  await flush();
  assert.equal(seen.at(-1), null, 'nothing before the Mac answers');
  reads[0].resolve({ machines: [local, host] });
  await flush();
  assert.deepEqual(
    seen.at(-1).map((m: any) => m.id),
    ['local', 'h1'],
  );
  await act(async () => emit({ ev: 'machines.changed', machines: [local] }));
  await act(async () => emit({ ev: 'machines.changed', machines: [local, host, { ...host, id: 'h2' }] }));
  assert.deepEqual(
    seen.at(-1).map((m: any) => m.id),
    ['local', 'h1', 'h2'],
  );
  await render({ ...base, presence: { p1: { state: 'online', lastSeen: 2 } } });
  assert.equal(runtime.calls, 1, 'a snapshot of the same connection does not read again');
  await render({ ...base, phase: 'offline' });
  assert.equal(seen.at(-1), null, 'gone while the Mac is away');
  assert.equal(listeners.size, 0);
  await render({ ...base, generation: 2 });
  await flush();
  assert.equal(runtime.calls, 2, 'a new connection reads again');
  reads[1].resolve({ machines: [local, host] });
  await flush();
  assert.deepEqual(
    seen.at(-1).map((m: any) => m.id),
    ['local', 'h1'],
  );
  await render(base, undefined);
  assert.equal(seen.at(-1), null, 'without a runtime there are no machines');
  // nothing is asked of the Mac until a screen shows machines, and the last one to leave stops the follow
  const second = createRoot(document.createElement('div'));
  const quiet = fakeRuntime();
  const Other = () => null;
  await act(async () =>
    second.render(createElement(MacLinkProvider, { state: { ...base, generation: 9 }, runtime: quiet.runtime }, createElement(Other))),
  );
  await flush();
  assert.deepEqual([quiet.runtime.calls, quiet.listeners.size], [0, 0], 'no screen shows machines: no request');
  await act(async () =>
    second.render(createElement(MacLinkProvider, { state: { ...base, generation: 9 }, runtime: quiet.runtime }, createElement(Probe))),
  );
  await flush();
  assert.deepEqual([quiet.runtime.calls, quiet.listeners.size], [1, 1], 'a screen that shows them starts the follow');
  await act(async () =>
    second.render(createElement(MacLinkProvider, { state: { ...base, generation: 9 }, runtime: quiet.runtime }, createElement(Other))),
  );
  assert.equal(quiet.listeners.size, 0, 'the last screen leaving stops it');
  await act(async () => second.unmount());
  await act(async () => root.unmount());
  assert.equal(listeners.size, 0);
});

test('useMachines outside the app (a screen drawn alone) has no machines and asks nothing, mounted or unmounted', async () => {
  const seen: any[] = [];
  const Probe = () => (seen.push(useMachines()), null);
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe)));
  assert.equal(seen.at(-1), null);
  await act(async () => root.unmount());
});

test('a row a Host card holds says which machine needs you, or another machine when the phone has no name for it', () => {
  const machines = parseMachines({ machines: [local, host] });
  assert.equal(hostCardLine(machines, 'h1'), 'Needs you on Studio');
  assert.equal(hostCardLine(machines, 'zz'), 'Needs you on another machine');
  assert.equal(hostCardLine(null, 'h1'), 'Needs you on another machine');
});
