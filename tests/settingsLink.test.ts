// The links that open a Settings page (src/store/settingsLink.ts): a section, a section on a tab, the machines tab.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './support/waitFor.ts';

const navigated: unknown[] = [];
mock.module('../src/store/panes.ts', {
  namedExports: {
    navigate: (route: unknown) => {
      navigated.push(route);
    },
  },
});
mock.module('../src/store/core.ts', { namedExports: { toastFailure: () => () => undefined } });
const { openMachines, openSettings } = await import('../src/store/settingsLink.ts');

test('a link opens its section, on its tab when it names one, and Control other devices is the machines link', async () => {
  openSettings('git')();
  openSettings('connections', 'ssh')();
  openMachines();
  await waitFor(() => navigated.length === 3, 'the three links to navigate');
  assert.deepEqual(navigated, [
    { name: 'settings', section: 'git' },
    { name: 'settings', section: 'connections', tab: 'ssh' },
    { name: 'settings', section: 'connections', tab: 'other' },
  ]);
});
