// Settings → Browser's "Record turn replays" (#3571, G5): shown with the shared.browser.turnTrace flag, it saves browserTurnTrace, which main reads (electron/app/turnTraces.cjs); without the flag there is no row.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ctl, responses, resetCtl, defaultState, useStore, render, row, lastPrefs, toggle } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
  // the page's Sites table reads Codex Browser Use and Claude in Chrome's links
  responses['browserUse.state'] = { file: 'browser/config.toml', error: 'missing' };
  responses['availability.chromeLinks'] = [];
  responses['availability.onChromeLinksChanged'] = () => () => {};
});

test('the Record turn replays toggle saves browserTurnTrace, and shows only with its flag', async () => {
  const on = await render(h(Settings, { section: 'browser' }));
  await toggle(on.host, 'Record turn replays');
  assert.deepEqual(lastPrefs(), { browserTurnTrace: true });
  await on.unmount();
  ctl.flags['shared.browser.turnTrace'] = false;
  const off = await render(h(Settings, { section: 'browser' }));
  assert.throws(() => row(off.host, 'Record turn replays'));
  await off.unmount();
});
