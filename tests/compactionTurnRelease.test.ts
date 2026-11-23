// Issue 1366: a refused release (Codex's /compact turn takes no steer, or the turn ended first) runs once as the next turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick, codex } from './support/controller/fixture';

const steer = (id: string) => ({ id, text: `input ${id}`, opts: { human: true }, followUp: 'steer' });
const compaction = (phase: 'active' | 'complete') =>
  codex(phase === 'active' ? 'item/started' : 'item/completed', {
    threadId: 't1',
    turnId: 'compact-turn',
    item: { type: 'contextCompaction', id: 'c-1' },
  });

/** A Codex chat running its manual compaction turn, with two steers held during it and the first release refused. */
async function refusedRelease(error = 'cannot steer a compact turn') {
  const f = setup({ auto: false });
  f.c.send('t1', { text: '/compact', opts: { human: true } }, 1);
  f.execs[0].done({ started: true, turnId: 'compact-turn' });
  await tick();
  f.c.onCodexMessage(compaction('active'));
  f.c.send('t1', steer('one'), 2);
  f.c.send('t1', steer('two'), 2);
  f.c.onCodexMessage(compaction('complete'));
  assert.equal(f.execs[1].kind, 'steer');
  f.execs[1].done({ started: false, error });
  await tick();
  return f;
}

test('a steer the compaction turn refuses stays held, and nothing else is steered into that turn', async () => {
  const { c, execs, s } = await refusedRelease();
  assert.equal(execs.length, 2);
  assert.deepEqual(
    s('t1').queue.map((q: any) => [q.id, q.waitingFor]),
    [
      ['one', 'compaction'],
      ['two', 'compaction'],
    ],
  );
  // a duplicate completion does not try the refused turn again
  c.onCodexMessage(compaction('complete'));
  await tick();
  assert.equal(execs.length, 2);
});

for (const error of ['cannot steer a compact turn', 'no active turn to steer'])
  test(`when the compaction turn completes after "${error}", the held input runs once as the next turns, in order`, async () => {
    const { c, execs, s } = await refusedRelease(error);
    c.end('t1');
    assert.equal(execs.length, 3);
    assert.equal(execs[2].kind, 'turn');
    assert.equal(execs[2].item.id, 'one');
    assert.equal(execs[2].item.waitingFor, undefined);
    assert.deepEqual(
      s('t1').queue.map((q: any) => [q.id, q.waitingFor]),
      [['two', undefined]],
    );
    execs[2].done({ started: true, turnId: 'next-turn' });
    await tick();
    c.end('t1');
    assert.equal(execs.length, 4);
    assert.equal(execs[3].item.id, 'two');
    execs[3].done({ started: true, turnId: 'last-turn' });
    await tick();
    c.end('t1');
    assert.equal(execs.length, 4);
    assert.equal(s('t1').queue.length, 0);
  });

for (const ending of ['stopped', 'failed'] as const)
  test(`a compaction turn that ends ${ending} keeps the held input for retry and sends nothing`, async () => {
    const { c, execs, s } = await refusedRelease();
    if (ending === 'stopped') c.end('t1', { drain: false });
    else c.end('t1', { outcome: 'failed' });
    await tick();
    assert.equal(execs.length, 2);
    assert.deepEqual(
      s('t1').queue.map((q: any) => q.waitingFor),
      ['compactionRetry', 'compactionRetry'],
    );
  });

test('a release refused after its turn already ended and was retried stays retryable', async () => {
  const f = setup({ auto: false });
  f.c.send('t1', { text: '/compact', opts: { human: true } }, 1);
  f.execs[0].done({ started: true, turnId: 'compact-turn' });
  await tick();
  f.c.onCodexMessage(compaction('active'));
  f.c.send('t1', steer('one'), 2);
  f.c.onCodexMessage(compaction('complete'));
  // the turn completes while the steer is on its way, and the app-server refuses it
  f.c.end('t1');
  f.execs[1].done({ started: false, error: 'no active turn to steer' });
  await tick();
  // the controller starts it as the next turn instead; when that is refused too, it is kept for retry
  assert.equal(f.execs[2].kind, 'turn');
  f.execs[2].done({ started: false, error: 'transport closed' });
  await tick();
  assert.deepEqual(
    f.s('t1').queue.map((q: any) => [q.id, q.waitingFor]),
    [['one', 'compactionRetry']],
  );
});

test('input sent while a refused release waits is held behind it and runs after it, in the order it was sent', async () => {
  const { c, execs, s } = await refusedRelease();
  assert.deepEqual(await c.send('t1', steer('three'), 2, true), { action: 'queued', id: 'three' });
  assert.equal(execs.length, 2);
  assert.deepEqual(
    s('t1').queue.map((q: any) => [q.id, q.waitingFor]),
    [
      ['one', 'compaction'],
      ['two', 'compaction'],
      ['three', 'compaction'],
    ],
  );
  c.end('t1');
  assert.equal(execs[2].item.id, 'one');
  assert.deepEqual(
    s('t1').queue.map((q: any) => q.id),
    ['two', 'three'],
  );
});

test('a Claude release refused while its turn runs also waits for that turn and then runs once', async () => {
  const f = setup({ auto: false });
  const chat = 'claude:s1';
  const status = (msg: any) =>
    f.c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'system', subtype: 'status', session_id: 's1', ...msg } });
  f.c.send(chat, { text: '/compact', opts: { human: true } }, 1);
  f.execs[0].done({ started: true, turnId: 'compact-turn' });
  await tick();
  status({ status: 'compacting' });
  f.c.send(chat, steer('one'), 2);
  status({ status: null, compact_result: 'success' });
  assert.equal(f.execs[1].kind, 'claude-steer');
  f.execs[1].done({ started: false, error: 'not accepted' });
  await tick();
  assert.deepEqual(
    f.s(chat).queue.map((q: any) => [q.id, q.waitingFor]),
    [['one', 'compaction']],
  );
  f.c.end(chat);
  assert.equal(f.execs[2].kind, 'claude-turn');
  assert.equal(f.execs[2].item.id, 'one');
  f.execs[2].done({ started: true, turnId: 'next' });
  await tick();
  assert.equal(f.s(chat).queue.length, 0);
});
