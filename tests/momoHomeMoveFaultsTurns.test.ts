// Turns and the newest lease seen across a move of MoMo's home: pruned turns (gone) and void ids resent after a move are never run twice, a send that throws settles as failed wherever the move is, and a receiver remembers the newest lease it saw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createMomoTurns } from '../host/src/momoTurns.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { twoMachines, drive, violations, sealedHashes, IDS, OPEN_TURN, type Machine } from './momoEvals/home/world.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A ledger over a machine's own turns file with a tiny window, so older settled turns are pruned into `gone`. */
const smallWindow = (m: Machine, keep: number) =>
  createMomoTurns({ dir: m.momoDir, safeStorage: createFileSafeStorage(m.keyDir), now: () => m.w.at, keep });

test('a turn pruned past the window keeps its id and end: resent after a move it is the same turn, on the new home, never run again', async () => {
  const w = await twoMachines();
  const ledger = smallWindow(w.m.A!, 2);
  for (let i = 1; i <= 5; i++) {
    await ledger.accept({ turnId: `key-pruned-${i}`, chatId: `claude:p${i}`, deviceId: 'phone', leaseEpoch: 1 });
    w.tick(10);
    await ledger.settle(`claude:p${i}`, i === 2 ? 'failed' : 'completed');
  }
  await ledger.accept({ turnId: 'key-pruned-6', chatId: 'claude:p6', deviceId: 'phone', leaseEpoch: 1 }); // prunes the oldest into `gone`
  await ledger.settle('claude:p6', 'completed');
  assert.equal(ledger.status('key-pruned-1').state, 'completed');
  assert.equal(ledger.status('key-pruned-2').state, 'failed');
  assert.equal((await drive(w)).ok, true);
  const b = w.m.B!.home;
  for (const [id, state] of [
    ['key-pruned-1', 'completed'],
    ['key-pruned-2', 'failed'],
    ['key-pruned-6', 'completed'],
  ] as const) {
    assert.equal((await b.turn(id)).state, state, `${id} read on the new home`);
    assert.equal(await w.sendTurn('B', id, id === 'key-pruned-6' ? 'claude:p6' : 'claude:other'), 'duplicate', `${id} resent`);
  }
  assert.equal(await w.sendTurn('B', 'key-never-seen'), 'run');
  assert.deepEqual(
    [...w.turnRuns.entries()].filter(([, k]) => k.length > 1),
    [],
  );
  w.dispose();
});

test('ids a Reset deleted stay void across a move: the new home reads them settled and never "unknown", so they are never sent again', async () => {
  const w = await twoMachines();
  assert.equal(await w.sendTurn('A', 'key-before-reset', 'claude:r1'), 'run');
  await w.m.A!.home.stores().turns.settle('claude:r1', 'completed');
  await w.m.A!.home.reset();
  assert.equal(w.m.A!.home.voided('key-before-reset'), true);
  assert.equal((await drive(w)).ok, true);
  const b = w.m.B!.home;
  assert.equal(b.voided('key-before-reset'), true, 'the void ids moved with MoMo');
  assert.deepEqual([(await b.turn('key-before-reset')).state, (await b.turn('key-before-reset')).void], ['cancelled', true]);
  assert.deepEqual(await violations(w, sealedHashes(w)), []);
  w.dispose();
});

test('a send that throws settles its turn as failed wherever the move is, and the id is the same turn afterwards on either machine', async () => {
  for (const when of ['before-begin', 'after-begin', 'after-move'] as const) {
    const w = await twoMachines();
    await w.m.A!.home.stores().turns.settle('claude:c1', 'completed'); // the seeded turn is done; this test's turns follow
    assert.equal(await w.sendTurn('A', `key-throws-${when}`, 'claude:t1'), 'run');
    const fail = async (m: Machine) => {
      m.home.turnEnded('claude:t1', { error: true }); // what the chat veil does when the send threw before the chat took it
      await sleep(40);
    };
    if (when === 'before-begin') await fail(w.m.A!);
    if (when === 'after-begin') {
      await w.net.side('A').call('begin', { moveId: 'move-0001' });
      await fail(w.m.A!); // paused: its stores are closed, the turn was parked at begin
      await w.net.side('A').call('cancel', { moveId: 'move-0001' });
    }
    const r = await drive(w, { moveId: when === 'after-begin' ? 'move-0002' : 'move-0001' });
    assert.equal(r.ok, true, when);
    if (when === 'after-move') await fail(w.m.B!);
    const state = (await w.m.B!.home.turn(`key-throws-${when}`)).state;
    assert.equal(state, when === 'before-begin' ? 'failed' : when === 'after-begin' ? 'interrupted' : 'interrupted', when);
    assert.equal(await w.sendTurn('B', `key-throws-${when}`, 'claude:t1'), 'duplicate', `${when}: resent after the move`);
    assert.equal(w.turnRuns.get(`key-throws-${when}`)!.length, 1, when);
    w.dispose();
  }
});

test('a turn accepted before a move that is cancelled and tried again is the same turn on the old home and on the new one', async () => {
  const w = await twoMachines();
  assert.equal(await w.sendTurn('A', 'key-through-moves', 'claude:m1'), 'run');
  w.net.faults = [{ machine: 'B', op: 'receive', kind: 'drop-req' }];
  assert.equal((await drive(w, { moveId: 'move-0001' })).ok, false);
  assert.equal(await w.sendTurn('A', 'key-through-moves', 'claude:m1'), 'duplicate', 'after the cancel, on the old home');
  assert.equal((await drive(w, { moveId: 'move-0002' })).ok, true);
  assert.equal(await w.sendTurn('B', 'key-through-moves', 'claude:m1'), 'duplicate', 'after the move, on the new home');
  assert.equal(await w.sendTurn('A', 'key-through-moves', 'claude:m1'), 'away');
  assert.equal(w.turnRuns.get('key-through-moves')!.length, 1);
  assert.equal(w.turnRuns.get(OPEN_TURN)!.length, 1);
  w.dispose();
});

test('a receiver that saw the reclaimed home keeps the newest lease across its own restart, even when it is killed right after taking the stamp', async () => {
  const w = await twoMachines({ third: true });
  const c = w.m.C!;
  assert.equal((await c.home.receiveStamp({ homeId: IDS.A.homeId, leaseEpoch: 3 })).ok, true);
  c.kill(); // no state change of this machine after the answer
  c.restart();
  assert.equal((await c.home.receiveStamp({ homeId: IDS.B.homeId, leaseEpoch: 2 })).ok, false, 'the older twin is still refused');
  w.dispose();
});

test('a receiver that had time to write the newest lease keeps it across a restart', async () => {
  const w = await twoMachines({ third: true });
  const c = w.m.C!;
  assert.equal((await c.home.receiveStamp({ homeId: IDS.A.homeId, leaseEpoch: 3 })).ok, true);
  await sleep(60);
  c.kill();
  c.restart();
  assert.deepEqual(
    [
      (await c.home.receiveStamp({ homeId: IDS.B.homeId, leaseEpoch: 2 })).ok,
      (await c.home.receiveStamp({ homeId: IDS.A.homeId, leaseEpoch: 3 })).ok,
    ],
    [false, true],
  );
  assert.equal((await c.home.receiveStamp({ homeId: IDS.B.homeId, leaseEpoch: 3 })).reason, 'two-homes');
  w.dispose();
});
