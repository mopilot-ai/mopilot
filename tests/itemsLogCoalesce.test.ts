// ItemsLog merges adjacent streamed text chunks into one record and parses only the kinds a list entry needs
// (electron/platform/itemsLog.cjs): order, crash recovery (queued by timer, flush, read, drain), old transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ItemsLog } = require('../electron/platform/itemsLog.cjs');
const { TranscriptWriter } = require('../electron/platform/transcriptWriter.cjs');

const chunk = (text: string, extra: object = {}, turnId = 't1', kind = 'agent_message_chunk') => ({
  t: 'update',
  turnId,
  update: { sessionUpdate: kind, content: { type: 'text', text }, ...extra },
  at: 1,
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'items-coalesce-'));
const lines = (dir: string, id: string) =>
  fs
    .readFileSync(path.join(dir, encodeURIComponent(id) + '.items.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function setup(coalesceMs = 10_000) {
  const dir = tmp();
  const writer = new TranscriptWriter({ flushMs: 1 });
  return { dir, log: new ItemsLog(dir, { writer, coalesceMs }) };
}

test('adjacent chunks of one message become one record; other kinds, turns and messages start a new one', async () => {
  const { dir, log } = setup();
  log.append('a', { t: 'session', at: 0 });
  for (const c of ['he', 'llo', ' wor', 'ld']) log.appendUpdate('a', chunk(c));
  log.appendUpdate('a', chunk('thinking', {}, 't1', 'agent_thought_chunk'));
  log.appendUpdate('a', chunk('next turn', {}, 't2', 'agent_thought_chunk'));
  log.appendUpdate('a', chunk('m1', { messageId: 'x' }));
  log.appendUpdate('a', chunk('m2', { messageId: 'y' }));
  await log.flush('a');
  assert.deepEqual(
    lines(dir, 'a').map((r) => r.update?.content?.text ?? r.t),
    ['session', 'hello world', 'thinking', 'next turn', 'm1', 'm2'],
  );
});

test('a non-chunk record queues the held chunk first, so the order is the arrival order', async () => {
  const { dir, log } = setup();
  log.append('a', { t: 'session', at: 0 });
  log.appendUpdate('a', chunk('one'));
  log.appendUpdate('a', chunk('two'));
  log.appendUpdate('a', { t: 'update', turnId: 't1', update: { sessionUpdate: 'tool_call', toolCallId: 'c' }, at: 2 });
  log.append('a', { t: 'end', turnId: 't1', at: 3 });
  await log.flush('a');
  assert.deepEqual(
    lines(dir, 'a').map((r) => r.update?.content?.text ?? r.update?.sessionUpdate ?? r.t),
    ['session', 'onetwo', 'tool_call', 'end'],
  );
});

test('chunks with other fields or non-text content are kept as they are', async () => {
  const { dir, log } = setup();
  log.append('a', { t: 'session', at: 0 });
  log.appendUpdate('a', chunk('x', { _meta: { k: 1 } }));
  log.appendUpdate('a', chunk('y', { _meta: { k: 2 } }));
  log.appendUpdate('a', {
    t: 'update',
    turnId: 't1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'z' } },
    at: 1,
  });
  log.appendUpdate('a', {
    t: 'update',
    turnId: 't1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'k', annotations: {} } },
    at: 1,
  });
  log.appendUpdate('a', { t: 'mode', modeId: 'm' });
  log.appendUpdate('', chunk('ignored'));
  await log.flush('a');
  assert.equal(lines(dir, 'a').length, 6);
});

test('the held chunk reaches the disk by its timer, a flush, a read, a drain; has() sees it and remove() drops it', async () => {
  const dir = tmp();
  const writer = new TranscriptWriter({ flushMs: 1 });
  const log = new ItemsLog(dir, { writer, coalesceMs: 5 });
  log.append('t', { t: 'session', at: 0 });
  log.appendUpdate('t', chunk('timer'));
  log.appendUpdate('t', chunk('!'));
  assert.equal(log.has('t'), true);
  await new Promise((r) => setTimeout(r, 40));
  await log.flush('t');
  assert.equal(lines(dir, 't').at(-1).update.content.text, 'timer!');

  const slow = new ItemsLog(dir, { writer, coalesceMs: 60_000 });
  slow.append('r', { t: 'session', at: 0 });
  slow.appendUpdate('r', chunk('read me'));
  slow.appendUpdate('r', chunk('', {}, 't1', 'agent_thought_chunk'));
  assert.equal((await slow.readAsync('r')).length, 3, 'a read includes the held chunk');
  slow.appendUpdate('d', chunk('first'));
  slow.appendUpdate('d', chunk('quit'));
  await slow.drain();
  assert.equal(lines(dir, 'd')[0].update.content.text, 'firstquit', 'a quit writes what is held');
  assert.equal(slow.has('nope'), false);
  slow.appendUpdate('gone', chunk('x'));
  slow.remove('gone');
  slow.queueHeld();
  assert.equal(fs.existsSync(path.join(dir, 'gone.items.jsonl')), false);
});

test('a scan skips the other kinds by prefix, still reads lines in another shape, and flags torn lines', async () => {
  const { log } = setup();
  const text = [
    JSON.stringify({ t: 'session', cwd: '/w' }),
    JSON.stringify(chunk('big')),
    JSON.stringify({ t: 'title', name: 'N' }),
    JSON.stringify({ at: 1, t: 'title', name: 'older shape' }),
    '{"t":"title"',
    JSON.stringify({ t: 'user', user: {} }),
  ].join('\n');
  fs.writeFileSync(log.file('acp:parse'), `${text}\n`);
  const { records, torn } = await log.scan('acp:parse', { kinds: ['session', 'title'] });
  assert.deepEqual(
    records.map((r: any) => r.name ?? r.t),
    ['session', 'N', 'older shape'],
  );
  assert.equal(torn, 0, 'a torn line of an unwanted kind is skipped by its prefix');
  assert.equal(log.parse(text).length, 5, 'without kinds every record parses');
});

test("readKindsAsync reads one chat's kinds, and nothing for a chat without a transcript", async () => {
  const { log } = setup();
  assert.deepEqual(await log.readKindsAsync('missing', ['title']), []);
  log.append('a', { t: 'session', at: 0 });
  log.appendUpdate('a', chunk('x'));
  log.append('a', { t: 'title', name: 'T' });
  assert.deepEqual(
    (await log.readKindsAsync('a', ['title'])).map((r: any) => r.name),
    ['T'],
  );
});

test('the recordings transcripts name are read with their unwritten lines, and a transcript not there yet names none', async () => {
  const { dir, log } = setup();
  const name = '01234567-89ab-cdef-0123-456789abcdef.wav';
  log.append('a', { t: 'user', attachments: [{ path: `/assets/${name}` }] });
  assert.deepEqual(await log.audioRefs(['a', 'not-there']), [name]);
  assert.deepEqual(await log.audioRefs([]), []);
  // a read that fails rejects, so a collector removes nothing for want of it
  fs.mkdirSync(path.join(dir, 'unreadable.items.jsonl'));
  await assert.rejects(log.audioRefs(['unreadable']));
});
