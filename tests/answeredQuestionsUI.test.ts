// The answered-questions card in the transcript (src/components/thread/AnsweredQuestions.tsx), shown for an answers
// note (BlockItem): one row per question, the answer muted under it, a skipped one said so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/thread/ScheduledTaskCard.tsx', 'schedCard', { ScheduledTaskCard: stubComponent('ScheduledTaskCard') });
autoMock('src/components/tasks/TaskEventCard.tsx', 'taskEvent', { TaskEventCard: stubComponent('TaskEventCard') });
const { BlockItem } = await import('../src/components/thread/Items.tsx');
const { isBlockItem } = await import('../src/components/thread/items/stepModel.ts');

const note = (answers: unknown) => ({ type: 'statusNote', id: 'answers-1', kind: 'answers', text: 'Answered 2 questions', answers });

test('an answers note is the answered-questions card: each question, its answer under it, a skip said so', async () => {
  const item = note([
    { question: 'Replace the look, or add a style?', answer: 'Replace entirely' },
    { question: 'Token?', answer: 'Hidden' },
    { question: 'Anything else?', answer: null },
  ]);
  assert.equal(isBlockItem(item as any), true);
  const v = await render(h(BlockItem, { item: item as any, cwd: '/w' }));
  const card = v.host.querySelector('.answered-card[role="group"]')!;
  assert.equal(card.getAttribute('aria-label'), 'Answered questions');
  assert.deepEqual(
    [...card.querySelectorAll('.answered-row')].map((r) => [
      r.querySelector('.answered-question')!.textContent,
      r.querySelector('.answered-answer')!.textContent,
      r.querySelector('.answered-answer')!.classList.contains('skipped'),
    ]),
    [
      ['Replace the look, or add a style?', 'Replace entirely', false],
      ['Token?', 'Hidden', false],
      ['Anything else?', 'Skipped', true],
    ],
  );
  await v.unmount();
});

test('an answers note without its answers falls back to its line of text', async () => {
  for (const answers of [undefined, []]) {
    const v = await render(h(BlockItem, { item: note(answers) as any, cwd: '/w' }));
    assert.equal(v.host.querySelector('.answered-card'), null);
    assert.equal(v.host.querySelector('.status-note.answers .step-text')!.textContent, 'Answered 2 questions');
    await v.unmount();
  }
});
