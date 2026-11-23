// The test JSON-line reader keeps a record split across data events, reads coalesced records and fails on bad input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readJsonLines } from './support/jsonLineReader.ts';

test('a record split before its newline waits for the rest, and coalesced records arrive together', async () => {
  const stream = new PassThrough();
  const reader = readJsonLines(stream);
  stream.write('{"id":1,"res');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(reader.records, []);
  assert.equal(reader.pending(), '{"id":1,"res');
  stream.write('ult":"a"}\n{"id":2}\n{"id":3}\n{"id"');
  assert.deepEqual(await reader.wait(3), [{ id: 1, result: 'a' }, { id: 2 }, { id: 3 }]);
  assert.equal(reader.pending(), '{"id"');
  const fourth = reader.find((r) => r.id === 4);
  stream.write(':4}\n');
  assert.deepEqual(await fourth, { id: 4 });
  assert.equal(reader.pending(), '');
});

test('a multi-byte character split across Buffer chunks decodes whole', async () => {
  const stream = new PassThrough();
  const reader = readJsonLines(stream);
  const bytes = Buffer.from('{"t":"é"}\n\n');
  stream.write(bytes.subarray(0, 7));
  stream.write(bytes.subarray(7));
  assert.deepEqual(await reader.wait(1), [{ t: 'é' }]);
});

test('a malformed complete record fails the wait instead of being skipped', async () => {
  const stream = new PassThrough();
  const reader = readJsonLines(stream);
  stream.write('{"id":1}\nnot json\n');
  assert.deepEqual(await reader.wait(1), [{ id: 1 }]);
  await assert.rejects(reader.wait(2), /Malformed JSON line: not json/);
});

test('a stream that ends before enough records fails the wait and names the partial record', async () => {
  const stream = new PassThrough();
  const reader = readJsonLines(stream);
  const waiting = reader.find((r) => r.id === 2);
  stream.end('{"id":1}\n{"id":');
  await assert.rejects(waiting, /ended with 1 record\(s\) and a partial one: \{"id":/);
  const plain = new PassThrough();
  const empty = readJsonLines(plain);
  plain.end();
  plain.resume();
  await assert.rejects(empty.wait(1), /ended with 0 record\(s\)$/);
});
