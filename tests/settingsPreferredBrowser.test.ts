// Settings → Browser's Preferred browser row: what it says while MoPilot's own extension serves agents (#1631).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  responses,
  resetCtl,
  defaultState,
  useStore,
  render,
  text,
  row,
  pick,
  flush,
  calls,
  toggle,
  lastPrefs,
} from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
  // the Browser page's Sites table (settings/BrowserUse.tsx) reads Codex Browser Use and Claude in Chrome's links
  responses['browserUse.state'] = { file: 'browser/config.toml', error: 'missing' };
  responses['availability.chromeLinks'] = [];
  responses['availability.onChromeLinksChanged'] = () => () => {};
});

test("Preferred browser: where MoPilot's extension serves Chrome, Chrome is reached through it and the Playwright rows are gone", async () => {
  responses['availability.status'] = { harnesses: [], chromeTools: true, platform: 'darwin', at: 1 };
  // main runs the built-in browser's tools while the extension serves Chrome (control.cjs effectiveChannel)
  responses['browser.chromeState'] = { active: 'builtin', hasToken: false, extensionUrl: 'https://ext' };
  responses['browser.configure'] = { active: 'builtin', hasToken: false, extensionUrl: 'https://ext' };
  const { host, unmount } = await render(h(Settings, { section: 'browser' }));
  await flush();
  const desc = () => text(row(host, 'Preferred browser').querySelector('.settings-row-desc'));
  assert.equal(desc(), 'Agents use the built-in browser unless you ask otherwise.');
  await pick(row(host, 'Preferred browser'), 'Chrome');
  await flush();
  assert.equal(desc(), 'Agents use your Chrome unless you ask otherwise.');
  assert.doesNotMatch(host.textContent ?? '', /Playwright|Connection token|Test connection/);
  await unmount();
});

test('Claude Code can use Claude in Chrome instead, by choice; the rows are read again', async () => {
  responses['availability.status'] = { harnesses: [], chromeTools: true, platform: 'darwin', at: 1 };
  responses['browser.chromeState'] = { active: 'builtin', hasToken: false, extensionUrl: 'https://ext' };
  const { host, unmount } = await render(h(Settings, { section: 'browser' }));
  await flush();
  responses['browser.claudeInChrome'] = true;
  const before = calls.filter((c: any) => c[0] === 'availability.status').length;
  await toggle(host, 'Use Claude in Chrome');
  await flush();
  // main saves it first; then the store and the rows follow
  assert.deepEqual(calls.find((c: any) => c[0] === 'browser.claudeInChrome')?.slice(1), [true]);
  assert.deepEqual(lastPrefs(), { claudeInChrome: true });
  assert.ok(calls.filter((c: any) => c[0] === 'availability.status').length > before);
  // a save that fails is a toast, and the setting stays
  responses['browser.claudeInChrome'] = () => Promise.reject(new Error('disk full'));
  await toggle(host, 'Use Claude in Chrome');
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't change the setting: disk full", 'error']);
  // the rows' refresh failing is only noted: the setting is saved
  responses['browser.claudeInChrome'] = false;
  responses['availability.status'] = () => Promise.reject(new Error('gone'));
  await toggle(host, 'Use Claude in Chrome');
  await flush();
  assert.deepEqual(lastPrefs(), { claudeInChrome: false });
  await unmount();
});

test('a build without the extension keeps Your Chrome over the Playwright Extension, and says when it is unavailable', async () => {
  responses['availability.status'] = { harnesses: [], chromeTools: false, platform: 'darwin', at: 1 };
  responses['browser.chromeState'] = { active: 'builtin', hasToken: false, extensionUrl: 'https://ext' };
  responses['browser.configure'] = { active: 'builtin', hasToken: false, extensionUrl: 'https://ext' };
  const { host, unmount } = await render(h(Settings, { section: 'browser' }));
  await flush();
  assert.doesNotMatch(host.textContent ?? '', /Use Claude in Chrome/);
  await pick(row(host, 'Preferred browser'), 'Chrome');
  await flush();
  assert.equal(
    text(row(host, 'Preferred browser').querySelector('.settings-row-desc')),
    "Chrome isn't available. Test the connection below.",
  );
  assert.ok(row(host, 'Playwright Extension'));
  await unmount();
});
