// Settings → My machines → Sign out everywhere (HostSignOut.tsx): asked once more before it runs, Cancel runs nothing, then one line per machine saying what was signed out or why not; a refusal is a toast.
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
  buttons,
  text,
  flush,
} from './support/settings-harness.ts';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { HostSignOut, signOutLine } = await import('../src/components/pages/settings/HostSignOut.tsx');

const agent = (id: string, label: string, signedOut: boolean, error: string | null = null) => ({ id, label, signedOut, error });
const RESULTS = [
  { id: 'mini', name: 'mini', state: 'done', error: null, agents: [agent('claude', 'Claude Code', true), agent('codex', 'Codex', true)] },
  { id: 'box', name: 'box', state: 'offline', error: "Couldn't reach box. Sign out there when it's back.", agents: [] },
  {
    id: 'lab',
    name: 'lab',
    state: 'partial',
    error: 'busy',
    agents: [agent('claude', 'Claude Code', true), agent('codex', 'Codex', false, 'keychain locked')],
  },
  { id: 'old', name: 'old', state: 'done', error: null, agents: [] },
];

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  calls.length = 0;
  responses['host.signOutEverywhere'] = () => Promise.resolve(RESULTS);
});

test('each machine’s line says what was signed out or why not', () => {
  assert.deepEqual(RESULTS.map(signOutLine as any), [
    'mini: Claude Code and Codex signed out',
    "box: Couldn't reach box. Sign out there when it's back.",
    'lab: Claude Code signed out. Codex: keychain locked. busy',
    'old: nothing was signed in',
  ]);
  assert.equal(signOutLine({ id: 'x', name: 'x', state: 'offline', error: null, agents: [] } as any), 'x: not reached');
});

let signedOut = 0;
const onSignedOut = () => void signedOut++;

test('it asks once more; Cancel runs nothing; Sign out runs it, lists every machine and says it signed out', async (t) => {
  signedOut = 0;
  const root = await render(h(HostSignOut, { onSignedOut }));
  t.after(() => root.unmount());
  await click(button(root.host, 'Sign out everywhere'));
  await click(button(root.host, 'Cancel'));
  assert.equal(calls.filter((c) => c[0] === 'host.signOutEverywhere').length, 0);
  await click(button(root.host, 'Sign out everywhere'));
  await click(button(root.host, 'Sign out'));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.signOutEverywhere').length, 1);
  assert.match(text(root.host), /mini: Claude Code and Codex signed out/);
  assert.match(text(root.host), /box: Couldn't reach box/);
  assert.equal(root.host.querySelectorAll('.host-signout.offline').length, 1);
  assert.equal(signedOut, 1, 'the keys here are gone: the sign-in row is told');
});

test('no machines says so; a refusal is a toast and lists nothing', async (t) => {
  responses['host.signOutEverywhere'] = () => Promise.resolve([]);
  const root = await render(h(HostSignOut, { onSignedOut }));
  t.after(() => root.unmount());
  await click(button(root.host, 'Sign out everywhere'));
  await click(button(root.host, 'Sign out'));
  await flush();
  assert.match(text(root.host), /No machines\./);
  signedOut = 0;
  responses['host.signOutEverywhere'] = () => Promise.reject(new Error('Host is not available for this account.'));
  const refused = await render(h(HostSignOut, { onSignedOut }));
  t.after(() => refused.unmount());
  await click(buttons(refused.host, 'Sign out everywhere').at(-1)!);
  await click(button(refused.host, 'Sign out'));
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'Host is not available for this account.', 'error']);
  assert.equal(signedOut, 0, 'a refusal changes nothing here');
});
