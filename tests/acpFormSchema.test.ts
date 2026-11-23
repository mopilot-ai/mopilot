// Flat ACP forms validate the provider's opaque schema and typed content, never synthesized permission choices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAcpForm, validateAcpAnswer, acpFormDefaults } from '../shared/acpForm.mjs';
const schema = (field: any, extra: any = {}) => ({ type: 'object', properties: { x: field }, ...extra });
const answer = (form: any, value: any) => validateAcpAnswer(form, { action: 'accept', content: { x: value } });
const parse = (field: any) => parseAcpForm(schema(field));

test('source-derived Kimi titled single/multi, Goose primitive forms, and OpenCode explicit custom fields', () => {
  const form = parseAcpForm({
    type: 'object',
    properties: {
      question_0: {
        type: 'string',
        title: 'Strategy',
        oneOf: [
          { const: 'safe', title: 'Conservative', description: 'Keep behavior' },
          { const: 'fast', title: 'Fast' },
        ],
      },
      question_1: {
        type: 'array',
        items: {
          anyOf: [
            { const: 'a', title: 'First' },
            { const: 'b', title: 'Second' },
          ],
        },
        minItems: 1,
        maxItems: 2,
      },
      custom: { type: 'string', minLength: 1, maxLength: 9, format: 'unknown-hint', default: 'literal' },
      count: { type: 'integer', minimum: -2, maximum: 3, default: 0 },
      number: { type: 'number', default: 0.5 },
      flag: { type: 'boolean', default: false },
    },
    required: ['question_0', 'question_1'],
  });
  assert.deepEqual(acpFormDefaults(form), { custom: 'literal', count: 0, number: 0.5, flag: false });
  const accepted = validateAcpAnswer(form, {
    action: 'accept',
    content: { question_0: 'safe', question_1: ['b', 'a'], custom: ' untrim ' },
  });
  assert.equal(accepted.content?.custom, ' untrim ');
  assert.deepEqual(accepted.content?.question_1, ['b', 'a']);
  assert.throws(() => validateAcpAnswer(form, { action: 'accept', content: { question_0: 'Conservative', question_1: ['a'] } }));
  const goose = parse({ type: 'array', items: { type: 'string', enum: ['a', 'b'] }, default: ['a'] });
  assert.deepEqual(acpFormDefaults(goose), { x: ['a'] });
  assert.deepEqual(answer(goose, []).content?.x, []);
});

test('optional null annotations, prototype keys, empty opaque values, and unchanged literal strings', () => {
  const form = parseAcpForm(
    JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string","enum":["","opaque"],"default":""}},"required":["__proto__"],"title":null,"description":null,"_meta":{"future":true}}',
    ),
  );
  const content = JSON.parse('{"__proto__":""}');
  assert.equal(validateAcpAnswer(form, { action: 'accept', content }).content?.__proto__, '');
  assert.equal(Object.getPrototypeOf(validateAcpAnswer(form, { action: 'accept', content }).content), null);
  assert.equal(Object.hasOwn(acpFormDefaults(form), '__proto__'), true);
  const optional = parseAcpForm(
    schema(
      {
        type: 'string',
        title: null,
        description: null,
        default: null,
        enum: null,
        oneOf: null,
        minLength: null,
        maxLength: null,
        format: null,
        pattern: null,
      },
      { required: null },
    ),
  );
  assert.deepEqual({ ...validateAcpAnswer(optional, { action: 'accept', content: {} }).content }, {});
  assert.equal(answer(optional, '  😀  ').content?.x, '  😀  ');
  assert.deepEqual(validateAcpAnswer(optional, { action: 'decline', content: null }), { action: 'decline' });
  assert.deepEqual(validateAcpAnswer(optional, { action: 'cancel' }), { action: 'cancel' });
});

test('invalid schemas and unsupported semantics fail closed rather than dropping constraints', () => {
  for (const s of [
    undefined,
    null,
    [],
    {},
    { type: 'array', properties: {} },
    { type: 'object', properties: [] },
    { type: 'object', properties: {} },
    schema({ type: 'string' }, { required: 5 }),
    schema({ type: 'string' }, { required: [5] }),
    schema({ type: 'string' }, { required: ['absent'] }),
    schema({ type: 'string' }, { required: ['x', 'x'] }),
    schema({ type: 'string' }, { title: 5 }),
    schema({ type: 'string' }, { title: 'Enter your password' }),
    schema({ type: 'string' }, { description: 'Provide an API key' }),
    schema({ type: 'string' }, { additionalProperties: false }),
    { type: 'object', properties: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [i, { type: 'string' }])) },
    schema({ type: 'string' }, { _meta: 'x'.repeat(65536) }),
  ])
    assert.throws(() => parseAcpForm(s));
  for (const f of [
    null,
    [],
    {},
    { type: 'object' },
    { type: '__proto__' },
    { type: 'string', title: 4 },
    { type: 'string', enum: [] },
    { type: 'string', enum: [5] },
    { type: 'string', enum: ['a', 'a'] },
    { type: 'string', enum: Array(65).fill('a') },
    { type: 'string', enum: 'a' },
    { type: 'string', oneOf: [{ const: 'a' }] },
    { type: 'string', oneOf: [{ const: 3, title: 'a' }] },
    { type: 'string', oneOf: [{ const: 'a', title: 'A', unknown: true }] },
    { type: 'string', enum: ['a'], oneOf: [{ const: 'a', title: 'A' }] },
    { type: 'string', pattern: '(a+)+$' },
    { type: 'string', format: 'password' },
    { type: 'string', format: 'PASSWORD' },
    { type: 'string', minLength: -1 },
    { type: 'string', minLength: 1.5 },
    { type: 'string', minLength: 4, maxLength: 2 },
    { type: 'string', minLength: 5000 },
    { type: 'string', maxLength: '5' },
    { type: 'array', items: { type: 'number', enum: ['a'] } },
    { type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }] }, minItems: 2 },
    { type: 'array', items: { type: 'string' } },
    { type: 'integer', minimum: 0.1 },
    { type: 'number', maximum: Infinity },
    { type: 'number', default: NaN },
    { type: 'boolean', default: 0 },
    { type: 'string', default: 'x'.repeat(4097) },
  ])
    assert.throws(() => parse(f), JSON.stringify(f));
  assert.throws(() => parseAcpForm(schema({ type: 'string' }), 'x'.repeat(4097)));
  assert.throws(() => parseAcpForm({ type: 'object', properties: { ['x'.repeat(4097)]: { type: 'string' } } }));
  assert.throws(() => parseAcpForm({ type: 'object', properties: { api_key: { type: 'string' } } }));
});

test('all answer types are strict, bounded, finite, required and constrained', () => {
  const string = parseAcpForm(schema({ type: 'string', minLength: 1, maxLength: 2 }, { required: ['x'] }));
  for (const value of [null, 4, [], true, '', 'abc', 'x'.repeat(4097)]) assert.throws(() => answer(string, value));
  assert.equal(answer(string, '😀').content?.x, '😀');
  for (const content of [undefined, null, [], {}, { y: 'a' }, { x: 'a', extra: 1 }, { x: 'x'.repeat(65536) }])
    assert.throws(() => validateAcpAnswer(string, { action: 'accept', content }));
  for (const a of [
    null,
    [],
    { action: 'yes' },
    { action: 'cancel', content: {} },
    { action: 'accept', content: { x: 'a' }, unknown: true },
  ])
    assert.throws(() => validateAcpAnswer(string, a));
  const arr = parse({ type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 1 });
  for (const value of [null, 'a', [], ['a', 'b'], ['a', 'a'], ['unknown'], Array(65).fill('a')]) assert.throws(() => answer(arr, value));
  const integer = parse({ type: 'integer', minimum: -1, maximum: 2 });
  for (const value of ['1', null, 1.5, 3, -2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => answer(integer, value));
  assert.equal(answer(integer, 0).content?.x, 0);
  assert.equal(answer(parse({ type: 'number' }), 0.125).content?.x, 0.125);
  assert.equal(answer(parse({ type: 'boolean' }), false).content?.x, false);
  assert.throws(() => answer(parse({ type: 'boolean' }), 'false'));
});

test('credential names are rejected while ordinary token budgets and counts remain supported', () => {
  for (const name of [
    'Bearer token',
    'Session token',
    'Personal token',
    'Personal access token',
    'Identity token',
    'Authorization token',
    'sessionToken',
    'personal_access_token',
    'bearer-token',
    'Bearer   token',
    'Bearer\ntoken',
    'passPhrase',
  ]) {
    assert.throws(() => parse({ type: 'string', title: name }));
    assert.throws(() => parseAcpForm(schema({ type: 'string' }), `Paste your ${name} to sign in`));
  }
  for (const title of [
    'Token budget',
    'Token count',
    'Session tokens',
    'Session token budget',
    'Session token limit',
    'SessionTokenCount',
    'Tokenization strategy',
  ]) {
    const form = parse({ type: 'number', title });
    assert.equal(answer(form, 100).content?.x, 100);
  }
  for (const message of ['Paste your token to sign in', 'Sign in: enter your token', 'Provide a token for authentication'])
    assert.throws(() => parseAcpForm(schema({ type: 'string' }), message));
  for (const message of [
    'Enter the token budget for authentication',
    'Enter a token name',
    'Choose a tokenization strategy',
    'Enter a token',
  ])
    assert.equal(
      validateAcpAnswer(parseAcpForm(schema({ type: 'string' }), message), { action: 'accept', content: { x: 'ordinary' } }).content?.x,
      'ordinary',
    );
  assert.equal(
    answer(parse({ type: 'string', title: 'Tokenization strategy', enum: ['words', 'characters'] }), 'words').content?.x,
    'words',
  );
});

test('choice constraint intersections stay satisfiable without deleting or changing opaque values', () => {
  for (const field of [
    { type: 'string', enum: ['a'], minLength: 2 },
    { type: 'string', enum: ['abc'], maxLength: 2 },
    { type: 'string', oneOf: [{ const: '😀', title: 'Emoji' }], minLength: 2 },
    { type: 'string', oneOf: [{ const: '😀😀', title: 'Two' }], maxLength: 1 },
  ])
    assert.throws(() => parse(field));
  const unicode = parse({ type: 'string', oneOf: [{ const: '😀', title: 'One' }], minLength: 1, maxLength: 1 });
  assert.equal(answer(unicode, '😀').content?.x, '😀');
  const mixed = parse({ type: 'string', enum: ['a', 'ab', 'abc'], minLength: 2, maxLength: 2 });
  assert.deepEqual(
    mixed.fields[0].options?.map((o) => o.value),
    ['a', 'ab', 'abc'],
  );
  assert.throws(() => answer(mixed, 'a'));
  assert.throws(() => answer(mixed, 'abc'));
  assert.equal(answer(mixed, 'ab').content?.x, 'ab');
});
