// Remove on a machine added by command (RemoveSheet.tsx, Remote Run one-click fix 6): such a machine has only the relay to this Mac, so Remove forgets it here and leaves its Host installed; the sheet says so plainly, shows the line to run on the machine to delete the Host and its files (the Host's own `uninstall --purge`, the same paths the install put there), says when Keep running would start it again at boot, and the toast afterwards says the Host is still installed. A machine added over SSH keeps its own copy.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
const require = createRequire(import.meta.url);
const { createElement: h } = await import('react');
const { RemoveSheet, removeLede, removedNote, addedByCommand } = await import('../src/components/pages/settings/RemoveSheet.tsx');
const { HOST_UNINSTALL_LINE } = await import('../shared/host/hostUninstallLine.mjs');
const { HOST_NODE } = require('../electron/host/installRuntime.cjs');
const { BUNDLE_BIN } = require('../electron/host/install.cjs');

const RELAY = { id: 'relay:h_1', name: 'far-box' } as any;
const SSH = { id: 'ssh:me@box', name: 'box' } as any;
const plan = (o: object = {}) => ({
  ssh: false,
  reachable: true,
  online: true,
  busy: 'unknown' as const,
  daemon: false,
  unsure: false,
  shared: '',
  why: '' as const,
  ...o,
});

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState() }, true);
  Object.assign(responses, {
    'host.removePlan': () => Promise.resolve(plan()),
    'host.remove': () => Promise.resolve(),
    'host.uninstall': () => Promise.resolve({ left: '' }),
    'clipboard.write': () => Promise.resolve(),
  });
  calls.length = 0;
});

test('the shown line is the Host’s own uninstall with the Node and bundle the install puts there', () => {
  assert.equal(HOST_UNINSTALL_LINE, `"${HOST_NODE}" "${BUNDLE_BIN}" uninstall --purge`);
  assert.equal(addedByCommand('relay:h_1'), true);
  assert.equal(addedByCommand('ssh:me@box'), false);
});

test('the copy: a machine added by command is forgotten here and its Host stays; Keep running is named; others keep theirs', () => {
  assert.deepEqual(removeLede(plan(), 'far-box', true), [
    'Removes far-box from this Mac. The Host stays installed on it.',
    'To delete the Host and its files, run this on far-box:',
  ]);
  assert.deepEqual(removeLede(plan({ daemon: true }), 'far-box', true), [
    'Removes far-box from this Mac. The Host stays installed on it.',
    'Keep running is on there, so the Host keeps starting at boot. Turn it off first to be able to delete it.',
    'To delete the Host and its files, run this on far-box:',
  ]);
  assert.equal(removedNote('far-box', false, '', true), 'far-box removed here. Its Host is still installed there.');
  assert.match(removeLede(plan({ ssh: true, reachable: false, online: false }), 'box')[1], /add the machine again and choose Remove/);
  assert.equal(removedNote('box', true, ''), 'box removed');
  // a stopped Host with ssh up reads as a running one, minus the turn warning
  assert.deepEqual(removeLede(plan({ ssh: true, online: false, busy: 'no' }), 'box'), ['Stops the Host on box and deletes its files.']);
  assert.deepEqual(removeLede(plan({ ssh: true, shared: 'box 2', why: 'same' }), 'box'), [
    'box 2 uses the same Host. box is only removed here; the Host and its files stay.',
  ]);
  assert.deepEqual(removeLede(plan({ ssh: true, shared: 'box 2', why: 'unknown' }), 'box'), [
    "box's Host and files stay: it can't be told apart from box 2. It's only removed here.",
  ]);
  // a machine that does not answer keeps today's copy whatever else is true of it
  assert.match(removeLede(plan({ ssh: true, reachable: false, shared: 'x', why: 'unknown', unsure: true }), 'box')[0], /files stay on box/);
  assert.match(removeLede(plan({ ssh: true, unsure: true }), 'box')[0], /Can't tell whether Keep running is on at box/);
  assert.equal(removedNote('box', true, 'unsure'), 'box removed here. Its Host may still run there.');
  assert.equal(
    removedNote('box', true, 'shared', false, { shared: 'box 2', why: 'same' }),
    'box removed here. Its Host and files stay: box 2 uses the same Host.',
  );
  assert.equal(
    removedNote('box', true, 'shared', false, { shared: 'box 2', why: 'unknown' }),
    "box removed here. Its Host and files stay: it can't be told apart from box 2.",
  );
});

test('the sheet for a machine added by command offers no uninstall, shows the line with Copy, and Remove only forgets it', async (t) => {
  const closed: number[] = [];
  const view = await render(h(RemoveSheet, { machine: RELAY, onClose: () => closed.push(1) }));
  t.after(() => view.unmount());
  await flush();
  const body = text(document.body);
  assert.match(body, /Removes far-box from this Mac\. The Host stays installed on it\./);
  assert.match(body, /To delete the Host and its files, run this on far-box:/);
  assert.ok(body.includes(HOST_UNINSTALL_LINE));
  assert.doesNotMatch(body, /Administrator password|add the machine again/);
  await click(button(document.body, 'Copy'));
  assert.deepEqual(calls.find((c) => c[0] === 'clipboard.write')?.slice(1), [HOST_UNINSTALL_LINE]);
  assert.deepEqual(
    calls
      .filter((c) => c[0] === 'toast')
      .at(-1)
      ?.slice(1),
    ['Copied'],
  );
  responses['clipboard.write'] = () => Promise.reject(new Error('denied'));
  await click(button(document.body, 'Copy'));
  await flush();
  assert.deepEqual(
    calls
      .filter((c) => c[0] === 'toast')
      .at(-1)
      ?.slice(1),
    ["Couldn't copy: denied", 'error'],
  );
  await click(button(document.body, 'Remove'));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.uninstall').length, 0, 'the app cannot uninstall over the relay');
  assert.deepEqual(calls.find((c) => c[0] === 'host.remove')?.slice(1), ['relay:h_1']);
  assert.deepEqual(
    calls
      .filter((c) => c[0] === 'toast')
      .at(-1)
      ?.slice(1),
    ['far-box removed here. Its Host is still installed there.'],
  );
  assert.equal(closed.length, 1);
});

test('a machine added over SSH keeps its sheet; one whose plan cannot be made says the Host stays, with no command', async (t) => {
  responses['host.removePlan'] = () => Promise.resolve(plan({ ssh: true }));
  const first = await render(h(RemoveSheet, { machine: SSH, onClose: () => undefined }));
  await flush();
  assert.match(text(document.body), /Stops the Host on box and deletes its files\./);
  assert.doesNotMatch(text(document.body), /run this on/);
  await first.unmount();
  responses['host.removePlan'] = () => Promise.reject(new Error('no'));
  const second = await render(h(RemoveSheet, { machine: SSH, onClose: () => undefined }));
  t.after(() => second.unmount());
  await flush();
  assert.match(text(document.body), /The Host and chats' files stay on box\./);
});

test('a stopped Host with ssh up is uninstalled on Remove; one with no ssh answer only forgets it; a left Host is named', async () => {
  const toastText = () => String(calls.filter((c) => c[0] === 'toast').at(-1)?.[1]);
  responses['host.removePlan'] = () => Promise.resolve(plan({ ssh: true, online: false, busy: 'no' }));
  const first = await render(h(RemoveSheet, { machine: SSH, onClose: () => undefined }));
  await flush();
  assert.match(text(document.body), /Stops the Host on box and deletes its files\./);
  assert.doesNotMatch(text(document.body), /A turn/);
  await click(button(document.body, 'Remove'));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.uninstall').length, 1);
  assert.equal(toastText(), 'box removed');
  await first.unmount();

  calls.length = 0;
  responses['host.removePlan'] = () => Promise.resolve(plan({ ssh: true, reachable: false, online: false }));
  const down = await render(h(RemoveSheet, { machine: SSH, onClose: () => undefined }));
  await flush();
  await click(button(document.body, 'Remove'));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.uninstall').length, 0, 'nothing is sent to a machine that does not answer');
  assert.match(toastText(), /Its Host and chats' files remain there/);
  await down.unmount();

  calls.length = 0;
  responses['host.removePlan'] = () => Promise.resolve(plan({ ssh: true, shared: 'box 2', why: 'same' }));
  responses['host.uninstall'] = () => Promise.resolve({ left: 'shared', shared: 'box 2', why: 'same' });
  const shared = await render(h(RemoveSheet, { machine: SSH, onClose: () => undefined }));
  await flush();
  await click(button(document.body, 'Remove'));
  await flush();
  assert.match(toastText(), /box 2 uses the same Host/);
  await shared.unmount();
});
