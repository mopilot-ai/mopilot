// A chat that runs on a machine says so in its header, and when the phone has no controls for it says that in the machine's name (#4859): the laptop button names the machine, and the menu's greyed entries are not asked to "update your Mac".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';

const clientPath = '../mobile/src/remote/client';
const linkPath = '../mobile/src/macLink';
const headerPath = '../mobile/src/components/ChatHeader';
const hookPath = '../mobile/src/remote/useChatControls';
const { ownedRequest } = await import(clientPath);
const { MacLinkProvider } = await import(linkPath);
const { ChatHeader: Bare } = await import(headerPath);
const { useChatControls } = await import(hookPath);

const state = { phase: 'online', selectedPair: 'p', pairs: [{ pairId: 'p', name: 'Studio Mac' }], presence: {} };
const MACHINES = [
  { id: 'local', name: 'Studio Mac', line: 'Online', status: 'online' },
  { id: 'h1', name: 'mopilot-bench', line: 'Online', status: 'online' },
];
const WORDS = 'This is not offered for chats on mopilot-bench from the phone yet.';

/** The header as a chat of a machine draws it: its controls read by the shared hook from a Mac that refuses them for the machine's own chat. */
const Header = (props: any) => {
  const s = useChatControls(props.request, props.chatId);
  return createElement(Bare, { ...props, controls: s.controls, reload: s.reload, unsupported: s.unsupported });
};

async function mount(props: object, refuse: boolean) {
  const rig = scripted((m) => {
    if (m === 'machine.hello') return { capabilities: { methods: ['machines.list', 'options.get'], machines: true } };
    if (m === 'machines.list') return { machines: MACHINES };
    if (m === 'options.get' && refuse) throw Object.assign(new Error(WORDS), { code: 'unsupported' });
    return undefined;
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        MacLinkProvider,
        { state, runtime: rig.runtime },
        createElement(Header, { request: ownedRequest(rig.runtime), chatId: 'c', title: 'T', back: () => {}, ...props }),
      ),
    ),
  );
  await flush();
  await flush();
  return { host, done: () => act(async () => root.unmount()) };
}

test('the laptop names the machine a chat runs on; for a machine not listed it keeps naming the Mac’s link', async () => {
  const on = await mount({ hostId: 'h1' }, true);
  assert.ok(on.host.querySelector('button[aria-label="Runs on mopilot-bench"]'));
  await on.done();
  const unknown = await mount({ hostId: 'h9' }, true);
  assert.ok(unknown.host.querySelector('button[aria-label="Studio Mac, Connected"]'));
  await unknown.done();
  const mac = await mount({}, true);
  assert.ok(mac.host.querySelector('button[aria-label="Runs on Studio Mac, Connected"]'));
  await mac.done();
});

test('the greyed entries of a machine’s chat say why in the machine’s name, not that the Mac needs an update', async () => {
  const v = await mount({ hostId: 'h1' }, true);
  await act(async () => (v.host.querySelector('button[aria-label="Chat menu"]') as HTMLElement).click());
  assert.ok(v.host.querySelector(`[data-section="${WORDS}"]`), 'the section is titled with the refusal');
  assert.equal(v.host.querySelector('[data-section="Update MoPilot on your Mac"]'), null);
  await v.done();
  // an ordinary refusal (a Mac too old to list the controls) still says to update
  const old = await mount({}, false);
  await act(async () => (old.host.querySelector('button[aria-label="Chat menu"]') as HTMLElement).click());
  assert.ok(old.host.querySelector('[data-section="Update MoPilot on your Mac"]'));
  await old.done();
});
