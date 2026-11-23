// The computer cards at the bottom of the Chats home: the Mac and each Host the Mac reports (name, the Mac's own line, chats that need input), only the Mac without Host access or while it is away; a Host chat's line while the Mac is away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLayout } from './support/phone/home-layout';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const linkPath = '../mobile/src/macLink';
const listPath = '../mobile/src/screens/ChatList';
const rowPath = '../mobile/src/components/ChatRow';
const { MacLinkProvider } = await import(linkPath);
const { ChatList } = await import(listPath);
const { useHomeFolds } = await import('../mobile/src/useHomeFolds');
const StateList = withLayout(ChatList, useHomeFolds, 'state');
const { ChatRow } = await import(rowPath);

const machine = (id: string, name: string, line: string, tone: string, status = 'online') => ({
  id,
  name,
  status,
  line,
  tone,
  keepRunning: null,
  agents: [],
});
const MACHINES = [
  machine('local', 'This Mac', 'Online', 'ok'),
  machine('h1', 'Studio', 'Online', 'ok'),
  machine('h2', 'Build box', 'Needs setup', 'warn', 'needs-setup'),
  machine('h3', 'Old laptop', 'Offline', 'off', 'offline'),
];
const state = (phase = 'online') => ({
  phase,
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p1', macId: 'm1', name: 'MacBook Pro' }],
  selectedPair: phase === 'online' ? 'p1' : null,
  presence: {},
  reconnect: null,
  outbox: [],
  error: null,
});
function runtime(machinesOn: boolean) {
  return {
    request: async (method: string) =>
      method === 'machine.hello'
        ? { capabilities: { machines: machinesOn } }
        : method === 'machines.list'
          ? { machines: MACHINES }
          : undefined,
    onEvent: () => () => undefined,
  };
}
async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const list = (chats: any[], props: any = {}) => createElement(StateList, { chats, failed: false, busy: false, open: () => {}, ...props });
const cards = (host: HTMLElement) =>
  [...host.querySelectorAll('button[aria-description="Opens your computers in Settings"]')].map((b) => b.getAttribute('aria-label'));

test('a Mac with Hosts shows a card for itself and one per Host, each read out with the Mac’s own line', async () => {
  let opened = 0;
  const v = await mount(
    createElement(MacLinkProvider, { state: state(), runtime: runtime(true) }, list([], { computers: () => opened++ })),
  );
  assert.deepEqual(cards(v.host), ['MacBook Pro, Connected', 'Studio, Online', 'Build box, Needs setup', 'Old laptop, Offline']);
  assert.match(
    v.host.textContent!,
    /MacBook ProConnected.*StudioOnline.*Build boxNeeds setup.*Old laptopOffline/,
    'a card shows the name over its line; "This Mac" is the Mac’s own card',
  );
  assert.doesNotMatch(v.host.textContent!, /Computers/, 'no Computers header');
  await act(async () => (v.host.querySelector('button[aria-label="Studio, Online"]') as HTMLElement).click());
  assert.equal(opened, 1, 'a Host card opens the computers in Settings too');
  await act(async () => (v.host.querySelector('button[aria-label="MacBook Pro, Connected"]') as HTMLElement).click());
  assert.equal(opened, 2, 'and so does the Mac’s');
  await v.done();
});

test('a card says how many chats need input on its computer, and counts none while the Mac is away', async () => {
  const chats = [
    { id: 'a', title: 'Mac one', state: 'waiting' },
    { id: 'b', title: 'Mac two', state: 'waiting' },
    { id: 'c', title: 'Studio one', state: 'waiting', hostId: 'h1' },
    { id: 'd', title: 'Studio busy', state: 'running', hostId: 'h1' },
    { id: 'e', title: 'Box idle', state: 'idle', hostId: 'h2' },
  ];
  const v = await mount(createElement(MacLinkProvider, { state: state(), runtime: runtime(true) }, list(chats)));
  assert.deepEqual(cards(v.host), [
    'MacBook Pro, Connected, 2 need input',
    'Studio, Online, 1 need input',
    'Build box, Needs setup',
    'Old laptop, Offline',
  ]);
  await v.done();
  const away = await mount(
    createElement(MacLinkProvider, { state: state('offline'), runtime: runtime(true) }, list(chats, { offline: true })),
  );
  assert.deepEqual(cards(away.host), ['MacBook Pro, Offline'], 'the last list read claims no state, so no count');
  await away.done();
});

test('without Host access, or while the Mac is away, only the Mac’s card shows', async () => {
  const none = await mount(createElement(MacLinkProvider, { state: state(), runtime: runtime(false) }, list([])));
  assert.deepEqual(cards(none.host), ['MacBook Pro, Connected']);
  await none.done();
  const away = await mount(createElement(MacLinkProvider, { state: state('offline'), runtime: runtime(true) }, list([])));
  assert.deepEqual(cards(away.host), ['MacBook Pro, Offline']);
  await away.done();
});

test('a chat on a Host says where it runs while the Mac is away, by the Host’s name when the Mac told it; a Mac chat does not', async () => {
  const offline = (node: any) => createElement(MacLinkProvider, { state: state('offline') }, node);
  const named = await mount(
    offline(createElement(ChatRow, { chat: { id: 'a', title: 'Remote', hostId: 'h1' }, machines: MACHINES, open: () => {} })),
  );
  assert.match(named.host.textContent!, /RemoteRunning on Studio · Your Mac is offline/);
  assert.ok(named.host.querySelector('[data-symbol="server.rack"]'));
  await named.done();
  const unknown = await mount(offline(createElement(ChatRow, { chat: { id: 'b', title: 'Remote', hostId: 'h9' }, open: () => {} })));
  assert.match(unknown.host.textContent!, /Running on another machine · Your Mac is offline/);
  await unknown.done();
  const local = await mount(offline(createElement(ChatRow, { chat: { id: 'c', title: 'Local' }, machines: MACHINES, open: () => {} })));
  assert.doesNotMatch(local.host.textContent!, /Running on/);
  await local.done();
  const here = await mount(
    createElement(
      MacLinkProvider,
      { state: state() },
      createElement(ChatRow, { chat: { id: 'd', title: 'Remote', hostId: 'h1' }, machines: MACHINES, open: () => {} }),
    ),
  );
  assert.doesNotMatch(here.host.textContent!, /Running on/, 'with the Mac there the row reads as usual');
  await here.done();
});

test('once the Mac goes away, a Host chat still names its Host from the last list the Mac sent', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const chats = [{ id: 'r', title: 'Remote', hostId: 'h1' }];
  const at = (phase: string) => createElement(MacLinkProvider, { state: state(phase), runtime: runtime(true) }, list(chats));
  await act(async () => root.render(at('online')));
  await flush();
  await flush();
  assert.match(host.textContent!, /Remote/);
  assert.doesNotMatch(host.textContent!, /Running on/);
  await act(async () => root.render(at('offline')));
  await flush();
  assert.match(host.textContent!, /Running on Studio · Your Mac is offline/);
  await act(async () => root.unmount());
  host.remove();
});
