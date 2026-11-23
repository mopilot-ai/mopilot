// A call naming a tab its own page closed (a sign-in popup after Allow) or the user closed: the agent hears that the
// action may have worked and which tab shows it, not "No tab" (electron/capabilities/browser/hostTabState.cjs missingTab).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tabOf } from './support/browser-host-kit.ts';

const { ORPHANS_MAX } = createRequire(import.meta.url)('../electron/capabilities/browser/hostUtil.cjs');

test('a popup that closed itself names the tab that opened it; a tab the tools closed is just unknown', async (t) => {
  const h = setup(t);
  const opener = tabOf(h, 'tab_aaaaaa');
  const other = tabOf(h, 'tab_bbbbbb');
  const popup = h.tabs.adoptPopup(opener.wc, h.popupWC());
  // OAuth: Allow posts to the opener, then the popup's page closes it
  popup.wc.destroy();
  await assert.rejects(h.tabs.resolve('c', popup.id), (e: any) => {
    assert.equal(e.code, 'tab_closed');
    assert.match(e.message, new RegExp(`^Tab ${popup.id} was closed by its own page or by the user, not by your tools\\.`));
    assert.match(e.message, /the last action may have worked: read tab_aaaaaa, which shows the result, before trying again\.$/);
    return true;
  });
  // a tab the user closed in the pane names the chat's current tab
  other.wc.destroy();
  await assert.rejects(h.tabs.resolve('c', 'tab_bbbbbb'), /read tab_aaaaaa, which shows the result/);
  // one the agent's own tools closed on purpose is an unknown id, as before
  opener.closing = true;
  opener.wc.destroy();
  await assert.rejects(h.tabs.resolve('c', 'tab_aaaaaa'), { code: 'bad_args', message: /^No tab tab_aaaaaa in this chat\./ });
  // nothing left to read: list the tabs
  await assert.rejects(h.tabs.resolve('c', popup.id), /call browser_tabs_context before trying again\.$/);
});

test('only the last few closed tabs are remembered', async (t) => {
  const h = setup(t);
  const tabs = Array.from({ length: ORPHANS_MAX + 1 }, (_, i) => tabOf(h, `tab_${String(i).padStart(6, '0')}`));
  for (const tab of tabs) tab.wc.destroy();
  await assert.rejects(h.tabs.resolve('c', tabs[0].id), { code: 'bad_args' });
  await assert.rejects(h.tabs.resolve('c', tabs[1].id), { code: 'tab_closed' });
});
