// Shared JSON object boundary for transcript readers, including whitespace, escapes and malformed lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson, parseJsonRecord, jsonStringField } from '../shared/jsonRecord.mjs';

test('parseJson: any JSON value, or a typed failure for text that is not JSON', () => {
  for (const [text, value] of [
    ['[1,{"a":2}]', [1, { a: 2 }]],
    ['null', null],
    ['"s"', 's'],
    [' 3 ', 3],
  ] as const)
    assert.deepEqual(parseJson(text), { ok: true, value });
  for (const text of ['', '{broken', 'plain text']) assert.deepEqual(parseJson(text), { ok: false, error: 'Invalid JSON' });
});

test('object records follow JSON decoding rather than serialization spelling', () => {
  assert.deepEqual(parseJsonRecord('{ "type" : "user" }'), { ok: true, record: { type: 'user' } });
  assert.deepEqual(parseJsonRecord(String.raw`{"t\u0079pe":"u\u0073er"}`), { ok: true, record: { type: 'user' } });
  assert.deepEqual(parseJsonRecord('{}'), { ok: true, record: {} });
});

test('non-object values and partial records are explicit failures', () => {
  for (const text of ['null', 'false', '0', '"text"', '[]']) assert.equal(parseJsonRecord(text).ok, false);
  for (const text of ['', '{"type":', 'not json']) assert.deepEqual(parseJsonRecord(text), { ok: false, error: 'Invalid JSON record' });
});

test('string fields decode whitespace and escapes without needing the complete object', () => {
  assert.equal(jsonStringField('{ "cwd" : "/project", "large":"unfinished', 'cwd'), '/project');
  assert.equal(jsonStringField(String.raw`{"c\u0077d":"/pro\u006aect","large":"unfinished`, 'cwd'), '/project');
  assert.equal(jsonStringField('{"cwd":""}', 'cwd'), '');
  assert.equal(jsonStringField('{"other":"value"}', 'cwd'), null);
  assert.equal(jsonStringField('{"other":"value"}', 'toString'), null);
  assert.equal(jsonStringField('{"cwd":42}', 'cwd'), null);
  assert.equal(jsonStringField(String.raw`{"cwd":"\q","next":"valid"}`, 'cwd'), null);
  assert.equal(jsonStringField(String.raw`{"cwd":"\q","next":"valid"}`, 'next'), 'valid');
});
