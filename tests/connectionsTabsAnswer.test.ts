// Settings › Connections while main has not yet said whether Host exists: no tab strip (it never shows a tab and takes it away), then the strip once it answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetCtl, responses, useStore, defaultState, render, flush } from './support/settings-harness.ts';
import { waitFor } from './support/waitFor.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

const titles = (root: Element) => [...root.querySelectorAll('.settings-group-title')].map((x) => x.textContent);

async function openSettings(tab?: string) {
  resetCtl();
  const asked: { answer: (on: boolean) => void } = { answer: () => undefined };
  Object.assign(responses, {
    'host.access': () => new Promise<boolean>((resolve) => (asked.answer = resolve)),
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [], resolved: true }),
    'host.onMachines': () => () => undefined,
    'remoteSettings.state': { visible: true, signedIn: true, enabled: false, running: false, pairing: null, devices: [] },
  });
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections', ...(tab ? { tab } : {}) } }, true);
  const view = await render(h(Settings, { section: 'connections' }));
  await flush(3);
  return { view, asked };
}

test('before main answers on Host the strip keeps its place and shows no tab; once it answers the three tabs show', async (t) => {
  const { view, asked } = await openSettings();
  t.after(() => view.unmount());
  assert.ok(view.host.querySelector('.conn-tabs'), 'its place is kept');
  assert.equal(view.host.querySelectorAll('[role=tab]').length, 0);
  asked.answer(true);
  await waitFor(() => view.host.querySelectorAll('[role=tab]').length === 3, 'the three tabs');
});

test('a link to Control other devices shows that body from the start, so nothing flips when main answers', async (t) => {
  const { view, asked } = await openSettings('other');
  t.after(() => view.unmount());
  assert.ok(!titles(view.host).includes('Devices that can control this Mac'), 'not the first tab meanwhile');
  asked.answer(true);
  await waitFor(() => view.host.querySelectorAll('[role=tab]').length === 3, 'the three tabs');
  assert.ok(!titles(view.host).includes('Devices that can control this Mac'));
});
