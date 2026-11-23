// What the panel's thread tells the page about a refusal and a usage warning (electron/chrome-extension/src/panelThread.mjs): the refusal key only while the refusal is the last row, the warning from the read, and the "Stopped by a safety check" line (#3046, B9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thread } from './support/panel-thread.ts';

const { PROGRESS } = await import('../electron/chrome-extension/src/panelThread.mjs');

const ask = { role: 'user', text: 'Do the thing' };
const refusal = { role: 'note', text: 'Paused by safety filters', refusal: true, id: 'refusal-t1' };

test('a chat whose last row is the refusal says "Stopped by a safety check" and names it for the page; a message after it, or a running turn, takes it away', async () => {
  const { t, els, reads, read, data, line } = thread();
  const opened = t.open('c1', {});
  reads[0].answer({ rows: [ask, refusal], state: 'idle', turn: { status: 'failed' } });
  await opened;
  assert.deepEqual(line(), ['Stopped by a safety check', 'dot error']);
  assert.equal(PROGRESS.refusal.text, 'Stopped by a safety check');
  assert.equal(data().refusalKey, 'refusal-t1');
  // an update that only says idle again keeps the line
  t.turn('idle');
  assert.deepEqual(line(), ['Stopped by a safety check', 'dot error']);
  // a message sent from here is the last row at once, before any read has it
  t.sending('Try something else');
  assert.equal(data().refusalKey, '');
  assert.equal(els['progress-text'].textContent, PROGRESS.running.text);
  // its turn ends and the rows end with the new reply: not the old refusal
  await read({
    rows: [ask, refusal, { role: 'user', text: 'Try something else' }, { role: 'assistant', text: 'Sure.' }],
    state: 'idle',
    turn: { status: 'completed' },
  });
  assert.equal(data().refusalKey, '');
  assert.deepEqual(line(), ['Done', 'dot ok']);
});

test('a refusal row with no id is named by its text; a refusal that is not the last row names nothing; the next chat starts clean', async () => {
  const { t, reads, read, data } = thread();
  const opened = t.open('c1', {});
  reads[0].answer({ rows: [{ role: 'note', text: 'Paused', refusal: true }], state: 'idle' });
  await opened;
  assert.equal(data().refusalKey, 'Paused');
  await read({ rows: [refusal, { role: 'assistant', text: 'Back.' }], state: 'idle' });
  assert.equal(data().refusalKey, '');
  await read({ rows: [refusal], state: 'idle' });
  assert.equal(data().refusalKey, 'refusal-t1');
  // the next chat opens with no refusal, before its first read answers
  const second = t.open('c2', { state: 'idle' });
  assert.equal(data().refusalKey, '');
  reads.at(-1)!.answer({ rows: [], state: 'idle' });
  await second;
  t.close();
  assert.equal(data().refusalKey, '');
});

test('the limit note still wins the line over a failed turn, and a refusal over a failed turn', async () => {
  const { t, reads, read, line } = thread();
  const opened = t.open('c1', {});
  reads[0].answer({ rows: [ask, { role: 'note', text: 'Limit', limit: true }], state: 'idle', turn: { status: 'failed' } });
  await opened;
  assert.equal(line()[0], 'Limit reached');
  await read({ rows: [ask, refusal], state: 'idle', turn: { status: 'failed' } });
  assert.equal(line()[0], 'Stopped by a safety check');
  await read({ rows: [ask], state: 'idle', turn: { status: 'failed' } });
  assert.equal(line()[0], 'Failed');
});

test('the warning in a read goes to the page as it came; a read with none, another chat opening, and New chat clear it', async () => {
  const { t, reads, read, data } = thread();
  const limitWarning = { kind: 'approaching', window: '5h', resetsAt: 1_800_000_000_000, utilization: 0.9 };
  const opened = t.open('c1', {});
  assert.equal(data().warning, '');
  reads[0].answer({ rows: [ask], state: 'idle', limitWarning });
  await opened;
  assert.deepEqual(JSON.parse(data().warning), limitWarning);
  await read({ rows: [ask], state: 'idle' });
  assert.equal(data().warning, '', 'a read that says none clears it');
  await read({ rows: [ask], state: 'idle', limitWarning });
  const second = t.open('c2', { state: 'idle' });
  assert.equal(data().warning, '', 'another chat does not carry it over');
  reads.at(-1)!.answer({ rows: [], state: 'idle' });
  await second;
  await read({ rows: [], state: 'idle', limitWarning });
  t.close();
  assert.equal(data().warning, '');
});

test('a read older than the message just sent (idle, its row not there yet) does not bring the refusal line back while that turn runs', async () => {
  const { t, reads, read, line, data } = thread();
  const opened = t.open('c1', {});
  reads[0].answer({ rows: [ask, refusal], state: 'idle', turn: { status: 'failed' } });
  await opened;
  assert.deepEqual(line(), ['Stopped by a safety check', 'dot error']);
  t.sending('Say hello');
  assert.equal(line()[0], 'Working…');
  // the read that was already out when the message was sent: idle, the rows as they were
  await read({ rows: [ask, refusal], state: 'idle', turn: { status: 'failed' } });
  assert.equal(line()[0], 'Working…');
  assert.equal(data().refusalKey, '');
  // the turn ends: its rows hold the message and the reply
  await read({
    rows: [ask, refusal, { role: 'user', text: 'Say hello' }, { role: 'assistant', text: 'Hi.' }],
    state: 'idle',
    turn: { status: 'completed' },
  });
  assert.deepEqual(line(), ['Done', 'dot ok']);
});
