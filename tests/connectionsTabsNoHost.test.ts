// Settings › Connections where Host is not available to the account: the machines tab is not offered, and a link that names it lands on the first tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetCtl, responses, useStore, defaultState, render, text, flush } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

test('without Host the strip is Control this Mac and SSH, and a link to the machines tab opens the first', async (t) => {
  resetCtl();
  Object.assign(responses, {
    'host.access': false,
    'host.onAccess': () => () => undefined,
    'remoteSettings.state': { visible: true, signedIn: true, enabled: false, running: false, pairing: null, devices: [] },
  });
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections', tab: 'other' } }, true);
  const view = await render(h(Settings, { section: 'connections' }));
  t.after(() => view.unmount());
  await flush(3);
  const tabs = [...view.host.querySelectorAll('[role=tab]')].map(
    (x) => `${text(x)}${x.getAttribute('aria-selected') === 'true' ? '*' : ''}`,
  );
  assert.deepEqual(tabs, ['Control this Mac*', 'SSH']);
  assert.ok([...view.host.querySelectorAll('.settings-group-title')].some((x) => text(x) === 'Devices that can control this Mac'));
});
