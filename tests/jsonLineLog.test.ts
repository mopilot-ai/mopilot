// Live fixture logs publish a record at its newline, including file creation, partial appends and failed reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstPublishedLine, readJsonLineLog } from '../scripts/fixture-json-log.mjs';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-json-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'events.jsonl');
}

test('single-record markers publish only their first completed line', () => {
  for (const pending of [null, '', '12']) assert.equal(firstPublishedLine(pending), null);
  assert.equal(firstPublishedLine('123\nsecond'), '123');
  assert.equal(firstPublishedLine('123\r\nsecond\n'), '123\r');
  assert.equal(firstPublishedLine('\n'), '');
});

test('a missing or newly created empty log has no published records', (t) => {
  const log = fixture(t);
  assert.deepEqual(readJsonLineLog(log), []);
  fs.writeFileSync(log, '');
  assert.deepEqual(readJsonLineLog(log), []);
});

test('only complete lines publish, and a later read includes the finished append without losing previous records', (t) => {
  const log = fixture(t);
  fs.writeFileSync(log, '{"what":"start"}');
  assert.deepEqual(readJsonLineLog(log), []);
  fs.appendFileSync(log, '\n\n{"what":');
  assert.deepEqual(readJsonLineLog(log), [{ what: 'start' }]);
  fs.appendFileSync(log, '"end"}\n');
  assert.deepEqual(readJsonLineLog(log), [{ what: 'start' }, { what: 'end' }]);
  const other = path.join(path.dirname(log), 'other.jsonl');
  fs.writeFileSync(other, '{"what":"other"}\n');
  assert.deepEqual(readJsonLineLog(other), [{ what: 'other' }]);
  assert.deepEqual(readJsonLineLog(log), [{ what: 'start' }, { what: 'end' }]);
});

test('malformed completed records and non-missing read failures are visible; corrected data can be read again', (t) => {
  const log = fixture(t);
  fs.writeFileSync(log, '{"what":"start"}\n{broken}\n');
  assert.throws(() => readJsonLineLog(log), SyntaxError);
  fs.writeFileSync(log, '{"what":"retry"}\n');
  assert.deepEqual(readJsonLineLog(log), [{ what: 'retry' }]);
  const directory = path.join(path.dirname(log), 'directory');
  fs.mkdirSync(directory);
  assert.throws(() => readJsonLineLog(directory));
});
