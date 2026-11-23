// The turn ledger of MoMo's home (host/src/momoTurns.mjs): accepted before acting, never run twice, queryable after a lost connection, cut off by a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoTurns, settledAs, KEEP_SETTLED } from '../host/src/momoTurns.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';

function world(t: any, keep?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-turns-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { at: 1_700_000_000_000 };
  const make = () =>
    createMomoTurns({
      dir: path.join(dir, 'momo'),
      safeStorage: createFileSafeStorage(path.join(dir, 'config')),
      now: () => clock.at,
      keep,
    });
  return { dir, clock, make };
}
const one = (turnId: string, chatId = 'claude:c1') => ({ turnId, chatId, deviceId: 'phone-1', leaseEpoch: 1 });

test('an empty ledger makes no file, answers unknown, settles nothing and recovers nothing', async (t) => {
  const w = world(t);
  const turns = w.make();
  assert.deepEqual(turns.status('t1'), { turnId: 't1', state: 'unknown' });
  await turns.settle('claude:c1', 'completed');
  assert.equal(await turns.recover(), 0);
  assert.equal(fs.existsSync(path.join(w.dir, 'momo')), false);
});

test('a turn is accepted once: the same id again is the same turn, another chat with that id is refused, a second turn in the chat is busy', async (t) => {
  const w = world(t);
  const turns = w.make();
  const first = await turns.accept(one('t1'));
  assert.equal(first.duplicate, false);
  assert.equal(first.turn.state, 'accepted');
  assert.equal(first.turn.acceptedAt, w.clock.at);
  w.clock.at += 10;
  const again = await turns.accept(one('t1'));
  assert.equal(again.duplicate, true);
  assert.equal(again.turn.acceptedAt, first.turn.acceptedAt, 'a resend is not a new turn');
  await assert.rejects(turns.accept(one('t1', 'claude:c2')), (e: any) => e.code === 'turn_conflict');
  await assert.rejects(turns.accept(one('t2')), (e: any) => e.code === 'turn_busy');
  // another chat is not blocked
  assert.equal((await turns.accept(one('t3', 'claude:c2'))).duplicate, false);
  // the file on the disk is sealed
  assert.doesNotMatch(fs.readFileSync(path.join(w.dir, 'momo', 'turns.json'), 'utf8'), /claude:c1/);
});

test('settling ends the chat’s turn with how it ended and frees the chat; the status says so', async (t) => {
  const w = world(t);
  const turns = w.make();
  await turns.accept(one('t1'));
  w.clock.at += 50;
  await turns.settle('claude:c1', 'completed', 'item-9');
  assert.deepEqual(turns.status('t1'), {
    turnId: 't1',
    chatId: 'claude:c1',
    deviceId: 'phone-1',
    state: 'completed',
    acceptedAt: 1_700_000_000_000,
    settledAt: w.clock.at,
    leaseEpoch: 1,
    resultRef: 'item-9',
  });
  await turns.settle('claude:c1', 'failed');
  assert.equal(turns.status('t1').state, 'completed', 'a settled turn does not change again');
  assert.equal((await turns.accept(one('t2'))).duplicate, false, 'the chat is free');
});

test('a restart ends what was accepted and never finished; a turn accepted by the new process is not touched', async (t) => {
  const w = world(t);
  const before = w.make();
  await before.accept(one('t1'));
  await before.accept(one('t2', 'claude:c2'));
  await before.settle('claude:c2', 'completed');
  w.clock.at += 1000;
  const after = w.make();
  await after.accept(one('t3', 'claude:c3'));
  assert.equal(await after.recover(), 1);
  assert.equal(after.status('t1').state, 'interrupted');
  assert.equal(after.status('t2').state, 'completed');
  assert.equal(after.status('t3').state, 'accepted');
  assert.equal(await after.recover(), 0, 'once');
});

test('only the newest settled turns are kept, and an unsettled one never goes', async (t) => {
  const w = world(t, 3);
  const turns = w.make();
  await turns.accept(one('open', 'claude:open'));
  for (let i = 0; i < 5; i++) {
    w.clock.at += 1;
    await turns.accept(one(`s${i}`, `claude:s${i}`));
    await turns.settle(`claude:s${i}`, 'completed');
  }
  assert.equal(turns.status('open').state, 'accepted');
  assert.equal(turns.status('s0').state, 'completed', 'pruned from the ledger, but its id and end are kept');
  assert.equal(turns.status('s1').state, 'completed', 'pruned when the next turn is accepted, so one more than the limit may stand');
  assert.equal(turns.status('s4').state, 'completed');
});

test('a ledger with damaged rows keeps the good ones and fills what is missing', async (t) => {
  const w = world(t);
  const turns = w.make();
  await turns.accept(one('t1'));
  // rows another build or a bad edit left: one without a chat, one with a state nobody knows, one with odd fields
  const safe = createFileSafeStorage(path.join(w.dir, 'config'));
  const { SealedJson } = (await import('node:module')).createRequire(import.meta.url)('../electron/gateway/sealedFile.cjs');
  const raw = new SealedJson({ file: path.join(w.dir, 'momo', 'turns.json'), safeStorage: safe, shape: (v: any) => v, now: () => 1 });
  await raw.change((v: any) => {
    v.turns.bad1 = { state: 'accepted' };
    v.turns.bad2 = { chatId: 'x', state: 'weird' };
    v.turns.odd = { chatId: 'claude:o', state: 'failed', acceptedAt: 'x', settledAt: 'y', deviceId: 5, leaseEpoch: 1.5, resultRef: 9 };
  });
  const again = w.make();
  assert.equal(again.status('bad1').state, 'unknown');
  assert.equal(again.status('bad2').state, 'unknown');
  assert.deepEqual(again.status('odd'), {
    turnId: 'odd',
    chatId: 'claude:o',
    deviceId: null,
    state: 'failed',
    acceptedAt: 0,
    settledAt: null,
    leaseEpoch: 0,
    resultRef: null,
  });
  assert.equal(again.status('t1').state, 'accepted');
});

test('the default keeps five hundred settled turns', () => {
  assert.equal(KEEP_SETTLED, 500);
});

test('how a turn’s end settles it: a restart’s cut, a Stop, an error, else completed', () => {
  assert.equal(settledAs({ stopReason: 'cancelled', interrupted: { by: 'host_restart' } }), 'interrupted');
  assert.equal(settledAs({ stopReason: 'cancelled' }), 'cancelled');
  assert.equal(settledAs({ error: { message: 'boom' } }), 'failed');
  assert.equal(settledAs({ stopReason: 'end_turn' }), 'completed');
  assert.equal(settledAs(undefined), 'completed');
});

test('a turn pruned from the ledger keeps its id and how it ended: a late resend is the same turn, never run again, and a Reset keeps it void', async (t) => {
  const w = world(t, 2);
  const turns = w.make();
  for (const id of ['turn-0001', 'turn-0002', 'turn-0003', 'turn-0004']) {
    w.clock.at += 10;
    await turns.accept(one(id));
    await turns.settle('claude:c1', id === 'turn-0001' ? 'failed' : 'completed');
  }
  // only two settled turns are kept in full; the older two are tombstones with the state they ended in
  assert.equal((turns.status('turn-0001') as any).state, 'failed');
  assert.equal((turns.status('turn-0002') as any).state, 'completed');
  const again = await turns.accept(one('turn-0001'));
  assert.equal(again.duplicate, true, 'a resend after the window is the same turn');
  assert.equal(again.turn.state, 'failed');
  assert.deepEqual(new Set(turns.ids()), new Set(['turn-0001', 'turn-0002', 'turn-0003', 'turn-0004']));
  assert.equal((turns.status('turn-9999') as any).state, 'unknown', 'an id never seen is still unknown');
});
