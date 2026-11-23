// The one Add a machine sheet of the app (AddMachineDialog.tsx): nothing without Host access, open and closed by the store, kept mounted while closed, and New cloud machine… hands over to the cloud sheet only with the cloud flag on.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  responses,
  calls,
  ctl,
  useStore,
  defaultState,
  render,
  click,
  button,
  text,
  flush,
  act,
} from './support/settings-harness.ts';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { AddMachineDialog } = await import('../src/components/pages/settings/AddMachineDialog.tsx');
const { openAddMachine, closeAddMachine } = await import('../src/lib/addMachine.ts');

let pushAccess: (v: unknown) => void = () => undefined;
beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'home' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': (cb: any) => ((pushAccess = cb), () => undefined),
    'host.machines': () => Promise.resolve({ machines: [], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onPrompt': () => () => undefined,
    'host.onSignin': () => () => undefined,
    'host.onBoot': () => () => undefined,
    'host.discover': () => new Promise(() => undefined),
    'host.cloudProviders': () =>
      Promise.resolve([
        {
          id: 'oci',
          label: 'Oracle Cloud',
          fields: ['tenancy'],
          hasKey: false,
        },
      ]),
    'host.cloudOptions': () =>
      Promise.resolve({
        flags: { limitedNetwork: false },
        reasons: {},
        sizes: [],
        regions: [],
      }),
    'host.onCloud': () => () => undefined,
  });
  calls.length = 0;
});
const mount = async (t: any) => {
  const view = await render(h(AddMachineDialog));
  t.after(async () => {
    await act(() => closeAddMachine());
    await view.unmount();
  });
  await flush();
  await act(() => pushAccess(true));
  return view;
};
const sheet = (root: Element) => root.querySelector('.add-machine-sheet');

test('the sheet is shut until the store opens it, and shuts again with it; discovery waits for the opening', async (t) => {
  const view = await mount(t);
  assert.equal(sheet(view.host), null);
  assert.equal(calls.filter((c) => c[0] === 'host.discover').length, 0);
  await act(() => openAddMachine());
  assert.ok(sheet(view.host));
  assert.equal(calls.filter((c) => c[0] === 'host.discover').length, 1);
  await click(button(view.host, 'Close'));
  assert.equal(sheet(view.host), null, 'Close goes through the store');
  await act(() => openAddMachine());
  assert.ok(sheet(view.host));
  await act(() => closeAddMachine());
  assert.equal(sheet(view.host), null);
});

test('without Host access nothing shows, even when asked to open; it shows once access arrives', async (t) => {
  const view = await mount(t);
  await act(() => pushAccess(false));
  await act(() => openAddMachine());
  assert.equal(view.host.textContent, '');
  assert.equal(calls.filter((c) => c[0] === 'host.discover').length, 0, 'nothing is looked for');
  await act(() => pushAccess(true));
  assert.ok(sheet(view.host), 'the open request was kept');
  await act(() => pushAccess(false));
  assert.equal(view.host.textContent, '');
});

test('with the cloud flag off the sheet has no New cloud machine… link', async (t) => {
  ctl.flags['host.cloud'] = false;
  const view = await mount(t);
  await act(() => openAddMachine());
  assert.deepEqual(
    [...view.host.querySelectorAll('.machine-sheet-links button')].map((b) => text(b)),
    ['Any network (add by command)'],
  );
});

test('with the cloud flag on, New cloud machine… closes the Add sheet and opens the cloud sheet; cancelling it leaves nothing open', async (t) => {
  ctl.flags['host.cloud'] = true;
  const view = await mount(t);
  await act(() => openAddMachine());
  assert.ok(button(view.host, 'New cloud machine…'));
  await click(button(view.host, 'New cloud machine…'));
  await flush();
  assert.equal(sheet(view.host), null, 'the Add sheet is closed in the store');
  const dialog = view.host.querySelector('.dialog');
  assert.ok(dialog, 'the cloud sheet is open');
  assert.match(text(dialog), /Cloud|cloud/);
  await click(button(dialog!, 'Cancel'));
  assert.equal(view.host.querySelector('.dialog'), null);
  assert.equal(sheet(view.host), null);
});
