// The thread's per-turn derived lists: navigation entries, question answers and narration priors are worked out once
// per turn object, so a delta in the streaming turn recomputes only that turn's share, with the same results as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigationItems } from '../src/session/threadNavigation.ts';
import { asyncAnswersByTurn, submittedAsyncAnswers } from '../src/lib/asyncQuestions.ts';
import { turnNarrationPriors } from '../src/lib/agentNarration.ts';

const user = (id: string, text: string) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] }) as any;
const reply = (id: string, text: string) => ({ id, type: 'agentMessage', text }) as any;
const ask = (id: string, title: string) => ({ id, type: 'agentMessage', text: '', questions: [{ title, options: null }] }) as any;
const turn = (id: string, items: any[], status = 'completed') => ({ id, items, status, itemTimes: {} }) as any;
const cua = (id: string, code: string) =>
  ({ type: 'mcpToolCall', id, server: 'cua_repl', tool: 'js', arguments: { code }, status: 'completed', result: { content: [] } }) as any;

test('navigation entries are computed once per turn object and match a fresh computation', () => {
  const t1 = turn('t1', [user('u1', 'First'), reply('r1', 'One')]);
  const t2 = (text: string) => turn('t2', [user('u2', 'Second'), reply('r2', text)], 'inProgress');
  const first = navigationItems([t1, t2('Tw')]);
  const later = navigationItems([t1, t2('Two')]);
  // the finished turn's entry is the same object; the streaming turn's is new and current
  assert.equal(later[0], first[0]);
  assert.notEqual(later[1], first[1]);
  assert.equal(later[1].response, 'Two');
  assert.deepEqual(later, navigationItems([structuredClone(t1), t2('Two')]));
});

test('answers are matched across turns once per turn, and each turn keeps its own answer map', () => {
  const t1 = turn('t1', [user('u1', 'Hi'), ask('q1', 'Colour?'), ask('q2', 'Size?')]);
  const t2 = turn('t2', [user('u2', 'Colour?\nBlue')]);
  const t3 = (text: string) => turn('t3', [user('u3', 'Size?\nLarge'), reply('r3', text)], 'inProgress');
  const answers = submittedAsyncAnswers([t1, t2, t3('a')]);
  assert.deepEqual(Object.fromEntries(answers), { q1: { 0: 'Blue' }, q2: { 0: 'Large' } });
  const byTurn = asyncAnswersByTurn([t1, t2, t3('a')], answers);
  assert.deepEqual(Object.fromEntries(byTurn.get('t1')!), { q1: { 0: 'Blue' }, q2: { 0: 'Large' } });
  // turns without questions share one empty map
  assert.equal(byTurn.get('t2'), byTurn.get('t3'));
  assert.equal(byTurn.get('t2')!.size, 0);
  // the streaming turn changes: the earlier turns' steps are reused, and t1 keeps its map since its answers read the same
  const next = submittedAsyncAnswers([t1, t2, t3('ab')]);
  assert.equal(next.get('q1'), answers.get('q1'));
  assert.notEqual(next.get('q2'), answers.get('q2'));
  assert.equal(asyncAnswersByTurn([t1, t2, t3('ab')], next, byTurn).get('t1'), byTurn.get('t1'));
  // an earlier turn that changes is matched again, and so is every turn after it
  const edited = turn('t2', [user('u2', 'Colour?\nRed')]);
  const redone = submittedAsyncAnswers([t1, edited, t3('ab')]);
  assert.deepEqual(redone.get('q1'), { 0: 'Red' });
  assert.notEqual(asyncAnswersByTurn([t1, edited, t3('ab')], redone, byTurn).get('t1'), byTurn.get('t1'));
});

test('narration priors are carried turn to turn once per turn object, keeping their identity', () => {
  const t1 = turn('t1', [cua('a', "app = await cua.getApp('TextEdit');")]);
  const t2 = turn('t2', [cua('b', 'await app.click([1, 1]);')]);
  const t3 = (n: number) => turn('t3', [cua('c', `await app.click([${n}, ${n}]);`)], 'inProgress');
  const first = turnNarrationPriors([t1, t2, t3(1)]);
  const later = turnNarrationPriors([t1, t2, t3(2)]);
  assert.equal(first.get('t1')!.size, 0);
  assert.equal(later.get('t2'), first.get('t2'));
  assert.equal(later.get('t3'), first.get('t3'));
  assert.equal(later.get('t3')!.get('app')?.app, 'TextEdit');
  // a stopped turn passes on no bindings
  assert.equal(turnNarrationPriors([{ ...t1, status: 'interrupted' }, t2]).get('t2')!.size, 0);
});
