// A chat on a Host while the Mac is away: the header's line says where it runs, named from the last machines the Mac sent (kept per pair, forgotten with the account).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const linkPath = '../mobile/src/macLink';
const headerPath = '../mobile/src/components/ChatHeader';
const knownPath = '../mobile/src/remote/knownMachines';
const { MacLinkProvider } = await import(linkPath);
const { ChatHeader } = await import(headerPath);
const { useKnownMachines, forgetMachines } = await import(knownPath);

const machine = (id: string, name: string) => ({ id, name, status: 'online', line: 'Online', tone: 'ok', keepRunning: null, agents: [] });
const MACHINES = [machine('local', 'This Mac'), machine('h1', 'Studio')];
const state = (phase: string, pairId = 'p1') => ({
  phase,
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId, macId: 'm1', name: 'MacBook Pro' }],
  selectedPair: phase === 'online' ? pairId : null,
  presence: {},
  reconnect: null,
  outbox: [],
  error: null,
});
const runtime = {
  request: async (method: string) =>
    method === 'machine.hello' ? { capabilities: { machines: true } } : method === 'machines.list' ? { machines: MACHINES } : undefined,
  onEvent: () => () => undefined,
};
const header = (hostId?: string) =>
  createElement(ChatHeader, {
    request: async () => ({}),
    chatId: 'c',
    title: 'Remote',
    subtitle: 'Claude Code · App',
    back: () => {},
    reload: () => {},
    hostId,
  });

async function render(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = async (next: any) => {
    await act(async () => root.render(next));
    await flush();
    await flush();
  };
  await show(node);
  return {
    host,
    show,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('the header of a Host chat says where it runs while the Mac is away, by the name the Mac last sent', async () => {
  forgetMachines();
  const at = (phase: string, hostId?: string) => createElement(MacLinkProvider, { state: state(phase), runtime }, header(hostId));
  const v = await render(at('online', 'h1'));
  assert.match(v.host.textContent!, /Claude Code · App/, 'with the Mac there the line reads as usual');
  await v.show(at('offline', 'h1'));
  assert.match(v.host.textContent!, /Running on Studio · Your Mac is offline/);
  assert.doesNotMatch(v.host.textContent!, /Claude Code · App/);
  assert.ok(
    v.host.querySelector('[aria-label="Runs on Studio"]'),
    'the button names the machine the chat runs on, not the Mac’s link (#4859)',
  );
  // a chat on the Mac itself has nothing running elsewhere
  await v.show(at('offline'));
  assert.match(v.host.textContent!, /Claude Code · App/);
  assert.doesNotMatch(v.host.textContent!, /Running on/);
  assert.ok(v.host.querySelector('[aria-label="Runs on MacBook Pro, Offline"]'));
  await v.done();
});

test('the name outlives the screen that heard it, stays with its pair, and leaves with the account', async () => {
  forgetMachines();
  // heard by one screen while the Mac was there
  const heard = await render(createElement(MacLinkProvider, { state: state('online'), runtime }, header('h1')));
  await heard.done();
  // a chat opened later, with the Mac already away
  const later = await render(createElement(MacLinkProvider, { state: state('offline'), runtime }, header('h1')));
  assert.match(later.host.textContent!, /Running on Studio/);
  await later.done();
  const other = await render(createElement(MacLinkProvider, { state: state('offline', 'p2'), runtime }, header('h1')));
  assert.match(other.host.textContent!, /Running on another machine · Your Mac is offline/, 'another Mac never named this one’s Host');
  await other.done();
  forgetMachines();
  const gone = await render(createElement(MacLinkProvider, { state: state('offline'), runtime }, header('h1')));
  assert.match(gone.host.textContent!, /Running on another machine/);
  await gone.done();
});

test('without a paired Mac (a screen drawn alone) the known machines are the live ones', async () => {
  let seen: unknown = 'unset';
  function Probe() {
    seen = useKnownMachines();
    return null;
  }
  const v = await render(createElement(Probe));
  assert.equal(seen, null);
  await v.done();
});
