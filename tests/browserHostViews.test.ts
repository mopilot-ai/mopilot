// The browser host with main-owned view tabs (electron/capabilities/browser/views.cjs): tabs opened with no
// window, popups as tabs, a chat forgotten closes its views, a view that goes is never an orphan, and input
// needs no painted layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, drive, tabOf } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);
const { PaneViews } = require('../electron/capabilities/browser/views.cjs');

/** Makes a fake webContents a view tab, as main's PaneViews makes its pages. */
function views() {
  const v = new PaneViews({
    WebContentsView: class {
      webContents: any;
      constructor(o: any) {
        this.webContents = o.webContents;
      }
      setBounds() {}
    },
    BrowserWindow: class {
      contentView = { addChildView() {}, removeChildView() {} };
      isDestroyed() {
        return false;
      }
      setContentSize() {}
      destroy() {}
    },
    session: () => null,
    partition: () => 'persist:browser',
    windowOf: () => null,
  });
  return (wc: any) => v.adopt(wc).wc;
}
const viewWC = (h: any, asView: (wc: any) => any) => asView(h.newWC({ type: 'window', prefs: { sandbox: true, contextIsolation: true } }));

test('create: a view tab opens at once with no window, is current and announced; showing it is best effort', async (t) => {
  const asView = views();
  const spawned: string[] = [];
  const h = setup(t, {
    spawn: (chatId: string, hh: any) => (spawned.push(chatId), viewWC(hh, asView)),
    open: (_c: string, _r: any, hh: any) => {
      if (hh.mode === 'throw') throw new Error('window gone');
      return false;
    },
  });
  const tab = await h.tabs.create('c', { focus: true });
  assert.deepEqual(spawned, ['c']);
  assert.equal(tab.created, true);
  assert.equal(tab.owner, null);
  assert.equal(h.tabs.current('c'), tab);
  assert.deepEqual(h.log.open, [['c', { tabKey: tab.id, focus: true, owner: null }]]);
  assert.match(h.tabs.state('c'), new RegExp(`tab_opened ${tab.id}`));
  h.mode = 'throw';
  const second = await h.tabs.create('c');
  assert.equal(h.tabs.current('c'), second);
  assert.equal(h.tabs.waiting.size, 0);
});

test('create: spawn returning nothing (views off) opens a pane <webview> as before', async (t) => {
  const h = setup(t, { spawn: () => null, attachMs: 1000 });
  const tab = await drive(t, h.tabs.create('c'));
  assert.equal(tab.wc.getType(), 'webview');
});

test("adoptPopup asTab: a view tab's popup is a tab of its own in the chat, current", (t) => {
  const asView = views();
  const h = setup(t);
  const opener = tabOf(h, 'tab_aaaaaa', 'c', viewWC(h, asView), null);
  const popup = h.tabs.adoptPopup(opener.wc, viewWC(h, asView), { asTab: true });
  assert.equal(popup.kind, 'tab');
  assert.equal(popup.root, null);
  assert.equal(h.tabs.current('c'), popup);
  assert.match(h.tabs.state('c'), new RegExp(`tab_opened ${popup.id} \\(popup from ${opener.id}`));
});

test('a view tab whose page goes is closed for good: no orphan to come back', (t) => {
  const asView = views();
  const h = setup(t);
  const tab = tabOf(h, 'tab_aaaaaa', 'c', viewWC(h, asView), null);
  tab.wc.destroy();
  assert.equal(h.tabs.chats.get('c').orphans.size, 0);
  assert.equal(tab.closed, true);
});

test("forget: a deleted chat's view tabs are closed by main; a failing close is ignored; guests are only let go", (t) => {
  const asView = views();
  const closing: string[] = [];
  const h = setup(t, {
    close: (tab: any) => {
      closing.push(tab.id);
      if (tab.id === 'tab_bbbbbb') throw new Error('gone');
    },
  });
  const a = tabOf(h, 'tab_aaaaaa', 'c', viewWC(h, asView), null);
  const b = tabOf(h, 'tab_bbbbbb', 'c', viewWC(h, asView), null);
  const guest = tabOf(h, 'tab_cccccc');
  h.tabs.forget('c');
  assert.deepEqual(closing, [a.id, b.id]);
  assert.equal(a.closing, true);
  assert.equal(guest.closing, false);
});

test('input on a view tab needs no painted layer: nothing is selected or waited for', async (t) => {
  const asView = views();
  const h = setup(t);
  const tab = tabOf(h, 'tab_aaaaaa', 'c', viewWC(h, asView), null);
  const st = await drive(t, h.tabs.ready(tab, 'c', { input: true }));
  assert.equal(st.visibility, 'visible');
  assert.deepEqual(h.log.select, [tab.id], 'only the reveal of the turn');
});
