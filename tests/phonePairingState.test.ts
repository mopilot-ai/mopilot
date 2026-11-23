// Phone pairing cancellation, owner fencing and persistence ordering across coordinators.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhonePairing } from '../shared/remote/phonePairing.mjs';
import { decodeFrame } from '../shared/remote/envelope.mjs';
import { prim, deferred, setup } from './support/phonePairingFixture.ts';

test('cancellation retires pending operations, and overlapping attempts cannot replace each other', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin(),
    gate = deferred();
  const phone = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: { ...s.store, getIdentity: () => gate.promise },
    transport: s.transport,
    now: () => 100,
  });
  const first = phone.begin(payload, 'phone');
  await assert.rejects(phone.begin(payload, 'second'), /busy/);
  assert.equal(phone.cancel(), true);
  gate.resolve(s.identity);
  await assert.rejects(first, /cancelled/);
  await phone.begin(payload, 'retry');
  assert.equal(phone.cancel(), true);
});

test('commit cannot be cancelled or repeated while secure storage is pending', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin(),
    gate = deferred();
  const phone = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: { ...s.store, savePair: () => gate.promise },
    transport: s.transport,
    now: () => 100,
  });
  await phone.begin(payload, 'phone');
  await s.desktop.handleHello(decodeFrame(s.hello));
  const finishing = phone.finish(s.answer);
  assert.throws(() => phone.cancel(), /commit in progress/);
  await assert.rejects(phone.finish(s.answer), /no pending/);
  gate.resolve(undefined);
  await finishing;
  assert.equal(phone.cancel(), false);
});

test('cancel before joining clears only a prepared record and permits a new attempt', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin(),
    gate = deferred(),
    started = deferred();
  let joins = 0;
  const phone = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: {
      ...s.store,
      claimPending: async (p) => {
        const claimed = await s.store.claimPending(p);
        started.resolve(undefined);
        await gate.promise;
        return claimed;
      },
    },
    transport: {
      ...s.transport,
      join: async () => {
        joins++;
      },
    },
    now: () => 100,
  });
  const first = phone.begin(payload, 'phone');
  await started.promise;
  assert.equal(phone.cancel(), true);
  assert.equal(phone.status(), 'cancel-pending');
  gate.resolve(undefined);
  await assert.rejects(first, /cancelled/);
  assert.equal(await phone.pending(), null);
  assert.equal(joins, 0);
  await phone.begin(payload, 'retry');
  assert.equal(joins, 1);
});

test('two coordinators racing for one secure slot cannot overwrite or both join', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin(),
    gate = deferred(),
    atClaim = deferred();
  let joins = 0;
  const transport = {
    ...s.transport,
    join: async () => {
      joins++;
    },
  };
  const first = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: {
      ...s.store,
      claimPending: async (p) => {
        atClaim.resolve(undefined);
        await gate.promise;
        return s.store.claimPending(p);
      },
    },
    transport,
    now: () => 100,
  });
  const second = createPhonePairing({ prim, relayUrl: 'wss://relay.example/ws', store: s.store, transport, now: () => 100 });
  const one = first.begin(payload, 'one');
  await atClaim.promise;
  const two = await second.begin(payload, 'two');
  const kept = await second.pending();
  gate.resolve(undefined);
  await assert.rejects(one, /cleanup required/);
  assert.equal(joins, 1);
  assert.equal(kept?.pairId, two.pairId);
  assert.deepEqual(await second.pending(), kept);
});

test('an uncertain joined attempt remains pending across a coordinator restart', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin(),
    gate = deferred(),
    joined = deferred();
  const phone = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: s.store,
    transport: {
      ...s.transport,
      join: () => {
        joined.resolve(undefined);
        return gate.promise;
      },
    },
    now: () => 100,
  });
  const starting = phone.begin(payload, 'phone');
  await joined.promise;
  assert.equal(phone.cancel(), true);
  assert.equal(phone.status(), 'cancel-pending');
  gate.resolve(undefined);
  await assert.rejects(starting, /cancelled/);
  const restarted = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: s.store,
    transport: s.transport,
    now: () => 100,
  });
  assert.equal((await restarted.pending())?.phase, 'joining');
  await assert.rejects(restarted.begin(payload, 'new'), /cleanup required/);
});

test('a late conditional write cannot mutate a replacement claim for the same QR', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin(),
    gate = deferred(),
    atMark = deferred();
  const slow = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: {
      ...s.store,
      markJoining: async (owner) => {
        atMark.resolve(undefined);
        await gate.promise;
        await s.store.markJoining(owner);
      },
    },
    transport: s.transport,
    now: () => 100,
  });
  const old = slow.begin(payload, 'old');
  await atMark.promise;
  const prior = await slow.pending();
  assert.ok(prior);
  // Simulate a recovery authority changing the store; the coordinator itself does not provide one.
  await s.store.clearPrepared(prior.owner);
  const fresh = createPhonePairing({ prim, relayUrl: 'wss://relay.example/ws', store: s.store, transport: s.transport, now: () => 100 });
  await fresh.begin(payload, 'fresh');
  const next = await fresh.pending();
  assert.equal(next?.pairId, prior.pairId);
  assert.notEqual(next?.owner, prior.owner);
  gate.resolve(undefined);
  await assert.rejects(old);
  assert.deepEqual(await fresh.pending(), next);
});
