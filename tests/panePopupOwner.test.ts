// Pane tabs for pages main opened (a page's popup): which chat owns them, and whether they open the side pane.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore } from './support/store-harness.ts';

const { store, resetState } = await loadStore();
const st = () => store.useStore.getState();
const set = (patch: any) => store.useStore.setState(patch);
beforeEach(() => resetState());

test("a popup follows the side pane's view in split view: the focused pane's chat, and an agent tab's chat", () => {
  // chat "a" is primary, chat "b" is in a focused split pane: the side pane is b's
  set({
    route: { name: 'thread', id: 'a' },
    split: { panes: [{ chatId: 'b', weight: 1 }], focus: 'b', primaryWeight: 1 },
    paneTabs: [{ id: 'browser-o', kind: 'browser', ownerChat: 'b' }] as any,
    paneActive: '',
    diffPanel: { open: false } as any,
  });
  store.openBrowserViewTab({ paneId: 'browser-pop', url: 'https://idp.test/', opener: 'browser-o' });
  assert.equal(st().paneActive, 'browser-pop', "b's popup comes to the front of b's side pane");
  assert.equal(st().diffPanel.open, true);
  // a popup of an agent tab belongs to that agent's chat ("a"), not shown in b's side pane
  set({ paneTabs: [{ id: 'browser-ag', kind: 'browser', agentChat: 'a' }] as any, paneActive: '', diffPanel: { open: false } as any });
  store.openBrowserViewTab({ paneId: 'browser-pop2', url: 'https://x.test/', opener: 'browser-ag' });
  assert.equal(st().paneTabs.at(-1)?.ownerChat, 'a');
  assert.equal(st().paneActive, '');
  assert.equal(st().diffPanel.open, false);
  set({ split: undefined as any });
});

test("a page's popup belongs to its opener's chat: shown there, and mounted behind while another chat is on screen", () => {
  // the user opened a page in chat "a", then moved to chat "b"; the page opens a popup later
  set({ route: { name: 'thread', id: 'b' }, paneTabs: [{ id: 'browser-o', kind: 'browser', ownerChat: 'a' }] as any, paneActive: '' });
  set({ diffPanel: { open: false } as any });
  store.openBrowserViewTab({ paneId: 'browser-pop', url: 'https://idp.test/', opener: 'browser-o' });
  assert.deepEqual(st().paneTabs.at(-1), {
    id: 'browser-pop',
    kind: 'browser',
    url: 'https://idp.test/',
    title: 'https://idp.test/',
    ownerChat: 'a',
  });
  assert.equal(st().paneActive, '', "b's pane keeps what it showed");
  assert.equal(st().diffPanel.open, false, "b's pane stays closed");
  // again for the same popup: still behind
  store.openBrowserViewTab({ paneId: 'browser-pop', url: 'https://idp.test/', opener: 'browser-o' });
  assert.equal(st().paneTabs.length, 2);
  assert.equal(st().diffPanel.open, false);
  // on chat "a" the popup comes to the front of its pane
  set({ route: { name: 'thread', id: 'a' } });
  store.openBrowserViewTab({ paneId: 'browser-pop', url: 'https://idp.test/', opener: 'browser-o' });
  assert.equal(st().paneActive, 'browser-pop');
  assert.equal(st().diffPanel.open, true);
  // an opener with no owner (opened on the home page) gives none; an unknown opener falls back to the chat on screen
  set({ paneTabs: [{ id: 'browser-h', kind: 'browser' }] as any, diffPanel: { open: false } as any });
  store.openBrowserViewTab({ paneId: 'browser-p1', url: 'https://x.test/', opener: 'browser-h' });
  assert.equal(st().paneTabs.at(-1)?.ownerChat, undefined);
  store.openBrowserViewTab({ paneId: 'browser-p2', url: 'https://y.test/', opener: 'browser-gone' });
  assert.equal(st().paneTabs.at(-1)?.ownerChat, 'a');
  assert.equal(st().paneActive, 'browser-p2');
});
