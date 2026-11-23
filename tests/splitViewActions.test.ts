// What split view's UI asks of the store (src/store/splitView.ts) and how a click opens a chat (src/session/openChat.ts):
// a pane only where the window has room (and why not, said), moving and closing panes, ⌃] / ⌃[ cycling the focus to
// the next pane's composer, and ⌥-click / ⌘-click.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, resetAll } from './support/store-harness.ts';

const { store, resetState } = await loadStore();
const S = store;
const SV = await import('../src/store/splitView.ts');
const { openChat, openChatFrom, openChatWhere } = await import('../src/session/openChat.ts');
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const chats = () => st().split.panes.map((p) => p.chatId);
const toasts = () => st().toasts.map((t) => t.text);

beforeEach(() => {
  resetState();
  resetAll();
  SV.setSplitRoom(3);
  set({
    route: { name: 'thread', id: 'p' },
    threads: Object.fromEntries(['p', 'a', 'b', 'c', 'd'].map((id) => [id, { id, cwd: `/w/${id}` } as any])),
    runtime: Object.fromEntries(['p', 'a', 'b', 'c', 'd'].map((id) => [id, { loaded: true, turns: [] } as any])),
  });
});

test('openInSplit: a pane while the window has room; without room it says why and changes nothing', () => {
  SV.setSplitRoom(1);
  assert.equal(SV.openInSplit('a'), 'opened');
  assert.equal(SV.openInSplit('b'), 'full');
  assert.deepEqual(chats(), ['a']);
  assert.deepEqual(toasts(), [SV.NO_ROOM]);
  // a chat on screen already takes the focus, room or not
  SV.applySplitOp({ op: 'focus', target: 'primary' });
  assert.equal(SV.openInSplit('a'), 'visible');
  assert.equal(st().split.focus, 'a');
  assert.equal(SV.openInSplit('p'), 'visible');
  assert.equal(st().split.focus, 'primary');
});

test('openInSplit: past the layout’s cap the user hears how many split view shows', () => {
  for (const id of ['a', 'b', 'c']) assert.equal(SV.openInSplit(id), 'opened');
  assert.equal(SV.openInSplit('d'), 'full');
  assert.deepEqual(toasts(), [SV.SPLIT_FULL]);
  assert.equal(SV.SPLIT_FULL, 'Split view shows up to 4 chats');
  // the room was measured as larger than the cap: the layout's own refusal says the same
  SV.setSplitRoom(9);
  assert.equal(SV.openInSplit('d'), 'full');
  assert.deepEqual(toasts(), [SV.SPLIT_FULL, SV.SPLIT_FULL]);
});

test('moveSplitPane: one place left or right; the ends and an unknown chat stay', () => {
  for (const id of ['a', 'b', 'c']) SV.openInSplit(id);
  assert.equal(SV.moveSplitPane('a', 1), 'moved');
  assert.deepEqual(chats(), ['b', 'a', 'c']);
  assert.equal(SV.moveSplitPane('b', -1), 'invalid');
  assert.equal(SV.moveSplitPane('c', 1), 'invalid');
  assert.equal(SV.moveSplitPane('z', 1), 'missing');
  assert.deepEqual(chats(), ['b', 'a', 'c']);
});

test('cycleSplitFocus: ⌃] and ⌃[ go round the panes and hand the keyboard to the next one’s composer', () => {
  const focused: (string | null)[] = [];
  const listen = (e: Event) => focused.push((e as CustomEvent<{ threadId: string } | undefined>).detail?.threadId ?? null);
  window.addEventListener('focus-composer', listen);
  try {
    assert.equal(SV.cycleSplitFocus(1), false, 'one pane: nothing to cycle');
    SV.openInSplit('a');
    SV.openInSplit('b');
    assert.equal(st().split.focus, 'b');
    assert.equal(SV.cycleSplitFocus(1), true);
    assert.equal(st().split.focus, 'primary', 'wraps to the primary pane');
    assert.equal(SV.cycleSplitFocus(1), true);
    assert.equal(st().split.focus, 'a');
    assert.equal(SV.cycleSplitFocus(-1), true);
    assert.equal(st().split.focus, 'primary');
    assert.deepEqual(focused, ['p', 'a', 'p']);
    // the primary pane on a page with no chat: the untargeted focus reaches the main composer (home's)
    set({ route: { name: 'home' } });
    SV.cycleSplitFocus(-1);
    SV.cycleSplitFocus(1);
    assert.equal(st().split.focus, 'primary');
    assert.equal(focused.at(-1), null);
  } finally {
    window.removeEventListener('focus-composer', listen);
  }
});

test('closeFocusedSplit: ⌃⌘W closes the focused split pane, never the primary one', () => {
  SV.openInSplit('a');
  SV.openInSplit('b');
  assert.equal(SV.closeFocusedSplit(), true);
  assert.deepEqual(chats(), ['a']);
  assert.equal(st().split.focus, 'primary');
  assert.equal(SV.closeFocusedSplit(), false);
  assert.deepEqual(chats(), ['a']);
});

test('openChatWhere: ⌥ is split view, ⌘ on macOS (Ctrl elsewhere) a new window, a plain click here', () => {
  const e = (o: Partial<{ altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...o,
  });
  assert.equal(openChatWhere(e(), true), 'here');
  assert.equal(openChatWhere(e({ altKey: true }), true), 'split');
  assert.equal(openChatWhere(e({ altKey: true, metaKey: true }), true), 'split');
  assert.equal(openChatWhere(e({ metaKey: true }), true), 'window');
  assert.equal(openChatWhere(e({ ctrlKey: true }), true), 'here', 'Ctrl-click on macOS is the context menu');
  assert.equal(openChatWhere(e({ ctrlKey: true }), false), 'window');
});

test('openChat: here navigates, split opens a pane, window opens a window of its own', async () => {
  openChat('a', 'here');
  assert.deepEqual(st().route, { name: 'thread', id: 'a' });
  openChatFrom({ altKey: true, metaKey: false, ctrlKey: false }, 'b');
  assert.deepEqual(chats(), ['b']);
  openChat('c', 'window');
  assert.deepEqual(callsOf('win.open').at(-1), ['thread=c']);
  // a window that couldn't open is noted, not thrown
  const { impl } = await import('./support/store-harness.ts');
  impl['win.open'] = () => Promise.reject(new Error('no window'));
  openChat('d', 'window');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(chats(), ['b']);
});

test('conversation clicks refuse implicit new windows while keeping plain clicks and Option splits', () => {
  for (const modifiers of [{}, { metaKey: true }, { ctrlKey: true }, { metaKey: true, ctrlKey: true }]) {
    openChatFrom({ altKey: false, metaKey: false, ctrlKey: false, ...modifiers }, 'a', { newWindow: false });
    assert.deepEqual(st().route, { name: 'thread', id: 'a' });
  }
  openChatFrom({ altKey: true, metaKey: true, ctrlKey: true }, 'b', { newWindow: false });
  assert.deepEqual(chats(), ['b']);
  assert.deepEqual(callsOf('win.open'), []);
  // The list/menu policy can still explicitly choose a new window.
  openChatFrom({ altKey: false, metaKey: true, ctrlKey: false }, 'c', { newWindow: true });
  assert.deepEqual(callsOf('win.open'), [['thread=c']]);
});
