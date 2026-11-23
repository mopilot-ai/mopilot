// The machine row's git line (Settings › Machines): one short line under the status only when the machine's Host said git has no sign-in, read once and never polled.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetCtl, responses, calls, useStore, defaultState, render, text, flush } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { HostMachines } = await import('../src/components/pages/settings/HostMachines.tsx');

const row = (id: string, status = 'online') => ({
  id,
  name: id.slice(4),
  status,
  note: 'SSH · Claude Code',
  signin: null,
  capabilities: { iab: false, cu: false },
  agents: [],
});

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onPrompt': () => () => undefined,
    'host.onSignin': () => () => undefined,
  });
  calls.length = 0;
});

test('only a machine whose Host said no gets the line; the others and an offline machine show none, and each online machine is read once', async (t) => {
  const answers: Record<string, unknown> = {
    'ssh:nogit': { 'github.com': 'no' },
    'ssh:fine': { 'github.com': 'yes' },
    'ssh:unsure': { 'github.com': 'unknown' },
    'ssh:asleep': { 'github.com': 'no' },
  };
  responses['host.machines'] = () =>
    Promise.resolve({ machines: [row('ssh:nogit'), row('ssh:fine'), row('ssh:unsure'), row('ssh:asleep', 'offline')], resolved: true });
  responses['host.gitSignIn'] = (id: string) => Promise.resolve(answers[id]);
  const view = await render(h(HostMachines));
  t.after(() => view.unmount());
  await flush();
  await flush();
  const rows = [...view.host.querySelectorAll('.machine-list[aria-label="My machines"] .machine-item')];
  const lines = rows.map((r) => [text(r.querySelector('.machine-name')), text(r.querySelector('.machine-git .machine-status'))]);
  assert.deepEqual(lines, [
    ['nogit', 'Git isn’t signed in to github.com'],
    ['fine', ''],
    ['unsure', ''],
    ['asleep', ''],
  ]);
  const asked = calls.filter((c: any) => c[0] === 'host.gitSignIn').map((c: any) => c[1]);
  assert.deepEqual(asked.sort(), ['ssh:fine', 'ssh:nogit', 'ssh:unsure']);
});
