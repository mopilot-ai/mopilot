// Cleanup captures a pending owner before waiting and never adopts an unrelated late claim.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupTarget } from '../shared/remote/phoneCleanup.mjs';

test('captured target survives settlement and never adopts an unrelated new owner', async () => {
  const old = { owner: 'old', pairId: 'p_old' },
    next = { owner: 'new', pairId: 'p_new' };
  let reads = 0;
  assert.equal(
    await cleanupTarget({
      getPending: async () => (++reads === 1 ? old : next),
      settling: Promise.resolve(),
      localOwner: () => null,
      current: () => true,
    }),
    old,
  );
  reads = 0;
  assert.equal(
    await cleanupTarget({
      getPending: async () => (++reads === 1 ? null : next),
      settling: Promise.reject(new Error('cancelled')),
      localOwner: () => 'old',
      current: () => true,
    }),
    null,
  );
  reads = 0;
  assert.equal(
    await cleanupTarget({
      getPending: async () => (++reads === 1 ? null : old),
      settling: Promise.resolve(),
      localOwner: () => 'old',
      current: () => true,
    }),
    old,
  );
});

test('retired work stops after each asynchronous boundary', async () => {
  for (const boundary of [1, 2, 3]) {
    let checks = 0,
      reads = 0;
    await assert.rejects(
      cleanupTarget({
        getPending: async () => (++reads === 1 ? null : { owner: 'old' }),
        settling: Promise.resolve(),
        localOwner: () => 'old',
        current: () => ++checks !== boundary,
      }),
      /cancelled/,
    );
  }
});
