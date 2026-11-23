// This window's answers to main's pane tools (src/lib/windowPanes.ts): only for the chat whose side pane this is (on
// screen, the focused pane in split view), each pane name to its tab, a tab_id only of the caller's own tabs, close only
// the pane in front, and a terminal opened in the folder main checked.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, listeners, resetAll } from './support/store-harness.ts';

const { store, resetState } = await loadStore();
const { answerPane, isPaneRequest, paneRequest } = await import('../src/store/windowPanes.ts');
const { startWindowLayout } = await import('../src/store/windowLayout.ts');
const st = () => store.useStore.getState();
const front = () => st().paneTabs.find((t) => t.id === st().paneActive);
const show = (req: any) => answerPane({ op: 'show_pane', caller: 'top', ...req });

beforeEach(() => {
  resetState();
  resetAll();
  store.useStore.setState({
    route: { name: 'thread', id: 'top' },
    threads: { top: { id: 'top', cwd: '/w/top' } as any, kid: { id: 'kid', cwd: '/w/kid' } as any },
    paneTabs: [],
    paneActive: '',
    diffPanel: { open: false },
  });
});

test('paneRequest: only what main sends', () => {
  assert.deepEqual(paneRequest({ op: 'show_pane', caller: 'top', pane: 'file', path: '/w/top/a.ts', line: 3 }), {
    op: 'show_pane',
    caller: 'top',
    pane: 'file',
    path: '/w/top/a.ts',
    line: 3,
  });
  assert.deepEqual(paneRequest({ op: 'open_terminal', caller: 'top', cwd: '/w' }), {
    op: 'open_terminal',
    caller: 'top',
    pane: 'terminal',
    cwd: '/w',
  });
  assert.deepEqual(paneRequest({ op: 'show_pane', caller: 'top', pane: 'diff', scope: 'turn', tabId: '', line: -1 }), {
    op: 'show_pane',
    caller: 'top',
    pane: 'diff',
    scope: 'turn',
  });
  for (const bad of [
    null,
    'show_pane',
    { op: 'split', caller: 'top' },
    { op: 'show_pane', pane: 'diff' },
    { op: 'show_pane', caller: 'top', pane: 'artifact' },
    { op: 'show_pane', caller: 'top', pane: 'toString' },
    { op: 'show_pane', caller: 'top', pane: 'file' },
    { op: 'open_terminal', caller: 'top' },
    { op: 'close_terminal', caller: 'top' },
  ])
    assert.equal(paneRequest(bad), null, JSON.stringify(bad));
  assert.equal(isPaneRequest({ op: 'close_pane' }), true);
  for (const other of [null, 'x', { op: 'split' }, {}]) assert.equal(isPaneRequest(other), false);
  assert.deepEqual(answerPane({ op: 'show_pane' }), { outcome: 'invalid' });
});

test('only the chat whose side pane this is: not one off screen, nor one in an unfocused split pane', () => {
  assert.deepEqual(show({ pane: 'diff', caller: 'away' }), { outcome: 'not_on_screen' });
  store.useStore.setState({ split: { panes: [{ chatId: 'kid', weight: 1 }], focus: 'primary', primaryWeight: 1 } as any });
  assert.deepEqual(show({ pane: 'diff', caller: 'kid' }), { outcome: 'not_focused' });
  assert.equal(st().diffPanel.open, false);
  // focused, the split pane's chat owns the side pane
  store.useStore.setState({ split: { panes: [{ chatId: 'kid', weight: 1 }], focus: 'kid', primaryWeight: 1 } as any });
  assert.deepEqual(show({ pane: 'tasks', caller: 'kid' }), { outcome: 'shown' });
  assert.equal(front()?.threadId, 'kid');
});

test('show_pane opens Changes, a file, tasks', () => {
  assert.deepEqual(show({ pane: 'diff', scope: 'turn', path: 'src/a.ts' }), { outcome: 'shown' });
  assert.deepEqual(st().diffPanel, { open: true, scope: 'turn', file: 'src/a.ts' });
  assert.equal(front()?.kind, 'changes');
  show({ pane: 'diff' });
  assert.equal(st().diffPanel.scope, 'branch');
  assert.deepEqual(show({ pane: 'file', path: '/w/top/src/b.ts', line: 7 }), { outcome: 'shown' });
  assert.deepEqual(
    [front()?.kind, front()?.path, front()?.line, front()?.cwd, front()?.title],
    ['file', '/w/top/src/b.ts', 7, '/w/top', 'b.ts'],
  );
  show({ pane: 'file', path: '/w/top/c.ts' });
  assert.equal(front()?.line, undefined);
  assert.deepEqual(show({ pane: 'tasks' }), { outcome: 'shown' });
  assert.deepEqual([front()?.kind, front()?.threadId], ['tasks', 'top']);
});

test('show_pane terminal and preview: the tab named, the one in front, or the last; none says what to do', () => {
  assert.deepEqual(show({ pane: 'terminal' }), { outcome: 'no_terminal' });
  assert.deepEqual(show({ pane: 'terminal', tabId: 't1' }), { outcome: 'no_terminal' });
  assert.deepEqual(show({ pane: 'preview' }), { outcome: 'no_page' });
  store.useStore.setState({
    paneTabs: [
      { id: 't1', kind: 'terminal', ownerChat: 'top' },
      { id: 't2', kind: 'terminal', ownerChat: 'top' },
      { id: 't3', kind: 'terminal', ownerChat: 'kid' },
      { id: 'b1', kind: 'browser', agentChat: 'top', agentTab: 'tab_aaaaaa' },
      { id: 'b2', kind: 'browser', agentChat: 'top', agentTab: 'tab_bbbbbb' },
      { id: 'b3', kind: 'browser', agentChat: 'kid', agentTab: 'tab_cccccc' },
    ] as any,
  });
  assert.deepEqual(show({ pane: 'terminal', tabId: 't1' }), { outcome: 'shown' });
  assert.deepEqual([st().paneActive, st().diffPanel.open], ['t1', true]);
  assert.deepEqual(show({ pane: 'terminal', tabId: 't3' }), { outcome: 'no_tab' }, "another chat's terminal");
  show({ pane: 'terminal' });
  assert.equal(st().paneActive, 't1', 'the one in front stays');
  store.useStore.setState({ paneActive: 'b1' });
  show({ pane: 'terminal' });
  assert.equal(st().paneActive, 't2', 'else the last');
  assert.deepEqual(show({ pane: 'preview', tabId: 'tab_aaaaaa' }), { outcome: 'shown' });
  assert.equal(st().paneActive, 'b1');
  assert.deepEqual(show({ pane: 'preview', tabId: 'tab_cccccc' }), { outcome: 'no_tab' });
  show({ pane: 'preview' });
  assert.equal(st().paneActive, 'b1', 'the one in front stays');
  store.useStore.setState({ paneActive: 't1' });
  show({ pane: 'preview' });
  assert.equal(st().paneActive, 'b2', 'else the last');
  // the chat's original tab, which has no browser_* key
  store.useStore.setState({
    paneTabs: [{ id: 'b0', kind: 'browser', agentChat: 'top' }] as any,
    paneActive: '',
    diffPanel: { open: false },
  });
  assert.deepEqual(show({ pane: 'preview' }), { outcome: 'shown' });
  assert.deepEqual([st().paneActive, st().diffPanel.open], ['b0', true]);
});

test('close_pane closes only the pane in front of the kind named; open_terminal opens one in the folder', () => {
  const close = (pane: string) => answerPane({ op: 'close_pane', caller: 'top', pane });
  assert.deepEqual(close('diff'), { outcome: 'not_open' });
  show({ pane: 'file', path: '/w/top/a.ts' });
  assert.deepEqual(close('diff'), { outcome: 'not_open' });
  assert.equal(st().diffPanel.open, true);
  assert.deepEqual(close('file'), { outcome: 'closed' });
  assert.equal(st().diffPanel.open, false);
  assert.deepEqual(close('file'), { outcome: 'not_open' });
  const opened = answerPane({ op: 'open_terminal', caller: 'top', cwd: '/w/top/src' });
  assert.equal(opened.outcome, 'opened');
  assert.equal(opened.tab_id, st().paneActive);
  assert.deepEqual([front()?.kind, front()?.cwd, front()?.ownerChat, st().diffPanel.open], ['terminal', '/w/top/src', 'top', true]);
});

test('startWindowLayout answers a pane request on the window tools channel', () => {
  const stop = startWindowLayout();
  listeners['layout.onRequest'](9, { op: 'show_pane', caller: 'top', pane: 'tasks' });
  assert.deepEqual(callsOf('layout.reply').at(-1), [9, { outcome: 'shown' }]);
  stop();
});

test('close_terminal closes a terminal tab of the caller’s own view, and nothing else', () => {
  assert.deepEqual(paneRequest({ op: 'close_terminal', caller: 'top', tabId: 't1' }), {
    op: 'close_terminal',
    caller: 'top',
    pane: 'terminal',
    tabId: 't1',
  });
  const close = (tabId: string) => answerPane({ op: 'close_terminal', caller: 'top', tabId });
  const opened = answerPane({ op: 'open_terminal', caller: 'top', cwd: '/w/top' });
  show({ pane: 'file', path: '/w/top/a.ts' });
  const file = st().paneActive;
  // a file tab is not a terminal; an unknown id is no tab
  assert.deepEqual(close(file), { outcome: 'no_tab' });
  assert.deepEqual(close('nope'), { outcome: 'no_tab' });
  assert.equal(st().paneTabs.length, 2);
  assert.deepEqual(close(opened.tab_id as string), { outcome: 'closed', tab_id: opened.tab_id });
  assert.deepEqual(
    st().paneTabs.map((t) => t.id),
    [file],
  );
  // another session's view is never touched
  assert.deepEqual(answerPane({ op: 'close_terminal', caller: 'nobody', tabId: file }), { outcome: 'not_on_screen' });
});
