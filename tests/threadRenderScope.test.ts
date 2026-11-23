// What re-renders while chats stream: a delta renders only its own turn's view and its own chat's Priority card.
import { rendersOf, resetCommits } from './support/commitProbe.ts'; // first: React reads the hook as it loads
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render, settle, setStore, flush, T, user, reply, turn, view } from './support/thread-view/fixture.ts';
import { autoMock, stubComponent } from './support/thread-kit.ts';

// the chat rows (and the terminal they reach) have their own tests; Priority renders cards of its own
autoMock('src/components/sidebar/ThreadRow.tsx', 'row', {
  ThreadRow: stubComponent('ThreadRow'),
  DraggableChat: stubComponent('DraggableChat'),
});
const { PrioritySection } = await import('../src/components/sidebar/ChatLists.tsx');
const { keepNotedTurns } = await import('../src/components/thread/view/notedTurns.ts');

const question = (id: string) => ({ id, type: 'agentMessage', text: '', questions: [{ title: 'Pick one', options: [] }] });
const turnIds = () => rendersOf('TurnView').map((p) => p.turn.id);
const cardIds = () => rendersOf('PriorityCard').map((p) => p.id);
const runtime = (turns: any[], activeTurnId?: string) => ({ loaded: true, turns, activeTurnId });

test('a delta in the active turn renders only that turn; an answer re-renders only the turn it answers', async () => {
  const t1 = turn('t1', [user('u1', 'Ask me'), question('q1')]);
  const t2 = turn('t2', [user('u2', 'go on'), reply('r2', 'Done.')]);
  const t3 = (text: string) => turn('t3', [user('u3', 'more'), reply('r3', text)], { status: 'inProgress' });
  const show = (turns: any[], active?: string) =>
    setStore({ threads: { [T]: { id: T, cwd: '/repo' } }, runtime: { [T]: runtime(turns, active) } });
  show([t1, t2, t3('Part')], 't3');
  const v = await render(view());
  await flush();
  assert.equal(rendersOf('TurnView').find((p) => p.turn.id === 't1')!.questionAnswers.size, 0);

  resetCommits();
  await settle(() => show([t1, t2, t3('Part one')], 't3'));
  await settle(() => show([t1, t2, t3('Part one, two')], 't3'));
  assert.deepEqual(turnIds(), ['t3', 't3']);

  // the next turn answers t1's question: t1 sees its answer, t3 is no longer last, t4 mounts
  const t4 = (text: string) => turn('t4', [user('u4', 'Pick one\nBlue'), reply('r4', text)], { status: 'inProgress' });
  const done3 = { ...t3('Part one, two'), status: 'completed' };
  resetCommits();
  await settle(() => show([t1, t2, done3, t4('')], 't4'));
  assert.deepEqual(turnIds().sort(), ['t1', 't3', 't4']);
  assert.deepEqual(
    rendersOf('TurnView')
      .find((p) => p.turn.id === 't1')!
      .questionAnswers.get('q1'),
    { 0: 'Blue' },
  );
  // t4 streams: its answer is worked out again each delta, yet t1 keeps the answers it was given
  resetCommits();
  await settle(() => show([t1, t2, done3, t4('Blue it is')], 't4'));
  assert.deepEqual(turnIds(), ['t4']);
  await v.unmount();
});

test("another chat's delta renders no turn of the shown chat and no other Priority card", async () => {
  const other = 'other';
  const shown = [
    turn('s1', [user('su', 'hi'), reply('sr', 'Hello')]),
    turn('s2', [user('su2', 'next'), reply('sr2', 'Wor')], { status: 'inProgress' }),
  ];
  const otherTurns = (text: string) => [turn('o1', [user('ou', 'q'), reply('or', text)], { status: 'inProgress' })];
  setStore({
    threads: {
      [T]: { id: T, cwd: '/repo', preview: 'p' },
      [other]: { id: other, preview: 'p' },
      third: { id: 'third', preview: '*Earlier* `x`' },
    },
    runtime: { [T]: runtime(shown, 's2'), [other]: runtime(otherTurns('Thinking'), 'o1') },
    unread: { [T]: true, [other]: true, third: true },
    pending: [],
    savedProjects: [],
    route: { name: 'thread', id: T },
  });
  const thread = await render(view());
  const sidebar = await render(h(PrioritySection));
  await flush();
  const snippets = () => sidebar.$$('.priority-snippet').map((e) => e.textContent);
  assert.deepEqual(snippets(), ['Wor', 'Thinking', 'Earlier x']);
  assert.match(sidebar.$$('.priority-card')[0].className, /selected/);

  resetCommits();
  await settle(() => setStore((s: any) => ({ runtime: { ...s.runtime, [other]: runtime(otherTurns('Thinking about **it**'), 'o1') } })));
  assert.deepEqual(turnIds(), []);
  assert.deepEqual(cardIds(), [other]);
  assert.deepEqual(snippets(), ['Wor', 'Thinking about it', 'Earlier x']);

  // a store update that changes no chat's reply renders no card
  resetCommits();
  await settle(() => setStore({ elsewhere: { x: 1 } }));
  assert.deepEqual(cardIds(), []);
  // an approval shows on its own card only
  resetCommits();
  await settle(() => setStore({ pending: [{ threadId: 'third' }] }));
  assert.deepEqual(cardIds(), ['third']);
  assert.deepEqual(snippets(), ['Needs your approval', 'Wor', 'Thinking about it']);
  await thread.unmount();
  await sidebar.unmount();
});

test('merged notes keep their turn object while neither the turn nor the notes change', () => {
  const cache = new WeakMap();
  const a = { id: 'a' };
  const b = { id: 'b' };
  const notes = ['n'];
  const merge = (raw: any[]) => raw.map((t) => (t === a ? { ...t, noted: true } : t));
  const first = keepNotedTurns([a, b], merge([a, b]), notes, cache);
  const again = keepNotedTurns([a, b], merge([a, b]), notes, cache);
  assert.equal(again[0], first[0]);
  assert.equal(again[1], b);
  // new notes, or a changed turn, merge anew
  assert.notEqual(keepNotedTurns([a, b], merge([a, b]), ['m'], cache)[0], first[0]);
  const a2 = { id: 'a' };
  assert.deepEqual(keepNotedTurns([a2], [{ ...a2, noted: true }], notes, cache), [{ id: 'a', noted: true }]);
  // a merged list longer than the turns it came from keeps its extra entries as they are
  assert.deepEqual(keepNotedTurns([], [a], notes, cache), [a]);
});
