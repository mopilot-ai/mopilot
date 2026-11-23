// After an add finishes paired (or a pairing code is accepted) the Add a machine sheet opens that machine's folder picker itself; a folder picked there sets the next new chat's machine and folder, closes the sheet and goes home, and closing the picker keeps the sheet.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  responses,
  calls,
  useStore,
  defaultState,
  click,
  button,
  text,
  setValue,
  flush,
} from './support/settings-harness.ts';

await setup();
const { renderMachines } = await import('./support/addMachineView.ts');

const LISTING = {
  value: {
    path: '/home/me',
    roots: ['/home/me'],
    entries: [
      { name: 'app', path: '/home/me/app', git: true },
      { name: 'docs', path: '/home/me/docs', git: false },
    ],
  },
};
let add: () => Promise<unknown>;
beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  add = () =>
    Promise.resolve({
      ok: true,
      paired: true,
      error: '',
      id: 'ssh:me@box',
      steps: [],
    });
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onPrompt': () => () => undefined,
    'host.onSignin': () => () => undefined,
    'host.discover': () => new Promise(() => undefined),
    'host.add': () => add(),
    'host.pair': () => Promise.resolve(),
    'host.fsList': (_id: string, q: { path?: string }) =>
      Promise.resolve(q.path === '/home/me/app' ? { value: { path: '/home/me/app', roots: ['/home/me'], entries: [] } } : LISTING),
  });
  calls.length = 0;
});
const field = (root: Element) => root.querySelector('input[aria-label="Machine"]') as HTMLInputElement;
/** What the sheet did to the next new chat's machine and folder. */
const picked = () => calls.filter((c) => c[0] === 'pickNewChatHost' || c[0] === 'setNewChatHostFolder');
const picker = (root: Element) => root.querySelector('.host-picker');
const listed = () => calls.filter((c) => c[0] === 'host.fsList');
const added = async (root: Element) => {
  await click(button(root, 'Add machine'));
  await setValue(field(root), 'me@box');
  await click(button(root, 'Add'));
  await flush();
};

test('a paired add opens the machine’s folder picker by itself; the folder picked sets the new chat’s machine and folder, closes the sheet and goes home', async (t) => {
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  assert.equal(picker(view.host), null);
  await added(view.host);
  assert.ok(picker(view.host), 'the picker is open');
  assert.match(text(view.host), /Folder on me@box/);
  assert.deepEqual(listed()[0], ['host.fsList', 'ssh:me@box', { path: undefined }]);
  assert.deepEqual(useStore.getState().prefs.sshHosts, ['me@box']);
  await click(picker(view.host)!.querySelector('.host-picker-open')!);
  await flush();
  await click(button(view.host, 'Use this folder'));
  assert.deepEqual(picked(), [
    ['pickNewChatHost', { id: 'ssh:me@box', name: 'me@box' }],
    ['setNewChatHostFolder', { id: 'ssh:me@box', name: 'me@box' }, '/home/me/app'],
  ]);
  assert.deepEqual(calls.filter((c) => c[0] === 'navigate').at(-1), ['navigate', { name: 'home' }]);
  assert.equal(view.host.querySelector('.add-machine-sheet'), null, 'the sheet is closed');
  assert.equal(picker(view.host), null);
});

test('a machine picked from the list shows its own name on the picker and the chat', async (t) => {
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  responses['host.discover'] = () =>
    Promise.resolve([
      {
        source: 'config',
        name: 'Build box',
        destination: 'box',
        detail: 'me@1.2.3.4',
        address: '1.2.3.4',
        alias: '',
        added: false,
      },
    ]);
  await click(button(view.host, 'Add machine'));
  await flush();
  await click(view.host.querySelector('[role=option]')!);
  await flush();
  assert.match(text(view.host), /Folder on Build box/);
  await click(button(view.host, 'Use this folder'));
  assert.deepEqual(picked(), [
    ['pickNewChatHost', { id: 'ssh:me@box', name: 'Build box' }],
    ['setNewChatHostFolder', { id: 'ssh:me@box', name: 'Build box' }, '/home/me'],
  ]);
});

test('a machine that did not pair takes the code, and the picker opens when the code is accepted, not before', async (t) => {
  add = () =>
    Promise.resolve({
      ok: true,
      paired: false,
      error: '',
      id: 'ssh:me@box',
      steps: [],
    });
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await added(view.host);
  assert.equal(picker(view.host), null, 'not paired yet: no picker');
  assert.equal(listed().length, 0);
  await setValue(view.host.querySelector('input[aria-label="Pairing code"]')!, 'ABCD-EFGH-JKMN');
  await click(button(view.host, 'Pair'));
  await flush();
  assert.ok(picker(view.host));
  await click(button(view.host, 'Use this folder'));
  assert.deepEqual(picked(), [
    ['pickNewChatHost', { id: 'ssh:me@box', name: 'me@box' }],
    ['setNewChatHostFolder', { id: 'ssh:me@box', name: 'me@box' }, '/home/me'],
  ]);
  assert.deepEqual(calls.filter((c) => c[0] === 'navigate').at(-1), ['navigate', { name: 'home' }]);
});

test('closing the picker keeps the sheet and the machine; a failed add opens no picker', async (t) => {
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await added(view.host);
  assert.ok(picker(view.host));
  await click(button(view.host.querySelector('.host-picker')!.closest('.dialog')!, 'Close'));
  assert.equal(picker(view.host), null);
  assert.ok(view.host.querySelector('.add-machine-sheet'), 'the sheet stays');
  assert.deepEqual(picked(), [], 'nothing was picked');
  assert.equal(calls.filter((c) => c[0] === 'navigate').length, 0, 'the page stays');
  assert.match(text(view.host), /me@box is ready/);
  add = () =>
    Promise.resolve({
      ok: false,
      paired: false,
      error: 'Node 22 or newer is needed',
      id: '',
      steps: [],
    });
  const asked = listed().length;
  await click(button(view.host, 'Add'));
  await flush();
  assert.equal(picker(view.host), null);
  assert.equal(listed().length, asked, 'no listing for a machine that failed');
});
