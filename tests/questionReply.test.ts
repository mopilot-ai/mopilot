import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUserText } from '../shared/userText.mjs';

const wrap = (entries: unknown) => `<send_user_message_question_reply>\n${JSON.stringify(entries)}\n</send_user_message_question_reply>`;

test('official async replies display the question and answer without protocol fields', () => {
  const result = parseUserText(
    wrap([{ questionItemId: '["request_user_input_async","call_example",0]', question: '请选择日期？', answer: '周六。\n上午十点。' }]),
  );
  assert.equal(result.text, '周六。\n上午十点。');
  assert.deepEqual(result.annotations, [{ text: '请选择日期？', annotation: undefined }]);
});

test('multiple answers and surrounding user text are preserved', () => {
  const result = parseUserText(
    `Before\n${wrap([
      { question: 'Which day?', answer: 'Saturday' },
      { question: 'Which time?', answer: '10:00' },
    ])}\nAfter`,
  );
  assert.equal(result.text, 'Before\nWhich day?\nSaturday\n\nWhich time?\n10:00\nAfter');
  assert.deepEqual(result.annotations, []);
});

test('question replies also parse after hidden handoff and context sections', () => {
  const result = parseUserText(
    `<sage-handoff from="Codex">hidden</sage-handoff>\n<browser-context>context</browser-context>\n## My request:\n${wrap([{ question: 'Ready?', answer: 'Yes' }])}`,
  );
  assert.equal(result.text, 'Yes');
  assert.equal(result.annotations[0].text, 'Ready?');
});

test('malformed, unknown and incomplete payloads remain readable without data loss', () => {
  for (const raw of [
    '<send_user_message_question_reply>{broken}</send_user_message_question_reply>',
    wrap([]),
    wrap({ question: 'Q', answer: 'A' }),
    wrap([
      { question: 'Q', answer: 'A' },
      { question: 'Other', answer: null },
    ]),
    '<send_user_message_question_reply>[',
    '  ordinary text\n',
  ]) {
    assert.equal(parseUserText(raw).text, raw);
    assert.deepEqual(parseUserText(raw).annotations, []);
  }
});

test('standalone replies identify the exact annotation to combine into the answer bubble', () => {
  const result = parseUserText(wrap([{ question: 'Full question?', answer: 'Chosen option' }]));
  assert.deepEqual(result.questionReply, { question: 'Full question?', annotationIndex: 0 });
  assert.equal(result.text, 'Chosen option');
  assert.equal(result.annotations[result.questionReply!.annotationIndex].text, 'Full question?');
});

test('question summary metadata survives hidden context without swallowing existing annotations', () => {
  const context =
    '# Response annotations:\n<response-annotations>[{"text":"Existing quote","annotation":"Comment"}]</response-annotations>\n## My request:\n';
  const result = parseUserText(context + wrap([{ question: 'Ready?', answer: 'Yes' }]));
  assert.deepEqual(result.questionReply, { question: 'Ready?', annotationIndex: 1 });
  assert.deepEqual(result.annotations[0], { text: 'Existing quote', annotation: 'Comment' });
  assert.equal(result.text, 'Yes');
});

test('surrounding text, multiple replies and malformed data never become a standalone answer bubble', () => {
  for (const raw of [
    `Before\n${wrap([{ question: 'Q', answer: 'A' }])}`,
    `${wrap([{ question: 'Q', answer: 'A' }])}\nAfter`,
    wrap([
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
    ]),
    `${wrap([{ question: 'Q1', answer: 'A1' }])}\n${wrap([{ question: 'Q2', answer: 'A2' }])}`,
    '<send_user_message_question_reply>{broken}</send_user_message_question_reply>',
    wrap([{ question: 'Q', answer: null }]),
  ])
    assert.equal(parseUserText(raw).questionReply, undefined);
});

test('empty answers retain their question context', () => {
  const result = parseUserText(wrap([{ question: 'Question?', answer: '' }]));
  assert.equal(result.text, '');
  assert.equal(result.questionReply?.question, 'Question?');
});
