// This window's answers to main's window tools (src/lib/windowLayout.ts): the asking chat must be on screen here, an
// agent's pane opens beside the others without taking the focus, "focus" waits while the user types, an agent closes
// only panes it opened, and the layout is described from the asking chat's side.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, listeners, resetAll } from './support/store-harness.ts';

const { store, resetState } = await loadStore();
const SV = await import('../src/store/splitView.ts');
const { answerLayout, describeLayout, layoutRequest, startWindowLayout, userTyping } = await import('../src/store/windowLayout.ts');
const st = () => store.useStore.getState();
const panes = () => st().split.panes.map((p) => [p.chatId, p.openedBy ?? null]);
const notTyping = () => false;

beforeEach(() => {
  resetState();
  resetAll();
  SV.setSplitRoom(3);
  store.useStore.setState({
    route: { name: 'thread', id: 'top' },
    threads: Object.fromEntries(['top', 'kid', 'kid2', 'mine'].map((id) => [id, { id, cwd: `/w/${id}` } as any])),
    runtime: Object.fromEntries(['top', 'kid', 'kid2', 'mine'].map((id) => [id, { loaded: true, turns: [] } as any])),
  });
});

test('layoutRequest: only what main sends; anything else is no request', () => {
  assert.deepEqual(layoutRequest({ op: 'split', caller: 'top', chatId: 'kid' }), { op: 'split', caller: 'top', chatId: 'kid' });
  assert.deepEqual(layoutRequest({ op: 'close', caller: 'top', chatId: null }), { op: 'close', caller: 'top', chatId: null });
  assert.deepEqual(layoutRequest({ op: 'layout', caller: 'top' }), { op: 'layout', caller: 'top', chatId: null });
  for (const bad of [
    null,
    'split',
    { op: 'delete', caller: 'top', chatId: 'kid' },
    { op: 'split', caller: '', chatId: 'kid' },
    { op: 'split', caller: 7, chatId: 'kid' },
    { op: 'split', caller: 'top', chatId: null },
    { op: 'focus', caller: 'top', chatId: '' },
    { op: 'close', caller: 'top', chatId: 3 },
  ])
    assert.equal(layoutRequest(bad), null, JSON.stringify(bad));
  assert.deepEqual(answerLayout({ op: 'nope' }), { outcome: 'invalid' });
});

test('the asking chat must be on screen here, in any pane', () => {
  store.useStore.setState({ route: { name: 'home' } });
  assert.deepEqual(answerLayout({ op: 'split', caller: 'top', chatId: 'kid' }), { outcome: 'not_on_screen' });
  assert.deepEqual(panes(), []);
  // a chat in a split pane may ask too
  store.useStore.setState({ route: { name: 'thread', id: 'mine' } });
  SV.openInSplit('top');
  assert.equal(answerLayout({ op: 'split', caller: 'top', chatId: 'kid' }).outcome, 'opened');
});

test('split: an agent’s pane opens beside the others without taking the focus; on screen, full or no room changes nothing', () => {
  assert.deepEqual(answerLayout({ op: 'split', caller: 'top', chatId: 'kid' }), { outcome: 'opened' });
  assert.deepEqual(panes(), [['kid', 'top']]);
  assert.equal(st().split.focus, 'primary', 'the user keeps the keyboard');
  assert.deepEqual(answerLayout({ op: 'split', caller: 'top', chatId: 'kid' }), { outcome: 'visible' });
  assert.deepEqual(answerLayout({ op: 'split', caller: 'top', chatId: 'top' }), { outcome: 'visible' });
  SV.setSplitRoom(1);
  assert.deepEqual(answerLayout({ op: 'split', caller: 'top', chatId: 'kid2' }), { outcome: 'no_room' });
  SV.setSplitRoom(3);
  SV.openInSplit('kid2');
  SV.openInSplit('mine');
  assert.deepEqual(answerLayout({ op: 'split', caller: 'top', chatId: 'other' }), { outcome: 'full' });
  assert.equal(st().toasts.length, 0, 'an agent’s refusal is the model’s to tell, not a toast');
});

test('focus: the main pane shows the chat unless the user is typing', () => {
  assert.deepEqual(answerLayout({ op: 'focus', caller: 'top', chatId: 'top' }, notTyping), { outcome: 'visible' });
  assert.deepEqual(
    answerLayout({ op: 'focus', caller: 'top', chatId: 'kid' }, () => true),
    { outcome: 'busy' },
  );
  assert.deepEqual(st().route, { name: 'thread', id: 'top' });
  // a chat a split pane shows is on screen already: nothing moves, the user's focus included
  answerLayout({ op: 'split', caller: 'top', chatId: 'kid2' });
  assert.deepEqual(answerLayout({ op: 'focus', caller: 'top', chatId: 'kid2' }, notTyping), { outcome: 'visible' });
  assert.equal(st().split.focus, 'primary');
  assert.deepEqual(answerLayout({ op: 'focus', caller: 'top', chatId: 'kid' }, notTyping), { outcome: 'focused' });
  assert.deepEqual(st().route, { name: 'thread', id: 'kid' });
});

test('close: a pane this chat opened (named, or its most recent); the user’s panes and arranged ones stay', () => {
  assert.deepEqual(answerLayout({ op: 'close', caller: 'top', chatId: null }), { outcome: 'missing' });
  answerLayout({ op: 'split', caller: 'top', chatId: 'kid' });
  answerLayout({ op: 'split', caller: 'top', chatId: 'kid2' });
  SV.openInSplit('mine');
  assert.deepEqual(answerLayout({ op: 'close', caller: 'top', chatId: 'mine' }), { outcome: 'not-yours' });
  assert.deepEqual(answerLayout({ op: 'close', caller: 'top', chatId: null }), { outcome: 'closed' });
  assert.deepEqual(panes(), [
    ['kid', 'top'],
    ['mine', null],
  ]);
  // the user moved it: it is the user's now
  SV.moveSplitPane('kid', 1);
  assert.deepEqual(answerLayout({ op: 'close', caller: 'top', chatId: 'kid' }), { outcome: 'not-yours' });
  assert.deepEqual(answerLayout({ op: 'close', caller: 'top', chatId: null }), { outcome: 'missing' });
});

test('layout: the main pane, each split pane (focused, opened by the caller) and the focus', () => {
  answerLayout({ op: 'split', caller: 'top', chatId: 'kid' });
  SV.openInSplit('mine');
  assert.deepEqual(answerLayout({ op: 'layout', caller: 'top', chatId: null }), {
    outcome: 'layout',
    layout: {
      main: { session_id: 'top' },
      panes: [
        { session_id: 'kid', focused: false, opened_by_you: true },
        { session_id: 'mine', focused: true, opened_by_you: false },
      ],
      focused: 'mine',
    },
  });
  store.useStore.setState({ route: { name: 'scheduled' } });
  SV.applySplitOp({ op: 'focus', target: 'primary' });
  assert.deepEqual(describeLayout('kid'), {
    main: { page: 'scheduled' },
    panes: [{ session_id: 'mine', focused: false, opened_by_you: false }],
    focused: 'main',
  });
});

test('userTyping: a text field or the terminal holds the keyboard; a button does not', async () => {
  const { window } = await import('./support/dom.ts');
  const root = window.document.createElement('div');
  root.innerHTML =
    '<input id="i"><textarea id="t"></textarea><div contenteditable="true" id="c"></div><div class="term-view"><span id="x"></span></div><button id="b"></button>';
  window.document.body.append(root);
  try {
    for (const id of ['i', 't', 'c', 'x']) assert.equal(userTyping(root.querySelector(`#${id}`) as any), true, id);
    assert.equal(userTyping(root.querySelector('#b') as any), false);
    assert.equal(userTyping(null), false);
  } finally {
    root.remove();
  }
});

test('startWindowLayout answers each request main sends on its id', () => {
  const stop = startWindowLayout();
  listeners['layout.onRequest'](7, { op: 'split', caller: 'top', chatId: 'kid' });
  listeners['layout.onRequest'](8, { op: 'bogus' });
  assert.deepEqual(callsOf('layout.reply').slice(-2), [
    [7, { outcome: 'opened' }],
    [8, { outcome: 'invalid' }],
  ]);
  stop();
});

test('Settings hides the split panes: their chats are not on screen, so they can’t ask, and they count as unseen', async () => {
  answerLayout({ op: 'split', caller: 'top', chatId: 'kid' });
  store.useStore.setState({ route: { name: 'settings' } });
  assert.deepEqual(answerLayout({ op: 'layout', caller: 'kid', chatId: null }), { outcome: 'not_on_screen' });
  const { visibleChats, inSplitPane } = await import('../src/store/split.ts');
  assert.deepEqual(visibleChats(st()), []);
  assert.equal(inSplitPane(st(), 'kid'), false);
  // leaving Settings for that chat brings it out of its hidden pane into the main one: never shown twice
  store.navigate({ name: 'thread', id: 'kid' });
  assert.deepEqual(st().route, { name: 'thread', id: 'kid' });
  assert.deepEqual(panes(), []);
});

test('sidebar: the asking chat’s window hides or shows its sidebar, and says when it was already so', () => {
  assert.deepEqual(layoutRequest({ op: 'sidebar', caller: 'top', collapsed: true }), {
    op: 'sidebar',
    caller: 'top',
    chatId: null,
    collapsed: true,
  });
  assert.equal(layoutRequest({ op: 'sidebar', caller: 'top' }), null, 'a sidebar request says which way');
  assert.equal(layoutRequest({ op: 'sidebar', caller: 'top', collapsed: 'yes' }), null);
  store.useStore.setState({ sidebarOpen: true });
  assert.deepEqual(answerLayout({ op: 'sidebar', caller: 'top', collapsed: false }), { outcome: 'unchanged' });
  assert.deepEqual(answerLayout({ op: 'sidebar', caller: 'top', collapsed: true }), { outcome: 'collapsed' });
  assert.equal(st().sidebarOpen, false);
  assert.deepEqual(answerLayout({ op: 'sidebar', caller: 'top', collapsed: true }), { outcome: 'unchanged' });
  assert.deepEqual(answerLayout({ op: 'sidebar', caller: 'top', collapsed: false }), { outcome: 'expanded' });
  assert.equal(st().sidebarOpen, true);
  // a chat that is not on screen here changes nothing
  store.useStore.setState({ route: { name: 'home' } });
  assert.deepEqual(answerLayout({ op: 'sidebar', caller: 'top', collapsed: true }), { outcome: 'not_on_screen' });
  assert.equal(st().sidebarOpen, true);
});
