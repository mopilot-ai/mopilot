// The Add a machine sheet (AddMachineSheet.tsx, AddMachinePicker.tsx), opened from Settings › Machines: no tabs, one field with this network, Tailscale and the ssh config listed under it, filtered by what is typed; nothing is looked for until the sheet opens; one already added says Added and cannot be picked; a Mac with Remote Login off said so; picking one starts adding it under its own name; Any network is a link, and leaving it ends its command; a question ssh asks while the sheet is closed opens it again.
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
  text,
  setValue,
  button,
  flush,
  act,
} from './support/settings-harness.ts';

await setup();
const { renderMachines } = await import('./support/addMachineView.ts');

const FOUND = [
  {
    source: 'network',
    name: 'Du’s Mac mini',
    destination: 'mac-mini-test',
    detail: 'Dus-Mac-mini.local · mac-mini-test in SSH config',
    address: '192.168.86.151',
    alias: 'mac-mini-test',
    added: false,
  },
  {
    source: 'network',
    name: 'Studio',
    destination: 'studio.local',
    detail: 'studio.local',
    address: '10.0.0.9',
    alias: '',
    added: true,
  },
  {
    source: 'tailscale',
    name: 'gpu-box',
    destination: 'gpu-box.tail.ts.net',
    detail: 'gpu-box.tail.ts.net',
    address: '100.64.0.5',
    alias: '',
    added: false,
  },
  {
    source: 'config',
    name: 'oci',
    destination: 'oci',
    detail: 'ubuntu@1.2.3.4',
    address: '1.2.3.4',
    alias: '',
    added: false,
  },
  {
    source: 'config',
    name: 'lab',
    destination: 'lab',
    detail: 'me@10.0.0.2',
    address: '10.0.0.2',
    alias: '',
    added: false,
  },
  {
    source: 'network',
    name: 'Studio iMac',
    destination: 'studio-imac.local',
    detail: 'Remote Login is off',
    address: '',
    alias: '',
    added: false,
    remoteLoginOff: true,
  },
];
let pushPrompt: (e: unknown) => void = () => undefined;
let finish: (rows: unknown) => void = () => undefined;
let fail = false;
beforeEach(() => {
  resetCtl();
  fail = false;
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onSignin': () => () => undefined,
    'host.onPrompt': (cb: any) => ((pushPrompt = cb), () => undefined),
    'host.onBoot': () => () => undefined,
    'host.bootStart': () => new Promise(() => undefined),
    'host.bootDeny': () => Promise.resolve(),
    'host.discover': () => (fail ? Promise.reject(new Error('dns-sd')) : new Promise((r) => (finish = r))),
    'host.add': () => new Promise(() => undefined),
  });
  calls.length = 0;
});
const field = (root: Element) => root.querySelector('input[aria-label="Machine"]') as HTMLInputElement;
const discovered = () => calls.filter((c) => c[0] === 'host.discover').length;
const option = (root: Element, name: string) =>
  [...root.querySelectorAll('[role=option]')].find(
    (b) => b.querySelector('.add-machine-picker-name')?.textContent === name,
  ) as HTMLButtonElement;

const names = (root: Element) => [...root.querySelectorAll('.add-machine-picker-name')].map((e) => e.textContent);
const link = (root: Element, label: string) => click(button(root.querySelector('.machine-sheet-links')!, label));

test('nothing is looked for until the sheet opens; one field, no tabs, and this network, Tailscale and the ssh config grouped under it, Added cannot be picked, Remote Login off is said', async (t) => {
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  assert.equal(discovered(), 0, 'no Bonjour or Tailscale before the sheet opens');
  await click(button(view.host, 'Add machine'));
  assert.equal(discovered(), 1);
  assert.equal(view.host.querySelectorAll('[role=tab], [role=tablist], .machine-tabs').length, 0, 'no tabs');
  assert.equal(field(view.host).placeholder, 'user@host, host:port or a name from your SSH config');
  assert.match(text(view.host.querySelector('[role=listbox]')), /Looking for machines…/);
  await act(() => finish(FOUND));
  const list = view.host.querySelector('[role=listbox]') as HTMLElement;
  assert.deepEqual(
    [...list.querySelectorAll('.add-machine-picker-title')].map((e) => e.textContent),
    ['On your network', 'Tailscale', 'SSH config'],
  );
  assert.deepEqual(names(view.host), ['Du’s Mac mini', 'Studio', 'Studio iMac', 'gpu-box', 'oci', 'lab']);
  assert.equal(option(view.host, 'Studio').disabled, true);
  assert.match(text(option(view.host, 'Studio')), /Added$/);
  assert.match(text(option(view.host, 'Du’s Mac mini')), /Dus-Mac-mini\.local · mac-mini-test in SSH configAdd$/);
  assert.ok(option(view.host, 'Studio iMac').querySelector('.machine-dot.warn'));
  assert.match(text(option(view.host, 'Studio iMac')), /Remote Login is off/);
});

test('the links under the list: Any network (add by command) always, New cloud machine… only when the sheet is given a way to it', async (t) => {
  const { AddMachineSheet } = await import('../src/components/pages/settings/AddMachineSheet.tsx');
  const { createElement: h } = await import('react');
  const props = {
    open: true,
    onOpen: () => undefined,
    onClose: () => undefined,
  };
  const plain = await render(h(AddMachineSheet, props));
  t.after(() => plain.unmount());
  assert.deepEqual(
    [...plain.host.querySelectorAll('.machine-sheet-links button')].map((b) => text(b)),
    ['Any network (add by command)'],
  );
  let cloud = 0;
  const withCloud = await render(h(AddMachineSheet, { ...props, onCloud: () => void (cloud += 1) }));
  t.after(() => withCloud.unmount());
  assert.deepEqual(
    [...withCloud.host.querySelectorAll('.machine-sheet-links button')].map((b) => text(b)),
    ['Any network (add by command)', 'New cloud machine…'],
  );
  await click(button(withCloud.host, 'New cloud machine…'));
  assert.equal(cloud, 1);
});

test('typing filters all three sources; ssh:// is accepted; picking one adds it through its alias under its own name', async (t) => {
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await click(button(view.host, 'Add machine'));
  await act(() => finish(FOUND));
  await setValue(field(view.host), '10.0');
  assert.deepEqual(names(view.host), ['lab']);
  await setValue(field(view.host), 'tail.ts');
  assert.deepEqual(names(view.host), ['gpu-box']);
  await setValue(field(view.host), 'nothing-like-it');
  assert.equal(view.host.querySelectorAll('[role=option]').length, 0);
  assert.doesNotMatch(text(view.host), /No machines found/, 'a filter that matches nothing says nothing');
  await setValue(field(view.host), '');
  // pressing on a row keeps the field focused (the list stays while the press lasts)
  const press = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
  });
  option(view.host, 'oci').dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);
  await click(option(view.host, 'oci'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.add'),
    [['host.add', 'oci']],
  );
  assert.match(text(view.host.querySelector('.host-install-line')), /^Setting up oci…/);
  assert.equal(view.host.querySelector('[role=listbox]'), null, 'the list goes while it installs');
  assert.equal(field(view.host).value, 'oci');
  assert.equal(button(view.host, 'Adding…').disabled, true);
});

test('an ssh:// address is a machine too', async (t) => {
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await click(button(view.host, 'Add machine'));
  await setValue(field(view.host), 'ssh://me@box:2222');
  await click(button(view.host, 'Add'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.add'),
    [['host.add', 'ssh://me@box:2222']],
  );
  assert.equal(calls.filter((c) => c[0] === 'toast').length, 0);
});

test('nothing found leaves only the field and the links; Any network switches to its command, whose Use SSH comes back', async (t) => {
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await click(button(view.host, 'Add machine'));
  await act(() => finish([]));
  assert.equal(view.host.querySelector('[role=listbox]')?.textContent, '', 'the field is the way in');
  assert.ok(field(view.host));
  // a build with no relay offers Use SSH on the card: the way back to the field
  responses['host.bootStart'] = () => Promise.reject(new Error('This app has no relay to add a machine by command.'));
  await link(view.host, 'Any network (add by command)');
  await flush();
  assert.match(text(view.host), /Run one command on the other machine\./);
  assert.equal(field(view.host), null, 'the field is replaced by the command');
  assert.deepEqual(
    [...view.host.querySelectorAll('.machine-sheet-links button')].map((b) => text(b)),
    ['Back'],
  );
  await click(button(view.host, 'Use SSH'));
  assert.ok(field(view.host));
  assert.equal(calls.filter((c) => c[0] === 'host.bootDeny').length, 1, 'going back ends the command');
  // Back from the command is the same way home
  await link(view.host, 'Any network (add by command)');
  await flush();
  await click(button(view.host.querySelector('.machine-sheet-links')!, 'Back'));
  assert.ok(field(view.host));
  assert.equal(calls.filter((c) => c[0] === 'host.bootDeny').length, 2, 'Back ends the command too');
});

test('discovery that fails, or finds nothing, says nothing and leaves the field', async (t) => {
  fail = true;
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await click(button(view.host, 'Add machine'));
  await flush();
  const list = view.host.querySelector('[role=listbox]') as HTMLElement;
  assert.equal(list.querySelectorAll('[role=option]').length, 0);
  assert.equal(text(list), '');
  assert.ok(field(view.host));
  // closed before an answer: the late answer changes nothing
  fail = false;
  await click(button(view.host, 'Close'));
  assert.equal(view.host.querySelector('[role=listbox]'), null);
  await act(() => finish(FOUND));
  assert.equal(view.host.querySelector('[role=listbox]'), null);
});

test('leaving Any network ends its command; closing from the list ends none', async (t) => {
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await click(button(view.host, 'Add machine'));
  await click(button(view.host, 'Close'));
  assert.equal(calls.filter((c) => c[0] === 'host.bootDeny').length, 0);
  await click(button(view.host, 'Add machine'));
  responses['host.bootStart'] = () => Promise.reject(new Error('This app has no relay to add a machine by command.'));
  await link(view.host, 'Any network (add by command)');
  assert.match(text(view.host), /Run one command on the other machine\./);
  await flush();
  await click(button(view.host, 'Use SSH'));
  assert.equal(calls.filter((c) => c[0] === 'host.bootDeny').length, 1);
  responses['host.bootStart'] = () => new Promise(() => undefined);
  await link(view.host, 'Any network (add by command)');
  await click(button(view.host, 'Close'));
  assert.equal(calls.filter((c) => c[0] === 'host.bootDeny').length, 2);
  // a refusal to end it is not this sheet's to say (the command runs out on its own)
  responses['host.bootDeny'] = () => Promise.reject(new Error('relay down'));
  await click(button(view.host, 'Add machine'));
  assert.ok(field(view.host), 'the sheet reopens on the field, not inside the command it was closed on');
  await click(button(view.host, 'Close'));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'toast').length, 0);
});

test('a question ssh asks while the sheet is closed opens it again', async (t) => {
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await click(button(view.host, 'Add machine'));
  await setValue(field(view.host), 'me@box');
  await click(button(view.host, 'Add'));
  await click(button(view.host, 'Close'));
  assert.equal(view.host.querySelector('.dialog'), null);
  await act(() =>
    pushPrompt({
      id: 'p1',
      destination: 'me@box',
      prompt: {
        kind: 'password',
        destination: 'me@box',
        account: 'me',
        text: 'Password:',
      },
    }),
  );
  assert.ok(view.host.querySelector('.dialog'));
  assert.match(text(view.host.querySelector('.dialog')), /Password/);
});

test('an add under way stays in view on Any network, so a question ssh asks there is answered', async (t) => {
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await click(button(view.host, 'Add machine'));
  await setValue(field(view.host), 'me@box');
  await click(button(view.host, 'Add'));
  await link(view.host, 'Any network (add by command)');
  assert.match(text(view.host.querySelector('.dialog')), /Setting up me@box…/);
  await act(() =>
    pushPrompt({
      id: 'p2',
      destination: 'me@box',
      prompt: {
        kind: 'password',
        destination: 'me@box',
        account: 'me',
        text: 'Password:',
      },
    }),
  );
  assert.match(text(view.host.querySelector('.dialog')), /Password/);
});

test('Start a chat on it: from Settings the machine becomes the next chat’s and the app goes home; opened in place, the opener takes it', async (t) => {
  const { AddMachineSheet } = await import('../src/components/pages/settings/AddMachineSheet.tsx');
  const { createElement: h } = await import('react');
  responses['host.add'] = () => Promise.resolve({ ok: true, paired: true, id: 'ssh:me@box', steps: [], error: '' });
  const added = async (props: object) => {
    const view = await render(h(AddMachineSheet, { open: true, onOpen: () => undefined, onClose: () => undefined, ...props }));
    t.after(() => view.unmount());
    await setValue(field(view.host), 'me@box');
    await click(button(view.host, 'Add'));
    await flush();
    await click(button(view.host, 'Start a chat on it'));
    return view;
  };
  const picked = () => calls.filter((c) => c[0] === 'pickNewChatHost' || c[0] === 'navigate');
  await added({});
  assert.deepEqual(picked(), [
    ['pickNewChatHost', { id: 'ssh:me@box', name: 'me@box' }],
    ['navigate', { name: 'home' }],
  ]);
  calls.length = 0;
  const took: unknown[] = [];
  await added({ onStartChat: (m: unknown) => took.push(m) });
  assert.deepEqual(took, [{ id: 'ssh:me@box', name: 'me@box' }]);
  assert.deepEqual(picked(), [], 'the opener decides what the pick is and where the app goes');
});
