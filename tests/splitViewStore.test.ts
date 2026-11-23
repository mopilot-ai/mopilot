// Split view in the real store (src/store/splitView.ts, panes.ts, chatPanes.ts): ops applied to the current state, the
// side pane following the focused pane, navigation that never shows a chat twice, a chat replaced or retired in place,
// and every visible chat counting as seen.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, resetAll, flush, deleteReceipt } from './support/store-harness.ts';

const { store, resetState } = await loadStore();
const S = store;
const SV = await import('../src/store/splitView.ts');
const { onScreenNow } = await import('../src/store/notifications.ts');
const { windowView } = await import('../src/store/boot.ts');
const { acceptChatDeletion } = await import('../src/store/deletionReceipts.ts');
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const thread = (id: string) => ({ name: 'thread' as const, id });
const chats = () => st().split.panes.map((p) => p.chatId);

beforeEach(() => {
  resetState();
  resetAll();
  set({
    route: thread('p'),
    threads: Object.fromEntries(['p', 'a', 'b', 'c'].map((id) => [id, { id, cwd: `/w/${id}` } as any])),
    runtime: Object.fromEntries(['p', 'a', 'b', 'c'].map((id) => [id, { loaded: true, turns: [] } as any])),
  });
});

test('an op applies to the layout as the store has it, and a chat that comes on screen is opened', () => {
  set({ unread: { a: true } });
  assert.equal(SV.applySplitOp({ op: 'open', chatId: 'a' }), 'opened');
  assert.deepEqual(chats(), ['a']);
  assert.equal(st().split.focus, 'a');
  // openThread ran for it: its unread mark is gone
  assert.equal(st().unread.a, false);
  // a no-op leaves the layout and the side pane alone
  const { split, chatPanes } = st();
  assert.equal(SV.applySplitOp({ op: 'open', chatId: 'a', by: 'p' }), 'visible');
  assert.strictEqual(st().split, split);
  assert.strictEqual(st().chatPanes, chatPanes);
  set({ unread: { b: true } });
  assert.equal(SV.applySplitOp({ op: 'replace', chatId: 'a', next: 'b' }), 'replaced');
  assert.deepEqual(chats(), ['b']);
  assert.equal(st().unread.b, false);
});

test('the side pane follows the focused pane: each chat keeps its own tabs as focus moves', () => {
  const side = { id: 'side-p', kind: 'chat', threadId: 'sp', sourceChatId: 'p' } as any;
  set({ paneTabs: [side], paneActive: 'side-p', diffPanel: { open: true } });
  SV.applySplitOp({ op: 'open', chatId: 'a' });
  // the primary's side chat is parked with it; the focused pane's chat has none yet
  assert.deepEqual(st().paneTabs, []);
  assert.deepEqual(st().chatPanes.p.tabs, [side]);
  SV.applySplitOp({ op: 'focus', target: 'primary' });
  assert.deepEqual(st().paneTabs, [side]);
  assert.equal(st().diffPanel.open, true);
});

test('navigation promotes a split chat; selecting the primary focuses it without adding history', () => {
  SV.applySplitOp({ op: 'open', chatId: 'a' });
  SV.applySplitOp({ op: 'focus', target: 'primary' });
  const back = st().back;
  S.navigate(thread('a'));
  assert.deepEqual(st().route, thread('a'));
  assert.deepEqual(chats(), []);
  assert.equal(st().split.focus, 'primary');
  assert.deepEqual(st().back, [...back, thread('p')]);
  // already in the primary pane: nothing changes
  const before = st();
  S.navigate(thread('a'));
  assert.strictEqual(st(), before);
  SV.applySplitOp({ op: 'open', chatId: 'p' });
  const history = st().back;
  S.navigate(thread('a'));
  assert.equal(st().split.focus, 'primary');
  assert.strictEqual(st().back, history);
  const again = st();
  S.navigate(thread('a'));
  assert.strictEqual(st(), again);
  SV.applySplitOp({ op: 'focus', target: 'p' });
  S.navigate(thread('b'));
  assert.deepEqual(st().route, thread('b'));
  assert.equal(st().split.focus, 'primary');
  assert.deepEqual(chats(), ['p']);
  assert.deepEqual(st().back.at(-1), thread('a'));
});

test('history never shows a chat twice: going back or forward to a chat in a split pane takes it out of the pane', () => {
  S.navigate(thread('b'));
  SV.applySplitOp({ op: 'open', chatId: 'p' });
  assert.equal(st().split.focus, 'p');
  S.goBack();
  assert.deepEqual(st().route, thread('p'));
  assert.deepEqual(chats(), []);
  assert.equal(st().split.focus, 'primary');
  SV.applySplitOp({ op: 'open', chatId: 'b' });
  S.goForward();
  assert.deepEqual(st().route, thread('b'));
  assert.deepEqual(chats(), []);
  // a page in history leaves the panes as they are, and focuses the primary
  SV.applySplitOp({ op: 'open', chatId: 'a' });
  set({ back: [...st().back, { name: 'settings' }] });
  S.goBack();
  assert.deepEqual(st().route, { name: 'settings' });
  assert.deepEqual(chats(), ['a']);
  assert.equal(st().split.focus, 'primary');
});

test("A3: a harness switch puts the new chat in the old one's pane; anywhere else it opens in the primary pane", () => {
  SV.applySplitOp({ op: 'open', chatId: 'a' });
  SV.replaceChatInView('a', 'a2');
  assert.deepEqual(chats(), ['a2']);
  assert.equal(st().split.focus, 'a2');
  assert.deepEqual(st().route, thread('p'));
  SV.replaceChatInView('p', 'p2');
  assert.deepEqual(st().route, thread('p2'));
  assert.equal(st().split.focus, 'primary');
  // the chat left the screen while the switch ran: the new one opens in the primary pane, as before split view
  SV.replaceChatInView('gone', 'g2');
  assert.deepEqual(st().route, thread('g2'));
  assert.deepEqual(chats(), ['a2']);
});

test('A3: a chat that is archived or deleted leaves every pane: a split pane closes, the primary goes home', async () => {
  SV.applySplitOp({ op: 'open', chatId: 'a' });
  SV.applySplitOp({ op: 'open', chatId: 'b', by: 'p' });
  SV.retireChatFromView('a');
  assert.deepEqual(chats(), ['b']);
  assert.equal(st().split.focus, 'primary');
  assert.deepEqual(st().route, thread('p'));
  SV.retireChatFromView('p');
  assert.deepEqual(st().route, { name: 'home' });
  // a deletion receipt (from this window or another) closes the pane even though an agent opened it
  acceptChatDeletion(deleteReceipt('b'));
  assert.deepEqual(chats(), []);
  // archiving the chat a split pane shows closes that pane
  S.navigate(thread('p'));
  SV.applySplitOp({ op: 'open', chatId: 'c' });
  await S.archiveThread('c');
  await flush();
  assert.deepEqual(chats(), []);
  assert.deepEqual(st().route, thread('p'));
});

test('every chat a pane shows is on screen, seen and reported to main; the focused one is the current chat', async () => {
  SV.applySplitOp({ op: 'open', chatId: 'a' });
  set({
    paneTabs: [
      { id: 's', kind: 'chat', threadId: 'side' },
      { id: 'b', kind: 'browser' },
    ],
  });
  // a tab that is no chat adds none
  assert.deepEqual([...onScreenNow()].filter(Boolean).sort(), ['a', 'p', 'side']);
  assert.deepEqual(windowView(st()), { visible: ['p', 'a'], primary: 'p', focused: 'a' });
  // home in the primary pane with a side chat in front: the side chat counts, as before split view
  set({ route: { name: 'home' }, paneActive: 's', diffPanel: { open: true } });
  assert.deepEqual(windowView(st()), { visible: ['side', 'a'], primary: 'side', focused: 'a' });
  SV.applySplitOp({ op: 'focus', target: 'primary' });
  set({ paneTabs: [{ id: 's', kind: 'chat', threadId: 'side' }], paneActive: 's', diffPanel: { open: true } });
  assert.deepEqual(windowView(st()), { visible: ['side', 'a'], primary: 'side', focused: 'side' });
  set({ paneTabs: [{ id: 's', kind: 'chat', threadId: 'a' }] });
  assert.deepEqual(windowView(st()), { visible: ['a'], primary: 'a', focused: 'a' });
  // a chat in an unfocused split pane notifies as one in view
  set({ route: thread('p'), focused: true });
  S.notify('turn', 'a', { title: 'x' } as any);
  await flush();
  assert.equal(callsOf('app.notify').at(-1)?.[2].viewing, true);
});

test('pane tabs the user opens belong to the focused chat, and a side chat started there stays with it', () => {
  SV.applySplitOp({ op: 'open', chatId: 'a' });
  S.openPaneTab('terminal', { cwd: '/w/a' });
  assert.equal(st().paneTabs.at(-1)?.ownerChat, 'a');
  S.openPaneTab('chat', { threadId: 'side-a' });
  assert.equal(st().paneTabs.at(-1)?.sourceChatId, 'a');
  // home in the primary pane, focused: a tab there belongs to no chat
  S.navigate({ name: 'home' });
  S.openPaneTab('terminal', { cwd: '/w' });
  assert.equal(st().paneTabs.at(-1)?.ownerChat, undefined);
});
