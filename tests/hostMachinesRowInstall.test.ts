// Install on a Settings → My machines row with the default installer (src/lib/hostInstall.ts installAndWait): the machine's Host installs the agent, the row's menu opens Install an agent…, the row says "Installing Codex…" while it runs and the button is busy, a failure is a toast with the machine's reason, and an install that ends lets the row offer what the machine says next.
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
  act,
} from './support/settings-harness.ts';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { HostMachines } = await import('../src/components/pages/settings/HostMachines.tsx');
const { installAndWait } = await import('../src/lib/hostInstall.ts');

const MINI = {
  id: 'ssh:mini',
  name: 'mini',
  status: 'online',
  note: 'SSH · Claude Code',
  capabilities: { iab: false, cu: false },
  agents: [
    { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
    { id: 'codex', label: 'Codex', state: 'missing', reason: 'Not installed on mini' },
    { id: 'gemini', label: 'Gemini', state: 'missing', reason: 'Not installed on mini' },
  ],
  installable: ['codex', 'gemini'],
};
const install = (o: object) => ({ hostId: 'ssh:mini', harness: 'codex', line: '', error: null, version: null, ...o });
let push: (v: unknown) => void = () => undefined;

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.machines': () => Promise.resolve({ machines: [MINI], resolved: true }),
    'host.onAgentInstall': (cb: any) => ((push = cb), () => undefined),
    'host.installAgent': (id: string, harness: string) => Promise.resolve(install({ hostId: id, harness, state: 'queued' })),
  });
  calls.length = 0;
});

test('the row installs on the machine itself: Installing… with its line, then a failure is a toast with the reason', async (t) => {
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  // Claude Code runs there, so nothing must be done: the install is in the row's menu
  assert.equal(text(root.host.querySelector('.machine-status')), 'Online · Claude Code');
  await click(button(root.host, 'More for mini'));
  await click(button(root.host, 'Install an agent…'));
  assert.match(
    text(root.host.querySelector('.dialog')),
    /Install on mini.*Codex.*Gemini/,
    'an ACP agent the Host installs is offered beside the core ones',
  );
  await click(button(root.host, 'Install Codex on mini'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.installAgent'),
    [['host.installAgent', 'ssh:mini', 'codex']],
  );
  await act(async () => push(install({ state: 'running', line: 'added 3 packages' })));
  assert.equal(text(root.host.querySelector('.machine-status')), 'Installing Codex…');
  assert.equal(button(root.host, 'Install Codex on mini').textContent, 'Installing…');
  await act(async () =>
    push(install({ state: 'failed', error: "Couldn't reach the npm registry. Check this machine's network or proxy." })),
  );
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), [
    'toast',
    "Couldn't reach the npm registry. Check this machine's network or proxy.",
    'error',
  ]);
  assert.equal(button(root.host, 'Install Codex on mini').textContent, 'Install', 'Retry is the same button');
  await click(button(root.host.querySelector('.dialog')!, 'Close'));
  assert.equal(root.host.querySelector('.dialog'), null);
  assert.doesNotMatch(text(root.host), /Installing Codex…/);
});

test('installAndWait settles on how this install ends, not on a view from an earlier one', async (t) => {
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush();
  // an earlier failure is in the store when the next install starts
  await act(async () => push(install({ state: 'failed', error: 'old' })));
  let settled = '';
  const done = installAndWait('ssh:mini', 'codex').then(
    () => (settled = 'resolved'),
    (e) => (settled = `rejected ${e.message}`),
  );
  await flush();
  assert.equal(settled, '', 'the queued view replaced the old failure');
  await act(async () => push(install({ state: 'installed', version: '1.0.0' })));
  await done;
  assert.equal(settled, 'resolved');
  // cancelled ends it quietly; unreachable without a reason still says why
  const quiet = installAndWait('ssh:mini', 'codex');
  await flush();
  await act(async () => push(install({ state: 'cancelled' })));
  await quiet;
  const lost = assert.rejects(installAndWait('ssh:mini', 'codex'), /Couldn't install Codex\./);
  await flush();
  await act(async () => push(install({ state: 'unreachable' })));
  await lost;
  responses['host.installAgent'] = () => Promise.reject(new Error('mini is offline.'));
  await assert.rejects(installAndWait('ssh:mini', 'codex'), /mini is offline/);
});

test('an install no longer followed (Host access lost) ends the wait', async () => {
  // no window follows the store: the start's own view is all there is, and once it is gone the wait ends
  responses['host.installAgent'] = () => Promise.resolve(null);
  await installAndWait('ssh:mini', 'codex');
});

test('Install an agent… also lists an agent its Host cannot install, with the vendor command or page', async (t) => {
  const manual = {
    ...MINI,
    agents: [...MINI.agents, { id: 'cursor', label: 'Cursor', state: 'missing', reason: 'Not installed on mini' }],
    installable: ['codex'],
  };
  Object.assign(responses, { 'host.machines': () => Promise.resolve({ machines: [manual], resolved: true }) });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  await click(button(root.host, 'More for mini'));
  await click(button(root.host, 'Install an agent…'));
  const sheet = text(root.host.querySelector('.dialog'));
  assert.match(sheet, /Codex.*Cursor.*curl https:\/\/cursor\.com\/install/);
  assert.equal(root.host.querySelectorAll('[data-install-by-hand="cursor"]').length, 1);
});
