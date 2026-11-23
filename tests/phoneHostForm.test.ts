// A question an agent asks on a machine is a form card the phone draws and answers as that form (#4860): the fields as the thread's question card reads them, and the person's values as the content the Host checks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORM_CHOICES, formCard, formContent, formOf } from '../mobile/src/remote/hostForm.ts';
import { threadCards } from '../mobile/src/remote/hostChat.ts';
import { rig } from './support/phone/host-chat-rig.ts';

const FORM = {
  fields: [
    {
      key: 'lang',
      type: 'string',
      title: 'Language',
      description: 'Pick one',
      required: true,
      options: [
        { value: 'ts', label: 'TypeScript' },
        { value: 'js', label: 'JavaScript' },
      ],
    },
    {
      key: 'tools',
      type: 'array',
      title: 'Tools',
      options: [
        { value: 'lint', label: 'Lint' },
        { value: 'fmt', label: 'Format' },
      ],
    },
    { key: 'name', type: 'string', title: 'Name', description: null },
    { key: 'size', type: 'integer', title: 'Size' },
    { key: 'ratio', type: 'number', description: 'Between 0 and 1' },
    { key: 'ok', type: 'boolean', title: 'Ready?' },
  ],
};

test('a form card is read for its fields; one with none the phone can read is not a form', () => {
  assert.equal(formOf(FORM)?.fields.length, 6);
  for (const none of [null, 'x', [], {}, { fields: [] }, { fields: [1, { key: 3 }] }]) assert.equal(formOf(none), null);
  assert.deepEqual(
    formOf({ fields: [{ key: 'a', type: 'string' }, 7, { type: 'string' }] })?.fields.map((f) => f.key),
    ['a'],
  );
});

test('the questions and plain fields of a form are the thread’s question card; Send and Skip are its choices', () => {
  const card = formCard(formOf(FORM)!);
  assert.deepEqual(card.questions, [
    {
      id: 'lang',
      question: 'Language: Pick one',
      options: [{ label: 'TypeScript' }, { label: 'JavaScript' }],
      multiSelect: false,
      isOther: false,
    },
    { id: 'tools', question: 'Tools', options: [{ label: 'Lint' }, { label: 'Format' }], multiSelect: true, isOther: false },
  ]);
  assert.deepEqual(card.schema, {
    properties: {
      name: { title: 'Name', type: 'string' },
      size: { title: 'Size', type: 'number' },
      ratio: { title: 'ratio', description: 'Between 0 and 1', type: 'number' },
      ok: { title: 'Ready?', type: 'boolean' },
    },
  });
  assert.deepEqual(formCard({ fields: [{ key: 'a', type: 'string' }] }), { schema: { properties: { a: { title: 'a', type: 'string' } } } });
  assert.deepEqual(formCard({ fields: [{ key: 'a', type: 'string', options: [{ value: 'x', label: 'X' }] }] }).schema, undefined);
  assert.deepEqual(
    FORM_CHOICES.map((c) => [c.key, c.deny === true]),
    [
      ['submit', false],
      ['cancel', true],
    ],
  );
});

test('what the person gave becomes the form’s content: labels are the options’ values, one value is one value, a list stays a list, and an empty one is left out', () => {
  const form = formOf(FORM)!;
  assert.deepEqual(
    formContent(form, { lang: ['TypeScript'], tools: ['Lint', 'Format'], name: 'Du', size: '3', ratio: ['0.5'], ok: 'Yes' }),
    { lang: 'ts', tools: ['lint', 'fmt'], name: 'Du', size: 3, ratio: 0.5, ok: true },
  );
  assert.deepEqual(formContent(form, { lang: 'JavaScript', tools: 'Lint', ok: false }), { lang: 'js', tools: ['lint'], ok: false });
  assert.deepEqual(formContent(form, { ok: ['no'] }), { ok: false });
  assert.deepEqual(
    formContent(form, { ok: 'maybe', lang: 'Other text' }),
    { ok: 'maybe', lang: 'Other text' },
    'what is neither stays for the Host to refuse',
  );
  assert.deepEqual(formContent(form, { lang: '', tools: [], name: null, size: undefined }), {});
});

const wireForm = (requestId: string, chatId = 'c1') => ({
  chatId,
  epoch: 1,
  requestId,
  cardKind: 'question',
  summary: { tool: 'question', line: 'A question for you' },
  options: [],
  form: FORM,
  at: 1,
});

test('a question card with a form is answered in the thread: Send accepts the values, Skip cancels, and one with no form is still finished on the machine', async () => {
  const r = rig({ pending: [wireForm('q1'), { ...wireForm('q2'), form: undefined }] });
  const snap: any = await r.runtime.request('chat.follow', { chatId: 'c1' });
  const [asked, plain] = snap.session.cards;
  assert.deepEqual([asked.where, asked.kind, asked.waitingCopy], ['phone', 'question', undefined]);
  assert.deepEqual(asked.choices, FORM_CHOICES);
  assert.equal(asked.questions.length, 2);
  assert.deepEqual([plain.where, plain.waitingCopy], ['mac-only', 'Answer this on Studio.']);
  assert.equal(threadCards(r.cards.list(), 'c1', 'Studio').length, 2);
  await r.runtime.request('card.answer', {
    chatId: 'c1',
    cardId: asked.id,
    rev: 0,
    key: 'submit',
    values: { lang: ['TypeScript'], size: '2' },
  });
  assert.deepEqual(r.forms[0], { action: 'accept', content: { lang: 'ts', size: 2 } });
  await r.runtime.request('card.answer', { chatId: 'c1', cardId: asked.id, rev: 0, key: 'cancel' });
  assert.deepEqual(r.forms[1], { action: 'cancel' });
  // Send with nothing given is the Host's to refuse
  await r.runtime.request('card.answer', { chatId: 'c1', cardId: asked.id, rev: 0, key: 'submit' });
  assert.deepEqual(r.forms[2], { action: 'accept', content: {} });
  // a permission card is answered by its option, with no form
  const p = rig({
    pending: [
      { ...wireForm('r9'), cardKind: 'permission', form: undefined, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow' }] },
    ],
  });
  const permission: any = ((await p.runtime.request('chat.follow', { chatId: 'c1' })) as any).session.cards[0];
  await p.runtime.request('card.answer', { chatId: 'c1', cardId: permission.id, rev: 0, key: 'allow' });
  assert.equal(p.forms[0], undefined);
});
