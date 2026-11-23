// A scheduled task that runs on a Host names that machine on its row, as the Chats list names a Host's chat; this Mac's own tasks and tasks of a machine the phone cannot name add nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';

const screenPath = '../mobile/src/screens/Scheduled';
const linkPath = '../mobile/src/macLink';
const clientPath = '../mobile/src/remote/scheduled';
const { Scheduled } = await import(screenPath);
const { MacLinkProvider } = await import(linkPath);
const { loadScheduled, taskLine } = await import(clientPath);

const machine = (id: string, name: string) => ({ id, name, status: 'online', line: 'Online', tone: 'ok', keepRunning: null, agents: [] });
const MACHINES = [machine('local', 'This Mac'), machine('h1', 'Studio')];
const HOUR = 3_600_000;
const state = {
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
const now = Date.now();
const TASKS = {
  tasks: [
    { id: 'own', name: 'Own task', next: now + 2 * HOUR },
    { id: 'studio', name: 'Studio task', next: now + 3 * HOUR, hostId: 'h1', firesWhileMacAway: true },
    { id: 'gone', name: 'Retired task', next: now + 4 * HOUR, hostId: 'h9' },
    { id: 'local', name: 'Local task', next: now + 5 * HOUR, hostId: 'local' },
  ],
};

test('the Mac’s hostId is kept on a task, and anything that is not a name is dropped', async () => {
  const request = async (method: string) =>
    method === 'machine.hello'
      ? { capabilities: { methods: ['scheduled.list'] } }
      : { tasks: [{ id: 'a', hostId: 'h1' }, { id: 'b', hostId: '' }, { id: 'c', hostId: 7 }, { id: 'd' }] };
  const { tasks } = await loadScheduled(request as any);
  assert.deepEqual(
    tasks.map((t: any) => t.hostId),
    ['h1', null, null, null],
  );
});

test('a task line says when, then the machine it runs on: nothing for this Mac, a machine not listed, or no list yet', () => {
  const at = (hostId: string | null) => ({ id: 't', name: 'T', next: now + 2 * HOUR, hostId });
  assert.equal(taskLine(at('h1'), MACHINES, now), 'In 2 h · Studio');
  assert.equal(taskLine(at(null), MACHINES, now), 'In 2 h');
  assert.equal(taskLine(at('local'), MACHINES, now), 'In 2 h');
  assert.equal(taskLine(at('h9'), MACHINES, now), 'In 2 h');
  assert.equal(taskLine(at('h1'), null, now), 'In 2 h');
  assert.equal(taskLine({ id: 't', name: 'T', next: null, hostId: 'h1' }, MACHINES, now), 'No upcoming run · Studio');
});

test('on the Scheduled list a Host’s task row names its machine, the others do not', async () => {
  const s = scripted((method) =>
    method === 'machine.hello'
      ? { capabilities: { methods: ['scheduled.list', 'machines.list'], machines: true } }
      : method === 'machines.list'
        ? { machines: MACHINES }
        : method === 'scheduled.list'
          ? TASKS
          : undefined,
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(MacLinkProvider, { state, runtime: s.runtime }, createElement(Scheduled, { runtime: s.runtime, back: () => {} })),
    ),
  );
  await flush();
  await flush();
  const text = host.textContent!;
  assert.match(text, /Studio taskIn 3 h · Studio/);
  assert.match(text, /Own taskIn 2 h(?!\s*·)/);
  assert.match(text, /Retired taskIn 4 h(?!\s*·)/);
  assert.match(text, /Local taskIn 5 h(?!\s*·)/);
  await act(async () => root.unmount());
  host.remove();
});
