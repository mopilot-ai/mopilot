// The questions a Host chat's agent asks, in the shape This Mac's card draws, and the answers it gives back (shared/hostAsked.mjs): bounded, every question may be answered in the person's own words unless it says not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedAnswers, askedQuestions } from '../shared/hostAsked.mjs';

test('askedQuestions: the card’s shape, with an Other answer unless the question forbids it, and nothing that cannot be asked', () => {
  const asked = askedQuestions([
    {
      id: 7,
      header: 'Lang',
      question: 'Which?',
      options: [{ label: 'JS', description: 'web' }, { label: '' }, { label: 'Rust' }, 4],
      multiSelect: true,
    },
    { id: 'b', question: 'Token?', isOther: false, isSecret: true },
    { id: 'c', question: '   ' },
    { question: 'no id' },
    null,
  ]);
  assert.deepEqual(asked, [
    {
      id: '7',
      question: 'Which?',
      header: 'Lang',
      options: [{ label: 'JS', description: 'web' }, { label: 'Rust' }],
      multiSelect: true,
      isOther: true,
      isSecret: false,
    },
    { id: 'b', question: 'Token?', header: null, options: [], multiSelect: false, isOther: false, isSecret: true },
  ]);
  assert.deepEqual(askedQuestions('x'), []);
  const many = askedQuestions(
    Array.from({ length: 40 }, (_, i) => ({ id: i, question: 'q', options: Array.from({ length: 50 }, (_, k) => ({ label: `o${k}` })) })),
  );
  assert.equal(many.length, 16);
  assert.equal(many[0].options.length, 32);
});

test('askedAnswers: the answers of the asked questions, texts only and bounded; none when there is nothing to read', () => {
  const asked = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(
    askedAnswers(asked, {
      answers: { a: { answers: ['x', 4, 'y'] }, b: { answers: 'no' }, z: { answers: ['stray'] }, c: { answers: [] } },
    }),
    { a: { answers: ['x', 'y'] }, c: { answers: [] } },
  );
  assert.equal(askedAnswers(asked, { answers: { z: { answers: ['x'] } } }), null);
  for (const content of [null, undefined, 'x', [], {}, { answers: 'x' }, { answers: [] }]) assert.equal(askedAnswers(asked, content), null);
  const long = askedAnswers(asked, { answers: { a: { answers: ['é'.repeat(5000), ...Array(40).fill('k')] } } })!;
  assert.equal(long.a.answers.length, 32);
  assert.equal(long.a.answers[0].length, 4096);
});

test('the Claude Code reply keys each answer by its question’s own place in the tool’s input, so a question left out of the asked list does not shift the others', async () => {
  const { claudeAskedReply } = await import('../host/src/claudeAsk.mjs');
  const input = { questions: [{ question: '' }, { question: 'Which DB?' }, { question: 'Which port?' }] };
  // q0 had no text and is not asked; the person answered q1 and q2
  const asked = askedQuestions([
    { id: 'q0', question: '' },
    { id: 'q1', question: 'Which DB?' },
    { id: 'q2', question: 'Which port?' },
  ]);
  const reply = claudeAskedReply(input, asked, { answers: { q1: { answers: ['pg'] }, q2: { answers: ['5432', '5433'] } } });
  assert.deepEqual(reply, { behavior: 'allow', updatedInput: { ...input, answers: { 'Which DB?': 'pg', 'Which port?': '5432, 5433' } } });
  // nothing readable, or only ids that are not the tool's: no reply of the card's own
  assert.equal(claudeAskedReply(input, asked, {}), null);
  assert.equal(claudeAskedReply(input, [{ id: 'x' }], { answers: { x: { answers: ['a'] } } })!.behavior, 'deny');
});
