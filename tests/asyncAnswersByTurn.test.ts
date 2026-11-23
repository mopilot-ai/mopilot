// Question ownership follows immutable item arrays while each projection reads the current submitted answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asyncAnswersByTurn, submittedAsyncAnswers } from '../src/lib/asyncQuestions.ts';

const ask = (id: string, title = 'Colour?') => ({ id, type: 'agentMessage', text: '', questions: [{ title, options: null }] }) as any;
const reply = (id: string, text: string) => ({ id, type: 'agentMessage', text }) as any;
const user = (id: string, text: string) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] }) as any;
const turn = (id: string, items: any[]) => ({ id, items });

test('a streamed delta never scans unchanged historical items again', () => {
  let reads = 0;
  const history = Array.from({ length: 20 }, (_, t) =>
    turn(
      `t${t}`,
      Array.from({ length: 50 }, (_, i) => ({
        id: `i${i}`,
        get type() {
          reads++;
          return 'commandExecution';
        },
      })),
    ),
  );
  const first = asyncAnswersByTurn([...history, turn('live', [reply('r', 'A')])], new Map());
  assert.equal(reads, 1000);
  reads = 0;
  const next = asyncAnswersByTurn([...history, turn('live', [reply('r', 'AB')])], new Map(), first);
  assert.equal(reads, 0);
  assert.equal(next.get('t0'), first.get('t0'));
  assert.equal(next.get('live'), first.get('live'));
});

test('question answers arriving, changing or disappearing invalidate only their own map', () => {
  const turns = [turn('first', [ask('q1'), ask('q2', 'Size?')]), turn('second', [ask('q3')]), turn('empty', [])];
  const unanswered = asyncAnswersByTurn(turns, new Map());
  assert.equal(unanswered.get('first'), unanswered.get('empty'));
  const answers = new Map([
    ['q1', { 0: 'Blue' }],
    ['q3', { 0: 'Red' }],
  ]);
  const answered = asyncAnswersByTurn(turns, answers, unanswered);
  assert.deepEqual([...answered.get('first')!], [['q1', { 0: 'Blue' }]]);
  assert.notEqual(answered.get('first'), unanswered.get('first'));
  const equal = asyncAnswersByTurn(turns, structuredClone(answers), answered);
  assert.equal(equal.get('first'), answered.get('first'));
  assert.equal(equal.get('second'), answered.get('second'));
  answers.set('q2', { 0: 'Large' });
  const added = asyncAnswersByTurn(turns, answers, equal);
  assert.notEqual(added.get('first'), equal.get('first'));
  assert.equal(added.get('second'), equal.get('second'));
  answers.set('q1', { 0: 'Green' });
  const changed = asyncAnswersByTurn(turns, answers, added);
  assert.deepEqual(changed.get('first')!.get('q1'), { 0: 'Green' });
  assert.notEqual(changed.get('first'), added.get('first'));
  answers.delete('q1');
  answers.delete('q2');
  const removed = asyncAnswersByTurn(turns, answers, changed);
  assert.equal(removed.get('first'), removed.get('empty'));
  assert.equal(removed.get('second'), changed.get('second'));
});

test('replacing an item array adds, removes and replaces questions even at the same length and IDs', () => {
  const answers = new Map([
    ['q', { 0: 'Blue' }],
    ['q2', { 0: 'Large' }],
  ]);
  const original = turn('same', [reply('q', 'No question')]);
  let before = asyncAnswersByTurn([original], answers);
  const question = turn('same', [ask('q')]);
  before = asyncAnswersByTurn([question], answers, before);
  assert.deepEqual([...before.get('same')!], [['q', { 0: 'Blue' }]]);
  const replaced = turn('same', [ask('q2')]);
  before = asyncAnswersByTurn([replaced], answers, before);
  assert.deepEqual([...before.get('same')!], [['q2', { 0: 'Large' }]]);
  before = asyncAnswersByTurn([turn('same', [{ ...ask('q2'), questions: [] }])], answers, before);
  assert.equal(before.get('same')!.size, 0);
  assert.equal(asyncAnswersByTurn([], answers, before).size, 0);
});

test('a new turn wrapper can reuse an unchanged item array without rescanning it', () => {
  let reads = 0;
  const items = [
    {
      id: 'q',
      questions: [{ title: 'Colour?', options: null }],
      get type() {
        reads++;
        return 'agentMessage';
      },
    },
  ] as any[];
  const answers = new Map([['q', { 0: 'Blue' }]]);
  const first = asyncAnswersByTurn([turn('pending', items)], answers);
  assert.equal(reads, 1);
  reads = 0;
  const next = asyncAnswersByTurn([turn('persisted', items)], answers, first);
  assert.equal(reads, 0);
  assert.deepEqual([...next.get('persisted')!], [['q', { 0: 'Blue' }]]);
  assert.equal(next.has('pending'), false);
});

test('distinct chats with reused turn and item IDs never reuse another item array’s question list', () => {
  const id = 'turn\n"\\';
  const answers = new Map([['q', { 0: 'Blue' }]]);
  const chatA = [turn(id, [ask('q')])];
  const chatB = [turn(id, [reply('q', 'No question')])];
  const a = asyncAnswersByTurn(chatA, answers);
  const b = asyncAnswersByTurn(chatB, answers, a);
  assert.equal(b.get(id)!.size, 0);
  assert.deepEqual([...asyncAnswersByTurn(chatA, answers, b).get(id)!], [['q', { 0: 'Blue' }]]);
});

test('history projection still recovers later answers after pagination, edits and reorder', () => {
  const question = turn('question', [ask('q')]);
  const answer = turn('answer', [user('u', 'Colour?\nBlue')]);
  const streaming = (text: string) => turn('live', [reply('r', text)]);
  const tail = [answer, streaming('A')];
  const initial = asyncAnswersByTurn(tail, submittedAsyncAnswers(tail));
  const history = [question, ...tail];
  const loaded = asyncAnswersByTurn(history, submittedAsyncAnswers(history), initial);
  assert.deepEqual(loaded.get('question')!.get('q'), { 0: 'Blue' });
  const edited = [question, turn('answer', [user('u', 'Colour?\nRed')]), streaming('AB')];
  const next = asyncAnswersByTurn(edited, submittedAsyncAnswers(edited), loaded);
  assert.deepEqual(next.get('question')!.get('q'), { 0: 'Red' });
  const reordered = [answer, question, streaming('ABC')];
  assert.equal(asyncAnswersByTurn(reordered, submittedAsyncAnswers(reordered), next).get('question')!.size, 0);
  assert.deepEqual(asyncAnswersByTurn(history, submittedAsyncAnswers(history)), loaded);
});
