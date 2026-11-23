// The in-app browser host behind the browser_* tools (electron/capabilities/browser/host.cjs): per-chat
// tabs and popups, take over / reveal, creating, closing and selecting tabs, the state report, layers and
// remounted pages, over the fakes in tests/support/browser-host-kit.ts. Timers and Date are mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MAX_TABS, drive, setup, tabOf } from './support/browser-host-kit.ts';

/* ------------------------------------------------------------------ */
/* tabs: attach, popups, selection, the pane's take over and reveal   */
/* ------------------------------------------------------------------ */

test('attach: a pane tab joins its chat (keyed or the original tab); bad chats and targets keep nothing', (t) => {
  const h = setup(t);
  assert.throws(() => h.tabs.attach('', 'tab_aaaaaa', h.newWC(), h.owner), { code: 'bad_target' });
  assert.throws(() => h.tabs.attach(7, 'tab_aaaaaa', h.newWC(), h.owner), { code: 'bad_target' });
  assert.throws(() => h.tabs.attach('c', 'tab_aaaaaa', h.newWC({ type: 'window' }), h.owner), { code: 'bad_target' });
  assert.throws(() => h.tabs.attach('c', 'tab_aaaaaa', h.newWC(), { other: true }), { code: 'bad_target' }, 'another window');
  assert.equal(h.tabs.list('c').length, 0);

  const legacy = tabOf(h, null);
  assert.equal(legacy.legacy, true);
  assert.match(legacy.id, /^tab_[0-9a-f]{6}$/);
  const keyed = tabOf(h, 'tab_bbbbbb');
  assert.equal(keyed.id, 'tab_bbbbbb');
  assert.equal(keyed.legacy, false);
  const bogus = tabOf(h, 'not-a-key');
  assert.equal(bogus.legacy, true, 'a malformed key is the original tab');
  assert.equal(h.tabs.list('c').length, 2, 'the original tab was remounted, not added');
  assert.equal(h.tabs.current('c').id, legacy.id, 'the first tab is current');
  assert.deepEqual(
    h.log.onSelect.map((x: any) => x[0]),
    ['c'],
  );
  assert.deepEqual(h.tabs.list('nobody'), []);
  assert.equal(h.tabs.current('nobody'), null);
  assert.equal(h.tabs.byKey('nobody', null), null);
  assert.equal(h.tabs.byKey('c', 'tab_bbbbbb'), keyed);
  assert.equal(h.tabs.byKey('c', null), bogus);
  assert.equal(h.tabs.byKey('c', 'tab_cccccc'), null);
});

test('attach: the same page again re-selects the current tab; a remounted page keeps the tab id, mark and take over', (t) => {
  const h = setup(t);
  const wc = h.newWC();
  const tab = tabOf(h, 'tab_aaaaaa', 'c', wc);
  tab.created = true;
  tab.mark = 'handoff';
  tab.takenOver = true;
  tab.wc.debugger.attached = true;
  assert.equal(tabOf(h, 'tab_aaaaaa', 'c', wc), tab);
  assert.equal(h.log.onSelect.length, 2, 'selected again for the legacy tools');
  const other = tabOf(h, 'tab_bbbbbb');
  assert.equal(tabOf(h, 'tab_bbbbbb', 'c', other.wc), other);
  assert.equal(h.log.onSelect.length, 2, 'not the current tab: nothing to re-select');

  const wc2 = h.newWC();
  const remounted = tabOf(h, 'tab_aaaaaa', 'c', wc2);
  assert.notEqual(remounted, tab);
  assert.equal(tab.closed, true);
  assert.equal(tab.wc.debugger.attached, false, 'the old page is let go');
  assert.deepEqual(
    [remounted.id, remounted.wc, remounted.created, remounted.mark, remounted.takenOver],
    ['tab_aaaaaa', wc2, true, 'handoff', true],
  );
  // the old page's destruction does not touch the new tab
  wc.destroy();
  assert.equal(h.tabs.byKey('c', 'tab_aaaaaa'), remounted);
});

test('popups join the chat of the tab that opened them, chain to its root tab and become current', (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.created = true;
  assert.equal(h.tabs.adoptPopup(h.newWC(), h.popupWC()), null, 'an opener that is no tab');
  const popupWc = h.popupWC();
  const popup = h.tabs.adoptPopup(tab.wc, popupWc);
  assert.equal(popup.kind, 'popup');
  assert.equal(popup.root, tab);
  assert.equal(popup.created, true);
  assert.equal(h.tabs.current('c'), popup);
  assert.equal(h.tabs.adoptPopup(tab.wc, popupWc), null, 'already adopted');
  const nested = h.tabs.adoptPopup(popupWc, h.popupWC());
  assert.equal(nested.root, tab, 'a popup of a popup chains to the root tab');
  assert.deepEqual(h.log.onSelect.length, 1, 'popups are not handed to the legacy tools');
  assert.match(
    h.tabs.state('c'),
    /changes: tab_opened tab_\w+ \(popup from tab_aaaaaa; it is now the current tab\); tab_opened tab_\w+ \(popup from tab_\w+/,
  );
  // popups are checked against their root tab
  nested.check();
  popupWc.prefs = {};
  assert.throws(() => popup.check(), { code: 'bad_target' });
  // closing the current tab selects the last remaining one
  nested.wc.destroy();
  assert.equal(h.tabs.current('c'), popup);
  popup.wc.destroy();
  tab.wc.destroy();
  assert.equal(h.tabs.current('c'), null);
  assert.match(h.tabs.state('c'), /tabs: none/);
});

test('emit: change notifications survive a failing listener, and work without one', (t) => {
  const h = setup(t, { onChangeThrows: true, onSelectThrows: true });
  const tab = tabOf(h);
  assert.deepEqual(h.log.changes, ['c']);
  assert.equal(h.tabs.current('c'), tab, 'a failing onSelect does not undo the selection');
  const quiet = setup(t, { noOptional: true });
  assert.ok(tabOf(quiet));
  quiet.tabs.emit('c');
});

test('takeOver: the user takes a tab over and hands it back; the agent learns it with its next result', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  assert.equal(h.tabs.takeOver('c', 'tab_zzzzzz'), false);
  assert.equal(h.tabs.takeOver('nobody', null), false);
  h.log.changes.length = 0;
  assert.equal(h.tabs.takeOver('c', 'tab_aaaaaa'), true);
  assert.equal(tab.takenOver, true);
  assert.equal(h.tabs.takeOver('c', 'tab_aaaaaa', true), true, 'already taken over');
  assert.deepEqual(h.log.changes, ['c'], 'no second notification');
  await assert.rejects(h.tabs.ready(tab, 'c'), { code: 'taken_over', message: /^The user took over tab_aaaaaa/ });
  // a popup of a taken-over tab is refused too, naming the tab the user took
  const popup = h.tabs.adoptPopup(tab.wc, h.popupWC());
  await assert.rejects(h.tabs.ready(popup, 'c'), { code: 'taken_over', message: /^The user took over tab_aaaaaa/ });
  assert.match(h.tabs.state('c'), /user_took_over tab_aaaaaa: the user is using this tab now/);
  assert.equal(h.tabs.takeOver('c', 'tab_aaaaaa', false), true);
  assert.equal(tab.takenOver, false);
  assert.match(h.tabs.state('c'), /user_handed_back tab_aaaaaa: you may act on it again/);
  await drive(t, h.tabs.ready(tab, 'c'));
  // a taken-over popup names itself
  popup.takenOver = true;
  await assert.rejects(h.tabs.ready(popup, 'c'), { message: new RegExp(`^The user took over ${popup.id}`) });
});

test('reveal: the first action on a tab in a turn brings it to the front once, unless the user hid the pane', async (t) => {
  const h = setup(t, {
    select: () => {
      throw new Error('window gone');
    },
  });
  const a = tabOf(h);
  const b = tabOf(h, 'tab_bbbbbb');
  await drive(t, h.tabs.ready(a, 'c'));
  await drive(t, h.tabs.ready(a, 'c'));
  await drive(t, h.tabs.ready(b, 'c'));
  await drive(t, h.tabs.ready(a, 'c'));
  assert.deepEqual(h.log.select, ['tab_aaaaaa', 'tab_bbbbbb', 'tab_aaaaaa'], 'once per switch between tabs, a failing select ignored');
  // popups are their own windows: never revealed in the pane
  const popup = h.tabs.adoptPopup(a.wc, h.popupWC());
  await drive(t, h.tabs.ready(popup, 'c'));
  assert.equal(h.log.select.length, 3);
  h.tabs.paneHidden('c');
  h.tabs.paneHidden('nobody');
  await drive(t, h.tabs.ready(b, 'c'));
  assert.equal(h.log.select.length, 3, 'no reveal after the user hid the pane');
  // the next turn reveals again
  await drive(t, h.tabs.turnEnded('c'));
  await drive(t, h.tabs.ready(b, 'c'));
  assert.deepEqual(h.log.select, ['tab_aaaaaa', 'tab_bbbbbb', 'tab_aaaaaa', 'tab_bbbbbb']);
  // every reveal is automatic: the pane decides whether a tab the user has seen may reopen it
  assert.deepEqual(h.log.auto, h.log.select);
});

/* ------------------------------------------------------------------ */
/* opening, closing, selecting, marking                                */
/* ------------------------------------------------------------------ */

test("create: a new pane tab in the window of the chat's tabs; current, reported and announced", async (t) => {
  const h = setup(t, { attachMs: 1000 });
  const first = await drive(t, h.tabs.create('c', { focus: true }));
  assert.equal(first.created, true);
  assert.equal(h.tabs.current('c'), first);
  assert.deepEqual(h.log.open[0][1], { tabKey: first.id, focus: true, owner: null });
  const second = await drive(t, h.tabs.create('c'));
  assert.deepEqual(h.log.open[1][1], { tabKey: second.id, focus: false, owner: h.owner });
  assert.equal(h.tabs.current('c'), second);
  assert.match(h.tabs.state('c'), new RegExp(`changes: tab_opened ${first.id}; tab_opened ${second.id}`));
  assert.equal(h.tabs.waiting.size, 0);
});

test('create: at most MAX_TABS, no window to open it in, or a pane that never attaches', async (t) => {
  const h = setup(t, { attachMs: 1000, open: (_c: string, _r: any, hh: any) => (hh.mode === 'none' ? false : undefined) });
  for (let i = 0; i < MAX_TABS; i++) tabOf(h, `tab_${String(i).padStart(6, '0')}`);
  await assert.rejects(h.tabs.create('c'), {
    code: 'limit',
    message: `This chat already has ${MAX_TABS} tabs. Close one with browser_tabs_close first.`,
  });
  h.mode = 'none';
  await assert.rejects(drive(t, h.tabs.create('d')), {
    code: 'no_browser',
    message: 'There is no MoPilot window to open the browser in.',
  });
  assert.equal(h.tabs.waiting.size, 0);
  h.mode = 'silent';
  await assert.rejects(drive(t, h.tabs.create('d')), { code: 'no_browser', message: /didn't open in MoPilot/ });
  assert.equal(h.tabs.waiting.size, 0);
  // the default attach wait is ATTACH_MS (15 s)
  const d = setup(t, { open: () => undefined });
  await assert.rejects(drive(t, d.tabs.create('x'), { step: 1000 }), { code: 'no_browser' });
});

test('create: a tab that attached and was closed before the wait ended is not handed out', async (t) => {
  const h = setup(t, {
    attachMs: 1000,
    open: (chatId: string, req: any, hh: any) => {
      const wc = hh.newWC();
      setTimeout(() => {
        hh.tabs.attach(chatId, req.tabKey, wc, hh.owner);
        wc.destroy();
      }, 5);
    },
  });
  await assert.rejects(drive(t, h.tabs.create('c')), { code: 'no_browser' });
});

test("resolve: a named tab must be this chat's; no name means the current tab, or a new one", async (t) => {
  const h = setup(t, { attachMs: 1000 });
  const opened = await drive(t, h.tabs.resolve('c'));
  assert.equal(opened.created, true);
  assert.deepEqual(h.log.open[0][1].focus, true);
  assert.equal(await h.tabs.resolve('c', ''), opened);
  assert.equal(await h.tabs.resolve('c', null), opened);
  assert.equal(await h.tabs.resolve('c', opened.id), opened);
  await assert.rejects(h.tabs.resolve('other', opened.id), {
    code: 'bad_args',
    message: `No tab ${opened.id} in this chat. Call browser_tabs_context to list this chat's tabs.`,
  });
  await assert.rejects(h.tabs.resolve('c', 'tab_zzzzzz'), { code: 'bad_args' });
  opened.wc.destroy();
  await assert.rejects(h.tabs.resolve('c', opened.id), { code: 'tab_closed' });
});

test('close: asks the pane to close the tab and waits for it to go (bounded); failures to close are ignored', async (t) => {
  const h = setup(t, {
    close: (tab: any) => {
      if (tab.id === 'tab_bbbbbb') throw new Error('window gone');
      if (tab.id === 'tab_aaaaaa') setTimeout(() => tab.wc.destroy(), 5);
    },
  });
  const a = tabOf(h);
  const b = tabOf(h, 'tab_bbbbbb');
  const c = tabOf(h, 'tab_cccccc');
  assert.equal(await drive(t, h.tabs.close('c', 'tab_aaaaaa')), a);
  assert.equal(a.closed, true);
  assert.equal(h.tabs.current('c'), c, 'the last remaining tab becomes current');
  // the close throws and the page never goes: the wait ends after CLOSE_MS and the tab is dropped anyway
  assert.equal(await drive(t, h.tabs.close('c', 'tab_bbbbbb'), { step: 500 }), b);
  assert.equal(b.closed, true);
  assert.deepEqual(
    h.tabs.list('c').map((x: any) => x.id),
    ['tab_cccccc'],
  );
  assert.match(h.tabs.state('c'), /tab_closed tab_aaaaaa; tab_closed tab_bbbbbb/);
  // a page already gone can't be named
  c.wc.destroyed = true;
  await assert.rejects(h.tabs.close('c', 'tab_cccccc'), { code: 'bad_args' });
  // a page that goes between resolving the tab and closing it: nothing to wait for
  const d = tabOf(h, 'tab_dddddd');
  const p = h.tabs.close('c', 'tab_dddddd');
  d.wc.destroyed = true;
  const start = Date.now();
  assert.equal(await drive(t, p, { step: 500 }), d);
  assert.equal(Date.now() - start, 0, 'no CLOSE_MS wait');
  assert.equal(d.closed, true);
});

test("select and mark: only the chat's own tabs; selecting shows the tab, a mark keeps it after the turn", async (t) => {
  const h = setup(t, {
    select: (tab: any) => {
      if (tab.id === 'tab_bbbbbb') throw new Error('gone');
    },
  });
  const a = tabOf(h);
  const b = tabOf(h, 'tab_bbbbbb');
  assert.equal(h.tabs.select('c', 'tab_bbbbbb'), b);
  assert.equal(h.tabs.current('c'), b);
  assert.equal(h.tabs.select('c', 'tab_aaaaaa'), a);
  assert.deepEqual(h.log.select, ['tab_bbbbbb', 'tab_aaaaaa']);
  assert.deepEqual(h.log.auto, ['tab_bbbbbb', 'tab_aaaaaa'], 'browser_tabs_select is at the agent pace');
  assert.throws(() => h.tabs.select('other', 'tab_aaaaaa'), { code: 'bad_args', message: 'No tab tab_aaaaaa in this chat.' });
  assert.throws(() => h.tabs.mark('c', 'tab_aaaaaa', 'keep'), { code: 'bad_args', message: 'status must be "deliverable" or "handoff".' });
  assert.throws(() => h.tabs.mark('c', 'tab_zzzzzz', 'deliverable'), { code: 'bad_args' });
  h.log.changes.length = 0;
  assert.equal(h.tabs.mark('c', 'tab_aaaaaa', 'deliverable'), a);
  assert.equal(a.mark, 'deliverable');
  assert.deepEqual(h.log.changes, ['c']);
  a.wc.destroy();
  assert.throws(() => h.tabs.select('c', 'tab_aaaaaa'), { code: 'bad_args' });
  assert.throws(() => h.tabs.mark('c', 'tab_aaaaaa', 'deliverable'), { code: 'bad_args' });
  assert.match(h.tabs.state('c'), /tabs: tab_bbbbbb\*$/m);
});

test('state: the current tab, every tab with its kind and mark, blocking dialogs, choosers, downloads and changes once', (t) => {
  const h = setup(t);
  assert.equal(h.tabs.state('c'), '<browser_state>\ntabs: none\n</browser_state>');
  const a = tabOf(h);
  a.wc.url = 'https://a.test/page';
  a.wc.title = 'Page A';
  const b = tabOf(h, 'tab_bbbbbb');
  b.mark = 'deliverable';
  // a tab with no address yet reads as about:blank
  b.wc.url = '';
  const popup = h.tabs.adoptPopup(a.wc, h.popupWC());
  popup.wc.url = 'https://login.test/';
  h.tabs.select('c', 'tab_aaaaaa');
  a.dialog = { type: 'confirm', message: 'Leave?' };
  b.fileChooser = { mode: 'selectSingle' };
  b.downloads.push({ name: 'done.zip', state: 'completed' });
  const s = h.tabs.state('c');
  assert.equal(
    s,
    [
      '<browser_state>',
      'current tab: tab_aaaaaa · Page A · https://a.test/page',
      `tabs: tab_aaaaaa* | tab_bbbbbb [deliverable] about:blank | ${popup.id} (popup) https://login.test/`,
      'dialog open in tab_aaaaaa: confirm "Leave?" — answer it with browser_handle_dialog',
      'file chooser open in tab_bbbbbb — use browser_file_upload, or browser_handle_dialog with accept=false to cancel',
      `changes: tab_opened ${popup.id} (popup from tab_aaaaaa; it is now the current tab)`,
      '</browser_state>',
    ].join('\n'),
  );
  assert.ok(!h.tabs.state('c').includes('changes:'), 'changes are reported once');
  a.wc.title = '';
  a.wc.url = '';
  assert.match(h.tabs.state('c'), /current tab: tab_aaaaaa · \(untitled\) · about:blank/);
  // a chat with more than 50 changes keeps the last 50
  for (let i = 0; i < 55; i++) h.tabs.change('c', `x${i}`);
  assert.match(h.tabs.state('c'), /changes: x5; x6;/);
});

/* ------------------------------------------------------------------ */
/* pane layout, painting before input and capture, remounts            */
/* ------------------------------------------------------------------ */

test('layer: a window reports how its pane lays out its own panel tabs; anything else is refused', (t) => {
  const h = setup(t);
  const wc = h.newWC();
  const tab = tabOf(h, 'tab_aaaaaa', 'c', wc, null);
  assert.equal(tab.layer, null, 'not reported yet');
  assert.equal(h.tabs.layer(wc, 'sideways', h.owner), false);
  assert.equal(h.tabs.layer(wc, 'back', { id: 2, isDestroyed: () => false }), false, 'another window');
  assert.equal(h.tabs.layer(h.popupWC(), 'front', h.owner), false, 'not a pane tab');
  assert.equal(h.tabs.layer(null, 'front', h.owner), false);
  assert.equal(tab.layer, null);
  assert.equal(h.tabs.layer(wc, 'back', h.owner), true);
  assert.equal(tab.layer, 'back');
  assert.equal(h.tabs.layer(wc, 'none', h.owner), true);
  assert.equal(tab.layer, 'none');
  assert.equal(wc.listenerCount('destroyed'), 2, 'one listener for the tab, one for its layer');
  // reported before its tab attaches: kept for it
  const early = h.newWC();
  h.tabs.layer(early, 'front', h.owner);
  assert.equal(tabOf(h, 'tab_bbbbbb', 'c', early, null).layer, 'front');
  wc.destroy();
  assert.equal(h.tabs.layers.has(wc), false, 'forgotten with its page');
});

test('remount: a pane tab whose page went (pane hidden) comes back as the same tab, keeping what the agent did with it', async (t) => {
  const h = setup(t, { attachMs: 1000 });
  const opened = await drive(t, h.tabs.create('c'));
  h.tabs.takeOver('c', opened.id);
  const original = tabOf(h, null);
  h.tabs.mark('c', original.id, 'deliverable');
  // the pane is hidden: both pages go without being closed
  opened.wc.destroy();
  original.wc.destroy();
  assert.deepEqual(h.tabs.list('c'), []);
  assert.deepEqual([...h.tabs.chats.get('c').orphans.keys()], [opened.id, '']);
  // shown again: the same pane tabs attach new pages
  const back = tabOf(h, opened.id);
  const backOriginal = tabOf(h, null);
  assert.deepEqual([back.id, back.created, back.takenOver, back.mark], [opened.id, true, true, null]);
  assert.deepEqual(
    [backOriginal.id, backOriginal.legacy, backOriginal.created, backOriginal.mark],
    [original.id, true, false, 'deliverable'],
  );
  assert.equal(h.tabs.chats.get('c').orphans.size, 0);
  // a closed tab (browser_tabs_close, the turn end) is not kept for a remount
  await drive(t, h.tabs.close('c', back.id));
  assert.equal(h.tabs.chats.get('c').orphans.size, 0);
  // a new key gets a new tab
  assert.equal(tabOf(h, 'tab_ffffff').created, false);
});

test('remount: the agent tab a turn opened is still closed at the turn end after the pane was hidden and shown again', async (t) => {
  const h = setup(t, { attachMs: 1000 });
  const opened = await drive(t, h.tabs.create('c'));
  await drive(t, h.tabs.ready(opened, 'c'));
  opened.wc.destroy();
  const back = tabOf(h, opened.id);
  assert.equal(back.created, true);
  assert.equal(back.used, opened.used, 'when the agent last used it carries over');
  // the agent finished on another tab it opened: that one stays as the result
  const later = await drive(t, h.tabs.create('c'));
  const result = await drive(t, h.tabs.turnEnded('c'));
  assert.deepEqual(result, { closed: [opened.id], kept: [later.id] });
  assert.equal(back.closed, true);
  assert.deepEqual(h.log.close, [opened.id]);
});

test('turnEnded: an agent tab whose page is gone (pane still hidden) is closed in the pane; marked or taken over ones are kept', async (t) => {
  const closed: string[] = [];
  const h = setup(t, {
    attachMs: 1000,
    close: (tab: any) => {
      closed.push(tab.id);
      if (tab.id === 'tab_bad000') throw new Error('window gone');
      setTimeout(() => tab.wc.destroy(), 5);
    },
  });
  const opened = await drive(t, h.tabs.create('c'));
  const marked = await drive(t, h.tabs.create('c'));
  h.tabs.mark('c', marked.id, 'handoff');
  const taken = await drive(t, h.tabs.create('c'));
  h.tabs.takeOver('c', taken.id);
  const failing = tabOf(h, 'tab_bad000');
  failing.created = true;
  for (const tab of [opened, marked, taken, failing]) tab.wc.destroy();
  const result = await drive(t, h.tabs.turnEnded('c'));
  assert.deepEqual(result, { closed: [opened.id, failing.id], kept: [] });
  assert.deepEqual(closed, [opened.id, failing.id], 'the pane drops the gone tabs the agent opened; a failing close is ignored');
  const orphans = h.tabs.chats.get('c').orphans;
  assert.deepEqual([...orphans.keys()], [marked.id, taken.id]);
  assert.deepEqual([orphans.get(marked.id).created, orphans.get(taken.id).created, orphans.get(taken.id).takenOver], [false, false, false]);
  // shown again after the turn: an ordinary tab with its mark
  const back = tabOf(h, marked.id);
  assert.deepEqual([back.created, back.mark], [false, 'handoff']);
});

test('remount: at most 16 gone tabs are kept per chat, the oldest dropped first', (t) => {
  const h = setup(t);
  const tabs = Array.from({ length: 17 }, (_, i) => tabOf(h, `tab_${String(i).padStart(6, '0')}`));
  for (const tab of tabs) tab.wc.destroy();
  const keys = [...h.tabs.chats.get('c').orphans.keys()];
  assert.equal(keys.length, 16);
  assert.equal(keys[0], 'tab_000001');
  // the same tab going again is kept once, as the newest
  tabOf(h, 'tab_000005').wc.destroy();
  assert.equal([...h.tabs.chats.get('c').orphans.keys()].at(-1), 'tab_000005');
  assert.equal(h.tabs.chats.get('c').orphans.size, 16);
});

test('the host-tabs facade retains the extracted activity and reveal function identities', () => {
  const load = createRequire(import.meta.url);
  const facade = load('../electron/capabilities/browser/hostTabs.cjs');
  const state = load('../electron/capabilities/browser/hostTabState.cjs');
  assert.equal(facade.reveal, state.reveal);
  assert.equal(facade.used, state.used);
});

test("auto: the turn's result comes forward at the agent's pace; a page shown for input to a hidden <webview> is not", async (t) => {
  const h = setup(t, { attachMs: 1000 });
  const opened = await drive(t, h.tabs.create('c'));
  await drive(t, h.tabs.ready(opened, 'c'));
  h.log.select.length = 0;
  h.log.auto.length = 0;
  await drive(t, h.tabs.turnEnded('c'));
  assert.deepEqual(h.log.select, [opened.id]);
  assert.deepEqual(h.log.auto, [opened.id], 'a pane the user closed on it stays closed');
  // input to a page the pane does not lay out: revealed (automatic), then asked to show it (not automatic)
  const hidden = tabOf(h, 'tab_cccccc', 'c', h.newWC(), 'none');
  h.log.select.length = 0;
  h.log.auto.length = 0;
  const p = h.tabs.ready(hidden, 'c', { input: true });
  setTimeout(() => h.tabs.layer(hidden.wc, 'back', h.owner), 120);
  await drive(t, p);
  assert.deepEqual(h.log.select, ['tab_cccccc', 'tab_cccccc']);
  assert.deepEqual(h.log.auto, ['tab_cccccc']);
});
