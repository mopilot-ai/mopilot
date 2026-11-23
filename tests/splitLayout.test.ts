// The split view layout reducer and its selectors (src/store/split.ts): every op, who owns a pane, and the focused and
// visible chats the rest of the window reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  focusedSplitChat,
  applySplit,
  focusedChat,
  focusedThread,
  focusPrimary,
  inSplitPane,
  isFocusedPane,
  MAX_SPLIT_PANES,
  NO_SPLIT,
  primaryChat,
  pruneSplitOwners,
  sameView,
  viewToken,
  visibleChats,
  type SplitLayout,
  type SplitOp,
} from '../src/store/split.ts';

const layout = (chats: string[], extra: Partial<SplitLayout> = {}): SplitLayout => ({
  ...NO_SPLIT,
  panes: chats.map((chatId) => ({ chatId, weight: 1 })),
  ...extra,
});
const run = (l: SplitLayout, op: SplitOp, primary: string | null = 'p') => applySplit(l, primary, op);
const chats = (l: SplitLayout) => l.panes.map((p) => p.chatId);
const thread = (id: string) => ({ name: 'thread' as const, id });

test('the selectors read the primary pane from the route and the focused pane from the layout', () => {
  const home = { route: { name: 'home' as const } };
  assert.equal(primaryChat(home), null);
  assert.equal(focusedChat(home), null);
  assert.deepEqual(visibleChats(home), []);
  const s = { route: thread('p'), split: layout(['a', 'b'], { focus: 'b' }) };
  assert.equal(primaryChat(s), 'p');
  assert.equal(focusedChat(s), 'b');
  assert.equal(focusedChat({ ...s, split: focusPrimary(s.split) }), 'p');
  assert.deepEqual(visibleChats(s), ['p', 'a', 'b']);
  assert.deepEqual(visibleChats({ route: { name: 'scheduled' as const }, split: layout(['a']) }), ['a'], 'a page beside split panes');
  // Settings shows its page alone: its hidden panes' chats are not on screen
  assert.deepEqual(visibleChats({ route: { name: 'settings' as const }, split: layout(['a']) }), []);
  assert.equal(inSplitPane({ route: { name: 'settings' as const }, split: layout(['a']) }, 'a'), false);
  assert.equal(inSplitPane(s, 'a'), true);
  assert.equal(inSplitPane(s, 'p'), false);
  assert.equal(inSplitPane(home, 'a'), false);
  assert.equal(focusedThread({ ...s, threads: { b: { id: 'b' } } })?.id, 'b');
  assert.equal(focusedThread({ ...s, threads: {} }), null);
  assert.equal(focusedThread({ ...home, threads: { b: { id: 'b' } } }), null);
});

test('with no split panes the one pane is focused whatever it paints; with split panes only the focused one is', () => {
  const route = thread('p');
  assert.equal(isFocusedPane({ route }, 'old'), true);
  assert.equal(isFocusedPane({ route, split: NO_SPLIT }, null), true);
  const s = { route, split: layout(['a'], { focus: 'a' }) };
  assert.equal(isFocusedPane(s, 'a'), true);
  assert.equal(isFocusedPane(s, 'p'), false);
});

test('focusPrimary keeps a layout already focused on the primary pane and fills in a missing one', () => {
  const l = layout(['a']);
  assert.strictEqual(focusPrimary(l), l);
  assert.strictEqual(focusPrimary(undefined), NO_SPLIT);
  assert.deepEqual(focusPrimary(layout(['a'], { focus: 'a' })), l);
});

test('a view token changes with a navigation or a focus change, not with anything else', () => {
  const route = thread('p');
  const a = viewToken({ route, split: layout(['x']) });
  assert.equal(sameView(a, viewToken({ route, split: layout(['x', 'y']) })), true);
  assert.equal(sameView(a, viewToken({ route })), true);
  assert.equal(sameView(a, viewToken({ route, split: layout(['x'], { focus: 'x' }) })), false);
  assert.equal(sameView(a, viewToken({ route: thread('p'), split: layout(['x']) })), false);
});

test("the user's open adds a pane where asked and focuses it; an agent's never takes focus and marks the pane its own", () => {
  const user = run(layout(['a']), { op: 'open', chatId: 'b', at: 0 });
  assert.equal(user.result, 'opened');
  assert.deepEqual(chats(user.layout), ['b', 'a']);
  assert.equal(user.layout.focus, 'b');
  assert.deepEqual(user.layout.panes[0], { chatId: 'b', weight: 1 });
  const agent = run(layout(['a']), { op: 'open', chatId: 'b', by: 'p' });
  assert.deepEqual(chats(agent.layout), ['a', 'b']);
  assert.equal(agent.layout.focus, 'primary');
  assert.equal(agent.layout.panes[1].openedBy, 'p');
  // an index past either end lands at that end
  assert.deepEqual(chats(run(layout(['a']), { op: 'open', chatId: 'b', at: 9 }).layout), ['a', 'b']);
  assert.deepEqual(chats(run(layout(['a']), { op: 'open', chatId: 'b', at: -3 }).layout), ['b', 'a']);
});

test('opening a chat already on screen shows it once: the user lands on its pane, an agent changes nothing', () => {
  const l = layout(['a']);
  const toPane = run(l, { op: 'open', chatId: 'a' });
  assert.deepEqual(toPane, { layout: { ...l, focus: 'a' }, result: 'visible' });
  const toPrimary = run(layout(['a'], { focus: 'a' }), { op: 'open', chatId: 'p' });
  assert.equal(toPrimary.result, 'visible');
  assert.equal(toPrimary.layout.focus, 'primary');
  // already focused there: the same object back
  const focused = layout(['a'], { focus: 'a' });
  assert.strictEqual(run(focused, { op: 'open', chatId: 'a' }).layout, focused);
  assert.strictEqual(run(l, { op: 'open', chatId: 'a', by: 'p' }).layout, l);
  assert.strictEqual(run(l, { op: 'open', chatId: 'p', by: 'p' }).layout, l);
});

test('no pane opens past the limit or for an empty chat id', () => {
  const full = layout(Array.from({ length: MAX_SPLIT_PANES }, (_, i) => `c${i}`));
  assert.deepEqual(run(full, { op: 'open', chatId: 'new' }), { layout: full, result: 'full' });
  assert.deepEqual(run(full, { op: 'open', chatId: '' }), { layout: full, result: 'invalid' });
});

test('close takes a pane away, moving focus to the primary pane when it had it; an agent closes only its own panes', () => {
  const l = layout(['a', 'b'], { focus: 'a' });
  const closed = run(l, { op: 'close', chatId: 'a' });
  assert.equal(closed.result, 'closed');
  assert.deepEqual(chats(closed.layout), ['b']);
  assert.equal(closed.layout.focus, 'primary');
  assert.equal(run(layout(['a', 'b'], { focus: 'b' }), { op: 'close', chatId: 'a' }).layout.focus, 'b');
  assert.deepEqual(run(l, { op: 'close', chatId: 'zz' }), { layout: l, result: 'missing' });
  // the user's pane, or another agent's, is not this agent's to close
  assert.deepEqual(run(l, { op: 'close', chatId: 'a', by: 'p' }), { layout: l, result: 'not-yours' });
  const mine = run(layout([]), { op: 'open', chatId: 'a', by: 'p' }).layout;
  assert.equal(run(mine, { op: 'close', chatId: 'a', by: 'q' }).result, 'not-yours');
  assert.deepEqual(run(mine, { op: 'close', chatId: 'a', by: 'p' }).layout, layout([]));
});

test('retire closes a pane whoever opened it, for a chat that is gone', () => {
  const mine = run(layout([]), { op: 'open', chatId: 'a', by: 'p' }).layout;
  assert.deepEqual(run(mine, { op: 'retire', chatId: 'a' }), { layout: layout([]), result: 'retired' });
  assert.equal(run(mine, { op: 'retire', chatId: 'b' }).result, 'missing');
});

test("replace shows another chat in a pane, keeps its weight and focus, and makes it the user's", () => {
  const opened = run(layout([], { focus: 'primary' }), { op: 'open', chatId: 'a', by: 'p' }).layout;
  const l = { ...opened, panes: [{ ...opened.panes[0], weight: 2 }], focus: 'a' };
  const r = run(l, { op: 'replace', chatId: 'a', next: 'b' });
  assert.equal(r.result, 'replaced');
  assert.deepEqual(r.layout.panes, [{ chatId: 'b', weight: 2 }]);
  assert.equal(r.layout.focus, 'b');
  assert.equal(run(layout(['a', 'c']), { op: 'replace', chatId: 'a', next: 'b' }).layout.focus, 'primary');
  assert.equal(run(l, { op: 'replace', chatId: 'zz', next: 'b' }).result, 'missing');
  assert.equal(run(l, { op: 'replace', chatId: 'a', next: '' }).result, 'invalid');
  assert.equal(run(l, { op: 'replace', chatId: 'a', next: 'a' }).result, 'invalid');
  // a chat on screen already is never shown twice
  assert.strictEqual(run(l, { op: 'replace', chatId: 'a', next: 'p' }).layout, l);
  assert.equal(run(layout(['a', 'c']), { op: 'replace', chatId: 'a', next: 'c' }).result, 'visible');
});

test("move and swap rearrange panes by chat id and make the panes they touch the user's", () => {
  const agentPane = { chatId: 'a', weight: 1, openedBy: 'p' };
  const l: SplitLayout = { ...NO_SPLIT, panes: [agentPane, { chatId: 'b', weight: 1 }, { chatId: 'c', weight: 1 }] };
  const moved = run(l, { op: 'move', chatId: 'a', to: 2 });
  assert.equal(moved.result, 'moved');
  assert.deepEqual(moved.layout.panes, [
    { chatId: 'b', weight: 1 },
    { chatId: 'c', weight: 1 },
    { chatId: 'a', weight: 1 },
  ]);
  assert.deepEqual(chats(run(l, { op: 'move', chatId: 'c', to: 0 }).layout), ['c', 'a', 'b']);
  // a pane the user never touched stays as it is
  assert.strictEqual(run(l, { op: 'move', chatId: 'b', to: 2 }).layout.panes[0], agentPane);
  assert.equal(run(l, { op: 'move', chatId: 'zz', to: 0 }).result, 'missing');
  for (const to of [-1, 3, 1.5, Number.NaN]) assert.equal(run(l, { op: 'move', chatId: 'a', to }).result, 'invalid');
  const swapped = run(l, { op: 'swap', a: 'a', b: 'c' });
  assert.equal(swapped.result, 'swapped');
  assert.deepEqual(swapped.layout.panes, [
    { chatId: 'c', weight: 1 },
    { chatId: 'b', weight: 1 },
    { chatId: 'a', weight: 1 },
  ]);
  assert.equal(run(l, { op: 'swap', a: 'a', b: 'zz' }).result, 'missing');
  assert.equal(run(l, { op: 'swap', a: 'zz', b: 'a' }).result, 'missing');
  assert.equal(run(l, { op: 'swap', a: 'a', b: 'a' }).result, 'invalid');
});

test('focus names the primary pane or a split pane; a chat no pane shows is missing', () => {
  const l = layout(['a']);
  assert.deepEqual(run(l, { op: 'focus', target: 'a' }), { layout: { ...l, focus: 'a' }, result: 'focused' });
  assert.strictEqual(run(l, { op: 'focus', target: 'primary' }).layout, l);
  assert.deepEqual(run(l, { op: 'focus', target: 'zz' }), { layout: l, result: 'missing' });
});

test('resize takes one positive weight per column, the primary pane first', () => {
  const l = layout(['a', 'b']);
  const r = run(l, { op: 'resize', weights: [2, 1, 0.5] });
  assert.equal(r.result, 'resized');
  assert.equal(r.layout.primaryWeight, 2);
  assert.deepEqual(
    r.layout.panes.map((p) => p.weight),
    [1, 0.5],
  );
  for (const weights of [[1, 1], [1, 1, 0], [1, 1, -1], [1, 1, Number.POSITIVE_INFINITY], [1, 1, '1'], 'nope'])
    assert.deepEqual(run(l, { op: 'resize', weights: weights as never }), { layout: l, result: 'invalid' });
});

test('an op the reducer does not know changes nothing', () => {
  const l = layout(['a']);
  assert.deepEqual(run(l, { op: 'explode' } as never), { layout: l, result: 'invalid' });
});

test('A1/W1: overlapping ops each apply to the layout as it is, in either order, and both survive', () => {
  // two agent opens settle in both orders: both panes exist and each result names its own pane
  for (const order of [
    ['x', 'y'],
    ['y', 'x'],
  ]) {
    let l = layout([]);
    for (const chatId of order) {
      const r = run(l, { op: 'open', chatId, by: 'p' });
      assert.equal(r.result, 'opened');
      assert.equal(r.layout.panes.at(-1)?.chatId, chatId);
      l = r.layout;
    }
    assert.deepEqual(chats(l).sort(), ['x', 'y']);
  }
  // the user closes b while an agent opens c, before a render
  const start = layout(['a', 'b']);
  const both = run(run(start, { op: 'close', chatId: 'b' }).layout, { op: 'open', chatId: 'c', by: 'p' }).layout;
  assert.deepEqual(chats(both), ['a', 'c']);
});

test("A2: an agent closing a pane the user has since replaced is refused, and the user's chat stays", () => {
  const opened = run(layout([]), { op: 'open', chatId: 'child', by: 'p' }).layout;
  const replaced = run(opened, { op: 'replace', chatId: 'child', next: 'mine' }).layout;
  assert.equal(run(replaced, { op: 'close', chatId: 'child', by: 'p' }).result, 'missing');
  assert.equal(run(replaced, { op: 'close', chatId: 'mine', by: 'p' }).result, 'not-yours');
  assert.deepEqual(chats(replaced), ['mine']);
});

test('focusedSplitChat: the focused split pane’s chat, never the primary pane’s', () => {
  const route = { name: 'thread' as const, id: 'p' };
  assert.equal(focusedSplitChat({ route }), null, 'no layout yet');
  assert.equal(focusedSplitChat({ route, split: NO_SPLIT }), null);
  assert.equal(focusedSplitChat({ route, split: { panes: [{ chatId: 'a', weight: 1 }], focus: 'a', primaryWeight: 1 } }), 'a');
});

test('owner pruning follows reversed chains, preserves the focused user pane, and removes unrooted cycles', () => {
  const l: SplitLayout = {
    ...NO_SPLIT,
    focus: 'mine',
    panes: [
      { chatId: 'grandchild', weight: 1, openedBy: 'child' },
      { chatId: 'child', weight: 2, openedBy: 'p' },
      { chatId: 'mine', weight: 3 },
    ],
  };
  assert.strictEqual(pruneSplitOwners(l, 'p'), l, 'column order cannot detach a live owner');
  assert.deepEqual(pruneSplitOwners(l, null), { ...l, panes: [l.panes[2]] });
  const cycle: SplitLayout = {
    ...NO_SPLIT,
    focus: 'a',
    panes: [
      { chatId: 'a', weight: 1, openedBy: 'b' },
      { chatId: 'b', weight: 1, openedBy: 'a' },
      { chatId: 'c', weight: 1, openedBy: 'c' },
    ],
  };
  assert.deepEqual(pruneSplitOwners(cycle, null), NO_SPLIT);
});

test('explicit user open claims only its existing agent pane, whether already focused or not', () => {
  for (const focus of ['primary', 'a']) {
    const l: SplitLayout = {
      ...NO_SPLIT,
      focus,
      panes: [
        { chatId: 'a', weight: 2, openedBy: 'p' },
        { chatId: 'b', weight: 1, openedBy: 'p' },
      ],
    };
    const opened = run(l, { op: 'open', chatId: 'a' });
    assert.equal(opened.result, 'visible');
    assert.equal(opened.layout.focus, 'a');
    assert.deepEqual(opened.layout.panes, [{ chatId: 'a', weight: 2 }, l.panes[1]]);
  }
});
