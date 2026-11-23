// Add a computer's steps page: the Mac steps name the account and their button opens the camera; the Host tab, only with Host access, waits for the Mac to push a machine it did not list at the tap, the first Host included, and only while the Mac is connected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';

// by a path in a variable, so the node typecheck does not take in the app's DOM types
const stepsPath = '../mobile/src/components/AddComputerSteps';
const linkPath = '../mobile/src/macLink';
const { AddComputerSteps } = await import(stepsPath);
const { MacLinkProvider } = await import(linkPath);

const local = { id: 'local', name: 'Studio Mac', status: 'online', line: 'This Mac', tone: 'ok', agents: [] };
const box = (id: string, name: string) => ({ id, name, status: 'online', line: 'Online', tone: 'ok', agents: [] });
const ONLINE = {
  phase: 'online',
  generation: 1,
  selectedPair: 'p',
  pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
  presence: {},
  user: { id: 'u', email: 'du@example.com' },
};

function mount(props: Record<string, unknown>, list: unknown[] = [local], state: any = ONLINE) {
  const listeners = new Set<(m: any) => void>();
  const runtime: any = {
    request: async (method: string) => (method === 'machine.hello' ? { capabilities: { machines: true } } : { machines: list }),
    onEvent: (f: (m: any) => void) => (listeners.add(f), () => listeners.delete(f)),
  };
  const calls = { look: 0, done: 0 };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (s: any) =>
    act(async () =>
      root.render(
        createElement(
          MacLinkProvider,
          { state: s, runtime },
          createElement(AddComputerSteps, {
            host: false,
            lookForMac: () => calls.look++,
            done: () => calls.done++,
            ...props,
          }),
        ),
      ),
    );
  const push = (machines: unknown[]) => act(async () => listeners.forEach((f) => f({ ev: 'machines.changed', machines })));
  const button = (name: string) => host.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement | null;
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, render, push, button, calls, unmount, state };
}

test('the Mac steps name the account, no Host tab without Host access, and the button opens the camera', async () => {
  const v = mount({ account: 'du@example.com' });
  await v.render(ONLINE);
  await flush();
  assert.match(v.host.textContent!, /Add a computer/);
  assert.match(v.host.textContent!, /Do this at the computer you want to add\./);
  assert.match(v.host.textContent!, /1Open MoPilot on your Mac, signed in as du@example\.com\./);
  assert.match(v.host.textContent!, /3Scan the code it shows\./);
  assert.equal(v.host.querySelector('[role=tablist]'), null, 'no Mac | Host switch');
  await click('Look for my computer');
  assert.equal(v.calls.look, 1);
  await v.unmount();
  const anon = mount({});
  await anon.render(ONLINE);
  assert.match(anon.host.textContent!, /signed in with this account\./);
  await anon.unmount();
});

test('the Host tab waits for a pushed machine that was not there at the tap, then says it is ready', async () => {
  const v = mount({ host: true }, [local, box('h1', 'Old box')]);
  await v.render(ONLINE);
  await flush();
  assert.ok(v.button('Mac'));
  const steps = v.host.querySelector('[data-entering="FadeIn"]')!;
  await click('Host, a machine your Mac runs chats on');
  assert.match(v.host.textContent!, /Click Add a machine, and follow the steps there\./);
  assert.notEqual(
    v.host.querySelector('[data-skip-entering="true"] [data-entering="FadeIn"]'),
    steps,
    'the other tab’s steps are a new view that fades in',
  );
  await click('Look for my machine');
  assert.equal(v.button('Look for my machine')?.disabled, true, 'one wait at a time');
  assert.match(v.host.textContent!, /Waiting for you to allow it on your Mac…/);
  await v.push([local, box('h1', 'Old box')]);
  assert.match(v.host.textContent!, /Waiting for you/, 'a machine it already listed is not the new one');
  await v.push([local, box('h1', 'Old box'), box('h2', 'Build box')]);
  assert.match(v.host.textContent!, /Build box is ready\./);
  await click('Done');
  assert.equal(v.calls.done, 1);
  await click('Mac');
  assert.doesNotMatch(v.host.textContent!, /is ready|Waiting for you/, 'the Mac tab has its own steps only');
  assert.ok(v.button('Look for my computer'));
  await v.unmount();
});

test("the first Host is found too: a Mac that lists only itself counts as none, and the wait can't start while it is away", async () => {
  const v = mount({ host: true }, [local]);
  await v.render({ ...ONLINE, phase: 'offline' });
  await flush();
  await click('Host, a machine your Mac runs chats on');
  assert.equal(v.button('Look for my machine')?.disabled, true, 'away from the Mac, a reconnect would make old machines read as new');
  await v.render(ONLINE);
  await flush();
  assert.equal(v.button('Look for my machine')?.disabled, false);
  await click('Look for my machine');
  await v.push([local, box('h1', 'First box')]);
  assert.match(v.host.textContent!, /First box is ready\./);
  await v.unmount();
});
