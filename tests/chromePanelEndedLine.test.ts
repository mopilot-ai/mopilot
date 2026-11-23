// The side panel's line under the rows says how an ended turn ended (electron/chrome-extension/src/panelThread.mjs): "Stopped" for one the user stopped, "Failed" for one that failed, "Done" otherwise (#3046, B2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thread } from './support/panel-thread.ts';

const { PROGRESS } = await import('../electron/chrome-extension/src/panelThread.mjs');

const ask = { role: 'user', text: 'Go' };

test('an idle chat whose last turn was interrupted reads "Stopped" with a muted dot; one that failed reads "Failed" with a red dot', async () => {
  const { t, read, line, reads } = thread();
  const opened = t.open('c1', {});
  reads[0].answer({ rows: [ask], state: 'idle', turn: { status: 'completed' } });
  await opened;
  assert.deepEqual(line(), ['Done', 'dot ok']);
  await read({ rows: [ask], state: 'idle', turn: { status: 'interrupted' } });
  assert.deepEqual(line(), ['Stopped', 'dot off']);
  await read({ rows: [ask], state: 'idle', turn: { status: 'failed' } });
  assert.deepEqual(line(), ['Failed', 'dot error']);
  assert.equal(PROGRESS.stopped.text, 'Stopped');
  assert.equal(PROGRESS.failed.text, 'Failed');
});

test('a turn with no status, an unknown one or a completed one stays "Done" (a harness that never reports one)', async () => {
  const { read, line, t, reads } = thread();
  const opened = t.open('c1', {});
  reads[0].answer({ rows: [ask], state: 'idle' });
  await opened;
  assert.deepEqual(line(), ['Done', 'dot ok']);
  for (const turn of [null, { status: 'completed' }, { status: 'inProgress' }, { status: 'something-new' }, {}]) {
    await read({ rows: [ask], state: 'idle', turn });
    assert.deepEqual(line(), ['Done', 'dot ok'], JSON.stringify(turn));
  }
});

test('the usage limit still wins over the turn status; a limit note with rows after it does not', async () => {
  const { read, line, t, reads } = thread();
  const opened = t.open('c1', {});
  reads[0].answer({ rows: [], state: 'idle' });
  await opened;
  const limit = { role: 'note', text: 'You hit your limit', limit: true };
  await read({ rows: [ask, limit], state: 'idle', turn: { status: 'failed' } });
  assert.deepEqual(line(), ['Limit reached', 'dot error']);
  await read({ rows: [limit, { role: 'assistant', text: 'Back.' }], state: 'idle', turn: { status: 'failed' } });
  assert.deepEqual(line(), ['Failed', 'dot error']);
});

test('an update that only says idle keeps "Stopped" and "Failed" until a turn runs; a later turn replaces them', async () => {
  const { read, line, t, reads } = thread();
  const opened = t.open('c1', {});
  reads[0].answer({ rows: [ask], state: 'idle', turn: { status: 'interrupted' } });
  await opened;
  t.turn('idle');
  assert.deepEqual(line(), ['Stopped', 'dot off']);
  // the next turn runs, then finishes cleanly
  t.turn('running');
  assert.deepEqual(line(), ['Working…', 'dot wait']);
  t.turn('idle');
  assert.deepEqual(line(), ['Done', 'dot ok']);
  await read({ rows: [ask], state: 'idle', turn: { status: 'completed' } });
  assert.deepEqual(line(), ['Done', 'dot ok']);
  // a failed turn, kept through an idle update, then a follow-up sent from the panel
  await read({ rows: [ask], state: 'idle', turn: { status: 'failed' } });
  t.turn('idle');
  assert.deepEqual(line(), ['Failed', 'dot error']);
  t.sending('Try again');
  assert.deepEqual(line(), ['Working…', 'dot wait']);
  // a running read of a chat whose last turn failed is running, not failed
  await read({ rows: [ask], state: 'running', turn: { status: 'failed' } });
  assert.deepEqual(line(), ['Working…', 'dot wait']);
});

test('opening another chat does not carry the last one’s "Stopped" or "Failed" over', async () => {
  const { t, line, reads } = thread();
  const first = t.open('c1', {});
  reads[0].answer({ rows: [ask], state: 'idle', turn: { status: 'failed' } });
  await first;
  assert.deepEqual(line(), ['Failed', 'dot error']);
  // the next chat reads Done at once, before its own first read answers, then how it ended
  const second = t.open('c2', { state: 'idle' });
  assert.deepEqual(line(), ['Done', 'dot ok']);
  reads[1].answer({ rows: [ask], state: 'idle', turn: { status: 'interrupted' } });
  await second;
  assert.deepEqual(line(), ['Stopped', 'dot off']);
  // and a chat opened as it runs is running whatever the last one was
  const third = t.open('c3', { state: 'running' });
  assert.deepEqual(line(), ['Working…', 'dot wait']);
  reads[2].answer({ rows: [ask], state: 'running', turn: { status: 'inProgress' } });
  await third;
  assert.deepEqual(line(), ['Working…', 'dot wait']);
});

test('the running turn’s own start reaches the page; it is cleared when the turn ends, a new one begins, or another chat opens', async () => {
  const { t, els, read, reads } = thread();
  const start = () => els.chat.dataset.turnStart;
  const opened = t.open('c1', { state: 'running' });
  assert.equal(start(), '');
  reads[0].answer({ rows: [ask], state: 'running', turn: { status: 'inProgress', startedAt: 1_700_000_000.4 } });
  await opened;
  assert.equal(start(), '1700000000400');
  // not a start we can use: none, a zero, a non-number, or no turn at all (main decides which turn can be the running one)
  for (const turn of [{ status: 'inProgress' }, { status: 'inProgress', startedAt: 0 }, { status: 'inProgress', startedAt: 'x' }, null]) {
    await read({ rows: [ask], state: 'running', turn });
    assert.equal(start(), '', JSON.stringify(turn));
  }
  await read({ rows: [ask], state: 'running', turn: { status: 'inProgress', startedAt: 50 } });
  assert.equal(start(), '50000');
  // an idle read clears it, so does the idle update
  await read({ rows: [ask], state: 'idle', turn: { status: 'completed', startedAt: 50 } });
  assert.equal(start(), '');
  await read({ rows: [ask], state: 'running', turn: { status: 'inProgress', startedAt: 60 } });
  t.turn('idle');
  assert.equal(start(), '');
  // a turn that begins from here does not borrow the one before it
  await read({ rows: [ask], state: 'running', turn: { status: 'inProgress', startedAt: 70 } });
  t.turn('idle');
  await read({ rows: [ask], state: 'running', turn: { status: 'inProgress', startedAt: 80 } });
  t.newReply();
  assert.equal(start(), '');
  await read({ rows: [ask], state: 'running', turn: { status: 'inProgress', startedAt: 90 } });
  t.close();
  assert.equal(start(), '');
  const next = t.open('c2', {});
  assert.equal(start(), '');
  reads.at(-1)!.answer({ rows: [], state: 'idle' });
  await next;
});

test('a panel that saw the turn begin counts from there: main’s start (maybe the turn before’s) is not used', async () => {
  const { t, els, read, reads } = thread();
  // opened with a message sent from here
  const opened = t.open('c1', { sent: 'Go' });
  reads[0].answer({ rows: [], state: 'running', turn: { status: 'completed', startedAt: 5 } });
  await opened;
  assert.equal(els.chat.dataset.turnStart, '');
  // a turn that began while it watched
  t.turn('idle');
  t.turn('running');
  await read({ rows: [ask], state: 'running', turn: { status: 'inProgress', startedAt: 60 } });
  assert.equal(els.chat.dataset.turnStart, '');
  // one it joined: opened while it ran
  const joined = t.open('c2', { state: 'running' });
  reads.at(-1)!.answer({ rows: [ask], state: 'running', turn: { status: 'inProgress', startedAt: 60 } });
  await joined;
  assert.equal(els.chat.dataset.turnStart, '60000');
  // and the turn after it, which it sees begin
  t.turn('idle');
  t.turn('running');
  await read({ rows: [ask], state: 'running', turn: { status: 'inProgress', startedAt: 90 } });
  assert.equal(els.chat.dataset.turnStart, '');
});
