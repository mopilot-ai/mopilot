// A machine paired by code whose Host removed this Mac (#5747) in Settings › My machines: the row says so with a warning dot and offers Remove right there, the same Remove sheet as the ⋯ menu's; a machine not removed offers no such button.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  responses,
  calls,
  useStore,
  defaultState,
  render,
  click,
  button,
  text,
  flush,
} from './support/settings-harness.ts';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { HostMachines } = await import('../src/components/pages/settings/HostMachines.tsx');

const NOTE = 'Studio removed this Mac. Remove it here, then pair again with a new code if you need it.';
const STUDIO = {
  id: 'relay:h_studio',
  name: 'Studio',
  status: 'attention',
  note: NOTE,
  peerRemoved: true,
  signin: null,
  capabilities: { iab: false, cu: false },
  agents: [],
};

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [STUDIO], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onSignin': () => () => undefined,
    'host.removePlan': () =>
      Promise.resolve({ ssh: false, reachable: false, online: false, busy: 'no', daemon: false, unsure: false, shared: '', why: '' }),
  });
  calls.length = 0;
});

test('the row names the machine that removed this Mac, and its Remove opens the Remove sheet', async (t) => {
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  assert.equal(text(root.host.querySelector('.machine-status')), NOTE);
  assert.equal(root.host.querySelector('.machine-dot')?.className, 'machine-dot warn');
  const remove = button(root.host, 'Remove Studio');
  assert.equal(remove.textContent, 'Remove');
  assert.equal(root.host.querySelector('.dialog'), null);
  await click(remove);
  await flush(3);
  assert.ok(root.host.querySelector('.dialog'), 'the Remove sheet opens');
});

test('a machine its Host did not remove has no Remove button in the row', async (t) => {
  responses['host.machines'] = () =>
    Promise.resolve({ machines: [{ ...STUDIO, status: 'online', note: 'Via relay', peerRemoved: undefined }], resolved: true });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  assert.throws(() => button(root.host, 'Remove Studio'));
});
