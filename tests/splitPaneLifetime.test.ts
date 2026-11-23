// Split panes follow their visible owners, while ordinary chat navigation always opens the selected chat in the primary pane.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
const SV = await import('../src/store/splitView.ts');
const { answerLayout } = await import('../src/store/windowLayout.ts');
const { openChatFrom } = await import('../src/session/openChat.ts');
const st = () => S.useStore.getState();
const thread = (id: string) => ({ name: 'thread' as const, id });
const panes = () => st().split.panes.map((p) => p.chatId);
const select = (id: string) => openChatFrom({ altKey: false, ctrlKey: false, metaKey: false }, id);
const agentOpen = (caller: string, chatId: string) => {
  assert.equal(answerLayout({ op: 'split', caller, chatId }).outcome, 'opened');
};

beforeEach(() => {
  resetState();
  resetAll();
  SV.setSplitRoom(3);
  S.useStore.setState({
    route: thread('p'),
    runtime: Object.fromEntries(['p', 'a', 'b', 'c', 'other'].map((id) => [id, { loaded: true, turns: [] } as any])),
  });
});

test('a plain sidebar selection moves a split chat to the primary pane and preserves its input and history', () => {
  agentOpen('p', 'a');
  const draft = { text: 'unfinished reply', attachments: [] };
  S.useStore.setState({ drafts: { a: draft } });
  const runtime = st().runtime.a;
  select('a');
  assert.deepEqual(st().route, thread('a'));
  assert.deepEqual(panes(), []);
  assert.equal(st().split.focus, 'primary');
  assert.deepEqual(st().back, [thread('p')]);
  assert.strictEqual(st().drafts.a, draft);
  assert.strictEqual(st().runtime.a, runtime);
  const before = st();
  select('a');
  assert.strictEqual(st(), before, 'selecting the current chat is a no-op');
  S.goBack();
  assert.deepEqual(st().route, thread('p'));
  assert.deepEqual(panes(), [], 'history does not reopen the old split');
  S.goForward();
  assert.deepEqual(st().route, thread('a'));
});

test('I2/A3: agent panes leave with their source across harnesses, and late tool requests cannot reopen them', () => {
  for (const [source, child, next] of [
    ['codex:source', 'claude:child', 'acp:next'],
    ['claude:source', 'acp:child', 'codex:next'],
    ['acp:source', 'codex:child', 'claude:next'],
  ]) {
    S.useStore.setState({
      route: thread(source),
      runtime: Object.fromEntries([source, child, next].map((id) => [id, { loaded: true, turns: [] } as any])),
    });
    agentOpen(source, child);
    const childRuntime = st().runtime[child];
    select(next);
    assert.deepEqual(panes(), []);
    assert.equal(answerLayout({ op: 'split', caller: source, chatId: child }).outcome, 'not_on_screen');
    assert.equal(answerLayout({ op: 'split', caller: child, chatId: source }).outcome, 'not_on_screen');
    assert.strictEqual(st().runtime[child], childRuntime, 'closing layout preserves the session');
  }
});

test('navigation removes nested agent panes but retains user panes and their own agent children', () => {
  agentOpen('p', 'a');
  agentOpen('a', 'b');
  SV.openInSplit('c');
  select('other');
  assert.deepEqual(panes(), ['c']);
  agentOpen('c', 'a');
  agentOpen('a', 'b');
  select('p');
  assert.deepEqual(panes(), ['c', 'a', 'b']);
  assert.equal(st().split.focus, 'primary');
});

test('promoting an agent child keeps that child’s children and drops the old source’s other panes', () => {
  agentOpen('p', 'a');
  agentOpen('a', 'b');
  agentOpen('p', 'c');
  select('a');
  assert.deepEqual(st().route, thread('a'));
  assert.deepEqual(panes(), ['b']);
  assert.equal(st().split.panes[0].openedBy, 'a');
});

test('close, retire and replacement remove descendants of the pane that left without losing independent panes', () => {
  for (const op of [
    { op: 'close' as const, chatId: 'a' },
    { op: 'retire' as const, chatId: 'a' },
    { op: 'replace' as const, chatId: 'a', next: 'other' },
  ]) {
    resetState();
    S.useStore.setState({ route: thread('p') });
    SV.openInSplit('a');
    agentOpen('a', 'b');
    agentOpen('p', 'c');
    SV.applySplitOp({ op: 'focus', target: 'b' });
    SV.applySplitOp(op);
    assert.deepEqual(panes(), op.op === 'replace' ? ['other', 'c'] : ['c']);
    assert.equal(st().split.focus, 'primary');
  }
});

test('explicitly opening or resizing an agent pane claims it for the user; merely focusing it does not', () => {
  agentOpen('p', 'a');
  SV.applySplitOp({ op: 'focus', target: 'a' });
  assert.equal(st().split.panes[0].openedBy, 'p');
  SV.openInSplit('a');
  assert.equal(st().split.panes[0].openedBy, undefined);
  agentOpen('p', 'b');
  SV.applySplitOp({ op: 'resize', weights: [2, 1, 3] });
  assert.equal(st().split.panes[1].openedBy, undefined);
  select('other');
  assert.deepEqual(panes(), ['a', 'b']);
});

test('history and home retire agent panes, while Settings temporarily hides them until the next chat is chosen', () => {
  select('other');
  agentOpen('other', 'a');
  S.goBack();
  assert.deepEqual(panes(), []);
  agentOpen('p', 'b');
  S.goForward();
  assert.deepEqual(panes(), []);
  agentOpen('other', 'a');
  S.navigate({ name: 'settings' });
  assert.deepEqual(panes(), ['a']);
  S.leaveSettings();
  assert.deepEqual(panes(), ['a']);
  S.navigate({ name: 'settings' });
  select('p');
  assert.deepEqual(panes(), []);
  agentOpen('p', 'a');
  S.navigate({ name: 'home' });
  assert.deepEqual(panes(), []);
});

test('retiring a hidden split in Settings cleans up its descendants before redisplay and preserves other source panes', () => {
  agentOpen('p', 'a');
  agentOpen('a', 'b');
  agentOpen('p', 'c');
  S.navigate({ name: 'settings' });
  SV.retireChatFromView('a');
  assert.deepEqual(st().route, { name: 'settings' });
  S.leaveSettings();
  assert.deepEqual(st().route, thread('p'));
  assert.deepEqual(panes(), ['c']);
  assert.equal(st().split.focus, 'primary');
});

test('W1: an independent user open survives source navigation in either ordering', () => {
  for (const first of ['navigate', 'open']) {
    resetState();
    S.useStore.setState({ route: thread('p') });
    agentOpen('p', 'a');
    if (first === 'open') SV.openInSplit('b');
    select('other');
    if (first === 'navigate') SV.openInSplit('b');
    assert.deepEqual(panes(), ['b']);
  }
});
