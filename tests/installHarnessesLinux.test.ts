// Linux advertises automatic package execution while retaining the same official-command and location recovery UI.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, settingsExports, render } from './support/pages-kit.ts';
import { stubStore } from './support/stubs.ts';
const { createElement: h } = await import('react');
const { create } = await import('zustand');
const store = fakeStore<any>({ status: { codex: { state: 'missing' }, claude: { state: 'missing' } }, basicHarnesses: [], prefs: {} });
stubStore({ useStore: store.useStore, navigate() {}, toast() {} });
mock.module('../src/session/harness/select.ts', { namedExports: { harnessStatus: (id: string, s: any) => s.status[id] } });
mock.module('../src/lib/platform.ts', { namedExports: { platform: 'linux' } });
mock.module('../src/session/harness/harnessRuns.ts', {
  namedExports: {
    useHarnessRuns: create<any>(() => ({ runs: [] })),
    refreshInstallTools() {},
    recheckHarness: async () => undefined,
  },
});
mock.module('../src/session/harness/basicBin.ts', { namedExports: { pickBasicBin() {} } });
mock.module('../src/session/open.ts', { namedExports: { openLink() {} } });
mock.module('../src/components/pages/Settings.tsx', { namedExports: settingsExports });
mock.module('../src/components/harnessPicker/badges.tsx', { namedExports: { HarnessIcon: () => null, BasicHarnessIcon: () => null } });
mock.module('../src/components/harness/InstallLines.tsx', { namedExports: { InstallLines: () => null } });
const { InstallHarnesses } = await import('../src/components/harness/InstallHarnesses.tsx');

test('Linux can run a package command in the app or in the user terminal', async () => {
  const view = await render(h(InstallHarnesses));
  assert.match(view.host.textContent!, /Run a command here or in your own terminal/);
  assert.equal(view.host.querySelectorAll('[data-install]').length, 2);
  await view.unmount();
});
