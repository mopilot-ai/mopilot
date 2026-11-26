// Settings › Connections while main never answers on Host: the strip does not wait for ever, it shows the tabs it can after a bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetCtl, responses, useStore, defaultState, render, flush } from './support/settings-harness.ts';
import { waitFor } from './support/waitFor.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

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

test('a read that never answers does not hold the strip for ever: after the wait it shows the tabs it can', async (t) => {
  const { view } = await openSettings();
  t.after(() => view.unmount());
  assert.equal(view.host.querySelectorAll('[role=tab]').length, 0);
  await waitFor(() => view.host.querySelectorAll('[role=tab]').length === 2, 'Control this Mac and SSH after the wait', {
    timeoutMs: 8000,
  });
});
