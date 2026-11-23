// Main validates side-panel forms against the live question/schema, and maps only supported choices to each harness's protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validate, formCard, formAnswer } = require('../electron/capabilities/browser/chromePanelForm.cjs');
const bad = (schema: any, value: any) => assert.throws(() => validate(schema, value), /Check the answer/);
test('JSON fields enforce required, extra properties, nested collections, numeric and string constraints', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 6, pattern: '^A' },
      age: { type: 'integer', minimum: 1, maximum: 10 },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, uniqueItems: true, minItems: 1, maxItems: 2 },
      yes: { type: 'boolean' },
      optional: { type: ['string', 'null'] },
    },
  };
  validate(schema, { name: 'Amy', age: 2, tags: ['a', 'b'], yes: true, optional: null });
  for (const value of [
    {},
    [],
    { name: '' },
    { name: 'A123456' },
    { name: 'A', extra: true },
    { name: 'A', age: 1.5 },
    { name: 'A', age: 0 },
    { name: 'A', age: 11 },
    { name: 'A', age: '2' },
    { name: 'A', tags: [] },
    { name: 'A', tags: ['a', 'a'] },
    { name: 'A', tags: ['c'] },
    { name: 'A', tags: ['a', 'b', 'a'] },
    { name: 'A', yes: 'true' },
  ])
    bad(schema, value);
  validate({ type: 'object', additionalProperties: { type: 'number' } }, { arbitrary: 1 });
  bad({ type: 'object', additionalProperties: { type: 'number' } }, { arbitrary: '1' });
  validate({ type: ['string', 'number'] }, 1);
  validate({ type: 'string' }, '');
  validate({}, [1]);
  bad({ type: [] }, 1);
  bad({ type: ['string', 'number'] }, true);
  bad(null, 1);
  bad({ type: 'invalid' }, 1);
  bad({ type: 'null' }, 1);
  validate({ type: 'null' }, null);
  validate({ type: 'string', pattern: '[' }, 'x');
  validate(schema, { name: 'Z' });
  bad({ type: 'string' }, 'x'.repeat(100_001));
  bad({ type: 'number' }, Infinity);
  bad({ type: 'array' }, 'x');
  validate({ type: 'array' }, [1]);
  bad({ type: 'object' }, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), i])));
  bad({ type: 'array' }, Array(101).fill(0));
  assert.throws(() => validate({}, 1, 'nested', 9), /nested/);
});

test('questions allow only offered labels, explicit Other, and the requested single/multiple shape', () => {
  const p = {
    questions: [
      { id: 'single', header: 'Hotel', isOther: false, options: [{ label: 'A' }] },
      { id: 'multi', question: 'Amenities?', multiSelect: true, isOther: true, options: [{ label: 'Pool' }] },
    ],
  };
  assert.ok(formCard('item/tool/requestUserInput', p).questions);
  assert.deepEqual(formAnswer('item/tool/requestUserInput', p, 'submit', { single: ['A'], multi: ['Pool', 'Gym'] }), {
    answers: { single: { answers: ['A'] }, multi: { answers: ['Pool', 'Gym'] } },
  });
  for (const values of [
    null,
    { single: 'A' },
    { single: ['A', 'A'] },
    { single: ['B'] },
    { single: [1] },
    { single: ['x'.repeat(100_001)] },
    { multi: Array(101).fill('Pool') },
    { unknown: [] },
  ])
    assert.throws(() => formAnswer('item/tool/requestUserInput', p, 'submit', values), /Check/);
  assert.throws(() => formAnswer('item/tool/requestUserInput', p, 'submit', {}), /Check/);
  assert.throws(
    () => formAnswer('item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Which?' }] }, 'submit', { q: ['   '] }),
    /Check/,
  );
  assert.equal(formCard('item/tool/requestUserInput', { questions: [{ id: 'q', options: [{ label: 'A' }] }] }).questions[0].isOther, true);
  assert.deepEqual(
    formAnswer('item/tool/requestUserInput', { questions: [{ id: 'q', options: [{ label: 'A' }] }] }, 'submit', { q: ['B'] }),
    { answers: { q: { answers: ['B'] } } },
  );
  assert.deepEqual(formAnswer('item/tool/requestUserInput', {}, 'skip', null), { answers: {} });
  assert.equal(formAnswer('item/tool/requestUserInput', p, 'forged', {}), null);
  assert.deepEqual(formCard('item/tool/requestUserInput', {}).questions, []);
});

test('MCP forms/URL cards preserve protocol action/content, and rejection does not require valid field data', () => {
  const method = 'mcpServer/elicitation/request';
  const p = { serverName: 'Example', requestedSchema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } };
  assert.match(formCard(method, p).title, /Example/);
  assert.deepEqual(formAnswer(method, p, 'submit', { n: 2 }), { action: 'accept', content: { n: 2 }, _meta: null });
  assert.throws(() => formAnswer(method, p, 'submit', {}), /n/);
  assert.deepEqual(formAnswer(method, p, 'decline', undefined), { action: 'decline', content: null, _meta: null });
  assert.deepEqual(formAnswer(method, p, 'cancel', undefined), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(formAnswer(method, { mode: 'url' }, 'submit', undefined), { action: 'accept', content: null, _meta: null });
  assert.equal(formCard(method, { mode: 'url', url: 'https://example.com' }).url, 'https://example.com');
  assert.deepEqual(formCard(method, {}).schema, { type: 'object', properties: {} });
  assert.deepEqual(formAnswer(method, {}, 'submit', {}), { action: 'accept', content: {}, _meta: null });
  assert.equal(formAnswer(method, p, 'unknown', {}), null);
  assert.equal(formAnswer('unknown', {}, 'submit', {}), null);
  assert.equal(formCard('unknown', {}), null);
});

test('Submit requires a question, and extra answer ids cannot hide behind otherwise valid answers', () => {
  for (const questions of [undefined, [], {}])
    assert.throws(() => formAnswer('item/tool/requestUserInput', { questions }, 'submit', {}), /Check/);
  const p = { questions: [{ id: 'q', question: 'Where?', isOther: false, options: [{ label: 'A' }] }] };
  assert.deepEqual(formAnswer('item/tool/requestUserInput', p, 'submit', { q: ['A'] }).answers.q.answers, ['A']);
  assert.throws(() => formAnswer('item/tool/requestUserInput', p, 'submit', { q: ['A'], extra: ['B'] }), /Check/);
});

test('a question without a separate header reports its own label when an unoffered answer is refused', () => {
  assert.throws(
    () =>
      formAnswer(
        'item/tool/requestUserInput',
        { questions: [{ id: 'q', question: 'Which hotel?', isOther: false, options: [{ label: 'A' }] }] },
        'submit',
        { q: ['B'] },
      ),
    /Which hotel/,
  );
});

test('actual MCP enum schema variants retain option titles and validate the offered constant values', async () => {
  const { ElicitRequestFormParamsSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const p = ElicitRequestFormParamsSchema.parse({
    mode: 'form',
    message: 'Choose',
    requestedSchema: {
      type: 'object',
      required: ['hotel'],
      properties: {
        hotel: {
          type: 'string',
          oneOf: [
            { const: 'a', title: 'Hotel A' },
            { const: 'b', title: 'Hotel B' },
          ],
          default: 'a',
        },
        extras: {
          type: 'array',
          items: { anyOf: [{ const: 'pool', title: 'Swimming pool' }] },
          default: ['pool'],
          minItems: 0,
          maxItems: 1,
        },
      },
    },
  });
  const c = formCard('mcpServer/elicitation/request', p);
  assert.deepEqual(c.schema.properties.hotel.enum, ['a', 'b']);
  assert.deepEqual(c.schema.properties.hotel.enumLabels, ['Hotel A', 'Hotel B']);
  assert.deepEqual(c.schema.properties.extras.items.enumLabels, ['Swimming pool']);
  assert.equal(formAnswer('mcpServer/elicitation/request', p, 'submit', { hotel: 'b', extras: ['pool'] }).content.hotel, 'b');
  assert.throws(() => formAnswer('mcpServer/elicitation/request', p, 'submit', { hotel: 'other' }), /hotel/);
  assert.throws(() => formAnswer('mcpServer/elicitation/request', p, 'submit', { hotel: 'a', extras: ['unknown'] }), /extras/);
});

test('MCP legacy names and untitled constants normalize without executing nonstandard patterns', async () => {
  const { ElicitRequestFormParamsSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const standard = ElicitRequestFormParamsSchema.parse({
    message: 'A note',
    requestedSchema: { type: 'object', properties: { note: { type: 'string', pattern: '(a+)+$' } } },
  });
  assert.equal((standard.requestedSchema.properties.note as any).pattern, undefined);
  const method = 'mcpServer/elicitation/request';
  const schema = {
    type: 'object',
    properties: {
      legacy: { type: 'string', enum: ['a'], enumNames: ['Hotel A'] },
      plain: { type: 'string', oneOf: [{ const: 'x' }] },
      empty: { type: 'string', oneOf: [] },
      mixed: { type: 'string', anyOf: [null, { const: 'x' }] },
      missing: { type: 'string', anyOf: [{}] },
      raw: null,
    },
  };
  const card = formCard(method, { requestedSchema: schema });
  assert.deepEqual(card.schema.properties.legacy.enumLabels, ['Hotel A']);
  assert.deepEqual(card.schema.properties.plain.enumLabels, ['x']);
  assert.equal(card.schema.properties.raw, null);
  assert.deepEqual(formAnswer(method, standard, 'submit', { note: 'a'.repeat(1000) + '!' }).content, { note: 'a'.repeat(1000) + '!' });
  let nested: any = { type: 'string' };
  for (let i = 0; i < 10; i++) nested = { type: 'array', items: nested };
  assert.deepEqual(formCard(method, { requestedSchema: nested }).schema, nested);
});
