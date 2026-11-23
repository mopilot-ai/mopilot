// Overlapping compaction release/preflight ownership and retry paths use one main-owned input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tick, codex } from './support/controller/fixture';
import { EMPTY_SESSION } from '../src/store/session/sessionState';
import '../src/lib/native/session';
import '../src/lib/native/contracts/harnesses';
const require = createRequire(import.meta.url);
const { assertInputCurrent } = require('../electron/session/contract/inputGuard.cjs');
const signal = (c: any, phase: string) =>
  c.onCodexMessage(
    codex(`item/${phase}`, {
      threadId: 't1',
      turnId: 'turn-1',
      item: { type: 'contextCompaction', id: 'c1' },
    }),
  );
const input = (id: string) => ({ id, text: id, opts: { human: true }, followUp: 'steer' });
async function running() {
  const f = setup({ auto: false });
  f.c.send('t1', input('first'), 1);
  f.execs[0].done({ started: true, turnId: 'turn-1' });
  await tick();
  const steer = f.c.codex.steer;
  f.c.codex.steer = (...args: any[]) => {
    assertInputCurrent(args[2]);
    return steer(...args);
  };
  return f;
}

test('renderer and main start with no compaction waiting state', () => {
  assert.equal(EMPTY_SESSION.compaction, null);
  assert.equal(setup().s('fresh').compaction, null);
});

test('a late preflight restoration joins an already releasing compaction without a second dispatch', async () => {
  const { c, execs, s } = await running();
  let preflight!: () => void;
  let settle!: () => void;
  c.beforeDispatch = () =>
    new Promise<void>((r) => {
      preflight = r;
    });
  c.onDispatchResult = () =>
    new Promise<void>((r) => {
      settle = r;
    });
  const receipt = c.send('t1', input('preflight'), 1, true);
  signal(c, 'started');
  c.send('t1', input('held'), 1);
  preflight();
  await tick();
  c.beforeDispatch = null;
  c.onDispatchResult = null;
  signal(c, 'completed');
  assert.equal(execs.length, 2);
  settle();
  assert.deepEqual(await receipt, { action: 'queued', id: 'preflight' });
  assert.equal(execs.length, 2);
  execs[1].done({ started: true });
  await tick();
  assert.equal(execs.length, 3);
  assert.equal(execs[2].item.id, 'preflight');
  execs[2].done({ started: true });
  await tick();
  assert.equal(s('t1').queue.length, 0);
});

test('a refused release waits for its turn to end without promoting later held or ordinary messages', async () => {
  const { c, execs, s } = await running();
  c.send('t1', { ...input('ordinary'), followUp: 'queue' }, 1);
  signal(c, 'started');
  c.send('t1', input('refused'), 1);
  c.send('t1', input('later'), 1);
  assert.deepEqual(await c.sendNow('t1', 'later', 1, true), { status: 'queued', waitingFor: 'compaction' });
  signal(c, 'completed');
  execs[1].done({ started: false, error: 'not accepted' });
  await tick();
  assert.equal(execs.length, 2);
  // held for the turn after this one (issue 1366: Codex refuses steers into its own compaction turn)
  assert.equal(s('t1').queue.find((q: any) => q.id === 'refused').waitingFor, 'compaction');
  assert.equal(s('t1').queue.find((q: any) => q.id === 'later').waitingFor, 'compaction');
  assert.equal(s('t1').queue.find((q: any) => q.id === 'ordinary').waitingFor, undefined);
  c.noteStop('t1');
  assert.equal(s('t1').queue.find((q: any) => q.id === 'refused').waitingFor, 'compactionRetry');
  assert.equal(s('t1').queue.find((q: any) => q.id === 'later').waitingFor, 'compactionRetry');
});

test('direct start and steer admissions keep existing input and obsolete goals remain discarded', async () => {
  const { c, execs, s } = await running();
  signal(c, 'started');
  assert.equal((await c.startOrKeep('t1', input('start'))).compactionQueued, true);
  assert.equal((await c.steer('t1', input('steer'), 1)).compactionQueued, true);
  c.obsoleteGoalCommand = () => true;
  assert.deepEqual(await c.steer('t1', input('obsolete'), 1), { started: false, discarded: true });
  assert.deepEqual(
    s('t1').queue.map((q: any) => q.id),
    ['start', 'steer'],
  );
  assert.equal(execs.length, 1);
});

test('Claude unconfirmed completion never labels an ordinary next-turn message as compaction input', async () => {
  const { c, execs, s } = setup({ auto: false });
  const chat = 'claude:s1';
  c.send(chat, input('first'), 1);
  execs[0].done({ started: true });
  await tick();
  c.send(chat, { ...input('ordinary'), followUp: 'queue' }, 1);
  for (const status of ['compacting', null]) {
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'system', subtype: 'status', session_id: 's1', status } });
    if (status) c.send(chat, input('held'), 1);
  }
  assert.equal(s(chat).queue[0].waitingFor, undefined);
  assert.equal(s(chat).queue[1].waitingFor, 'compactionRetry');
});

test('queued steer receipts include compaction timing even when the hold begins during dispatch preflight', async () => {
  const { c, execs, s } = await running();
  c.send('t1', { ...input('queued'), followUp: 'queue' }, 1);
  let resume!: () => void;
  c.beforeDispatch = () =>
    new Promise<void>((r) => {
      resume = r;
    });
  const receipt = c.sendNow('t1', 'queued', null, true);
  signal(c, 'started');
  resume();
  assert.deepEqual(await receipt, { status: 'queued', waitingFor: 'compaction' });
  assert.equal(s('t1').queue.length, 1);
  assert.equal(execs.length, 1);
});

test('Send now carries deferred compaction ownership and native held receipts without claiming sent', async () => {
  for (const [result, receipt] of [
    [{ started: false, held: true }, { status: 'held' }],
    [
      { started: false, compactionQueued: true },
      { status: 'queued', waitingFor: 'compaction' },
    ],
  ]) {
    const { c } = await running();
    c.send('t1', { ...input('queued'), followUp: 'queue' }, 1);
    c.steer = async () => result;
    assert.deepEqual(await c.sendNow('t1', 'queued', 1, true), receipt);
  }
});
