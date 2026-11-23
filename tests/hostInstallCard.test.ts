// The Add machine card reads as one line (running, installed, couldn't install) with the step list behind Details, open only on a failure; a saved ssh target that is also a Host machine is listed once, with Open terminal in its machine row's menu.
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
  setValue,
  flush,
  act,
  options,
} from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { renderMachines } = await import('./support/addMachineView.ts');
const { SshConnections } = await import('../src/components/pages/settings/Connections.tsx');

const ROW = {
  id: 'ssh:me@box',
  name: 'me@box',
  status: 'online',
  note: 'SSH · Claude Code',
  signin: null,
  capabilities: { iab: false, cu: false },
  agents: [],
};
let pushStep: (v: unknown) => void = () => undefined;

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [ROW], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': (cb: any) => ((pushStep = cb), () => undefined),
    'host.onPrompt': () => () => undefined,
    'host.onSignin': () => () => undefined,
  });
  calls.length = 0;
});

const step = (id: string, label: string, state: string, output = '') => ({ destination: 'me@box', step: { id, label, state, output } });
const details = (root: Element) => root.querySelector('details') as HTMLDetailsElement;

/** Opens the Add machine sheet (one field, no tabs). */
async function openSheet(host: Element) {
  await click(button(host, 'Add machine'));
}

test('while installing the card is one line that names no step, with the list closed', async (t) => {
  responses['host.add'] = () => new Promise(() => undefined);
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await openSheet(view.host);
  await setValue(view.host.querySelector('input[aria-label="Machine"]')!, 'me@box');
  await click(button(view.host, 'Add'));
  assert.match(text(view.host.querySelector('.host-install-line')), /^Setting up me@box…$/);
  await act(() => pushStep(step('connect', 'Connect', 'ok', 'Darwin arm64')));
  await act(() => pushStep(step('upload', 'Upload the Host', 'running')));
  assert.match(text(view.host.querySelector('.host-install-line')), /^Setting up me@box…$/);
  assert.equal(details(view.host).open, false);
});

test('an installed machine collapses to one line with no Details', async (t) => {
  const steps = [
    { id: 'prepare', label: 'Prepare the Host', state: 'ok', output: 'Host 0.0.1' },
    { id: 'check', label: 'Check the upload', state: 'ok', output: 'SHA-256 cde68b7ade0b…' },
  ];
  responses['host.add'] = () => Promise.resolve({ ok: true, paired: true, error: '', id: 'ssh:me@box', steps });
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await openSheet(view.host);
  await setValue(view.host.querySelector('input[aria-label="Machine"]')!, 'me@box');
  await click(button(view.host, 'Add'));
  assert.equal(text(view.host.querySelector('.host-install-line')), 'me@box is ready');
  assert.equal(view.host.querySelector('details'), null);
});

test('an install without steps or a version still ends as one line', async (t) => {
  responses['host.add'] = () => Promise.resolve({ ok: true, paired: true, error: '', id: 'ssh:me@box', steps: [] });
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await openSheet(view.host);
  await setValue(view.host.querySelector('input[aria-label="Machine"]')!, 'me@box');
  await click(button(view.host, 'Add'));
  assert.equal(text(view.host.querySelector('.host-install-line')), 'me@box is ready');
  assert.equal(view.host.querySelector('details'), null);
});

test('a failed install keeps Details closed on the failing step, with the reason and a retry', async (t) => {
  responses['host.add'] = () =>
    Promise.resolve({
      ok: false,
      paired: false,
      error: 'Node 22 or newer is needed',
      id: '',
      steps: [{ id: 'node', label: 'Check Node', state: 'failed', output: 'v18' }],
    });
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await openSheet(view.host);
  await setValue(view.host.querySelector('input[aria-label="Machine"]')!, 'me@box');
  await click(button(view.host, 'Add'));
  assert.equal(text(view.host.querySelector('.host-install-line')), 'Couldn’t set up Node on me@box');
  assert.equal(details(view.host).open, false);
  assert.match(text(details(view.host)), /Check Node ✕v18/);
  assert.match(text(view.host.querySelector('[role=alert]')), /Node 22/);
  assert.equal(button(view.host, 'Add').disabled, false);
});

test('a saved ssh target that is a Host machine is listed once; Open terminal moves to its machine row menu', async (t) => {
  useStore.setState({ prefs: { ...useStore.getState().prefs, sshHosts: ['me@box', 'plain'] } });
  const conns = await render(h(SshConnections));
  const mine = await renderMachines();
  t.after(() => (conns.unmount(), mine.unmount()));
  await flush();
  assert.doesNotMatch(text(conns.host), /me@box/);
  assert.match(text(conns.host), /plain/);
  await click(button(conns.host, 'Connect'));
  assert.equal(calls.filter((c) => c[0] === 'openPaneTab').at(-1)![2].command[1], 'plain');
  await click(button(mine.host, 'More for me@box'));
  await click(button(mine.host, 'Open terminal'));
  assert.equal(calls.filter((c) => c[0] === 'openPaneTab').at(-1)![2].command[1], 'me@box');
});

test('a Host machine row for a non-ssh id has no Open terminal', async (t) => {
  responses['host.machines'] = () => Promise.resolve({ machines: [{ ...ROW, id: 'relay:x' }], resolved: true });
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush(5);
  await click(button(view.host, 'More for me@box'));
  assert.deepEqual(options(view.host), ['Rename', 'Remove']);
});
