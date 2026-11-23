// Settings → Browser → Downloads as the Codex app has them (#1523): Reset for a custom folder, and the Ask toggle's description.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  calls,
  responses,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  row,
  flush,
} from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
  responses['browser.sites'] = [];
  responses['browserUse.state'] = { file: 'browser/config.toml', error: 'missing' };
  responses['availability.chromeLinks'] = [];
  responses['availability.onChromeLinksChanged'] = () => () => {};
});

test('a custom download folder can go back to the system Downloads; the Ask toggle says what it does', async () => {
  useStore.setState({ prefs: { ...useStore.getState().prefs, downloadsDir: '/Users/me/dl', askWhereToSave: true } });
  const { host, unmount } = await render(h(Settings, { section: 'browser' }));
  await flush();
  const loc = () => row(host, 'Location');
  assert.equal(
    text(row(host, 'Ask where to save').querySelector('.settings-row-desc')),
    'Show a save dialog for downloads you start in the built-in browser',
  );
  assert.match(text(row(host, 'Browsing data').querySelector('.settings-row-desc')), /^Clear history, cookies and cache/);
  calls.length = 0;
  await click(button(loc(), 'Reset'));
  assert.deepEqual(calls.slice(-2), [
    ['browser.setDownloads', null, true],
    ['setPrefs', { downloadsDir: null }],
  ]);
  assert.equal(text(loc().querySelector('.settings-row-desc')), 'System Downloads folder');
  assert.equal(
    [...loc().querySelectorAll('button')].some((b) => b.textContent === 'Reset'),
    false,
  );
  await unmount();
});
