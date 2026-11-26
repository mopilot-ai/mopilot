// The checkpoint walker (shared/remote/crypto.mjs createWalker) both sides use to reach a far frame: true chain values only, resumed from the largest cached point at or below the target, work bounded per saved counter, dropped when the saved counter changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCrypto, createWalker, CATCH_UP_SKIP } from '../shared/remote/crypto.mjs';
import { toHex } from '../shared/remote/envelope.mjs';

const require = createRequire(import.meta.url);
const { createSodiumPrimitives } = require('../electron/platform/sodiumPrimitives.cjs');
const c = createCrypto(createSodiumPrimitives());
const root = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

/** A walker over a counting advance, and the true chain `n` counters past `base`. */
function rig(o: { stride?: number; cap?: number; chunk?: number } = {}) {
  const work = { steps: 0, calls: 0 };
  const walker = createWalker((chain: Uint8Array, n: number) => ((work.steps += n), work.calls++, c.advance(chain, n)), o);
  const truth = (base: { chain: Uint8Array }, n: number) => toHex(c.advance(base.chain, n));
  return { work, walker, truth };
}
const base = (ctr = 10) => ({ ctr, chain: root });

test('the chain at the target is the true chain, and a target at the base is the base chain', async () => {
  const r = rig({ stride: 8, cap: 100 });
  assert.equal(toHex((await r.walker.walkTo(base(), 10))!), toHex(root));
  assert.equal(r.work.steps, 0);
  for (const target of [11, 17, 18, 19, 42]) {
    assert.equal(toHex((await r.walker.walkTo(base(), target))!), r.truth(base(), target - 10), `target ${target}`);
  }
});

test('a repeat costs nothing and a nearer target resumes from the largest cached point, never from beyond it', async () => {
  const r = rig({ stride: 8, cap: 100 });
  await r.walker.walkTo(base(), 50); // 40 steps: checkpoints at +8, +16, +24, +32, +40; the last 0 steps are aligned
  assert.equal(r.work.steps, 40);
  await r.walker.walkTo(base(), 50);
  assert.equal(r.work.steps, 40, 'the same target again costs nothing');
  const w = r.work.steps;
  assert.equal(
    toHex((await r.walker.walkTo(base(), 33))!),
    r.truth(base(), 23),
    'a target below a cached point resumes from the point under it',
  );
  assert.equal(r.work.steps - w, 23 - 16, 'resumed from +16, not from the base and not from +24');
  const x = r.work.steps;
  await r.walker.walkTo(base(), 55); // the last aligned point is +40 (the target is +45): only the 5 past it are walked
  assert.equal(r.work.steps - x, 5);
  await r.walker.walkTo(base(), 55);
  assert.equal(r.work.steps - x, 5, 'the last walked target is kept as the tail, so a repeat costs nothing');
});

test('many forged far targets cost at most the cap plus one stride each', async () => {
  const r = rig({ stride: 8, cap: 100 });
  const targets = [110, 60, 105, 109, 110, 77];
  for (const t of targets) await r.walker.walkTo(base(), t);
  assert.ok(r.work.steps <= 100 + 8 * targets.length, `walked ${r.work.steps}`);
});

test('the cache is dropped when the saved counter changes', async () => {
  const r = rig({ stride: 8, cap: 100 });
  await r.walker.walkTo(base(), 50);
  const w = r.work.steps;
  const moved = { ctr: 12, chain: c.advance(root, 2) };
  assert.equal(toHex((await r.walker.walkTo(moved, 50))!), r.truth(base(), 40));
  assert.equal(r.work.steps - w, 38, 'walked again from the new base, nothing of the old base was reused');
});

test('a target behind the base or more than the cap past it is not walked', async () => {
  const r = rig({ stride: 8, cap: 100 });
  assert.equal(await r.walker.walkTo(base(), 9), null);
  assert.equal(await r.walker.walkTo(base(), 111), null);
  assert.equal(r.work.steps, 0);
  assert.ok(await r.walker.walkTo(base(), 110));
});

test('the walk gives back after each chunk', async () => {
  const r = rig({ stride: 8, cap: 100 });
  let breaks = 0;
  await r.walker.walkTo(base(), 30, { yieldFn: async () => void breaks++ });
  assert.equal(breaks, 3, '20 steps in chunks of 8, 8 and 4');
});

test('not alive: the walk stops at the next chunk and nothing past it is cached', async () => {
  const r = rig({ stride: 8, cap: 100 });
  let live = true;
  assert.equal(await r.walker.walkTo(base(), 60, { alive: () => live, yieldFn: async () => void (live = false) }), null);
  assert.equal(r.work.steps, 8, 'one chunk, then it stopped');
  assert.equal(toHex((await r.walker.walkTo(base(), 60))!), r.truth(base(), 50), 'what was cached is still the true chain');
  assert.equal(r.work.steps, 8 + 42, 'and it was reused');
});

test('the defaults: stride 1024, cap CATCH_UP_SKIP', async () => {
  const work = { calls: 0 };
  const walker = createWalker((chain: Uint8Array, n: number) => (work.calls++, c.advance(chain, n)));
  await walker.walkTo({ ctr: 0, chain: root }, 3000);
  assert.equal(work.calls, 3, '1024, 1024 and the 952 left');
  assert.equal(await walker.walkTo({ ctr: 0, chain: root }, CATCH_UP_SKIP + 1), null);
});

test('a tail below the furthest one does not replace it, and a target between the aligned point and the tail resumes from the aligned point', async () => {
  const r = rig({ stride: 8, cap: 100 });
  await r.walker.walkTo(base(), 10 + 21); // aligned +16, tail +21
  const w = r.work.steps;
  await r.walker.walkTo(base(), 10 + 18); // below the tail: from +16, 2 steps; the tail stays at +21
  assert.equal(r.work.steps - w, 2);
  await r.walker.walkTo(base(), 10 + 23);
  assert.equal(r.work.steps - w, 2 + 2, 'resumed from the tail at +21, not from +16');
  await r.walker.walkTo(base(), 10 + 23);
  assert.equal(r.work.steps - w, 2 + 2, 'and the further tail is kept');
});

test('B2: an adaptive attacker walking forged targets inside one stride costs at most the cap plus one stride in all', async () => {
  const stride = 8;
  const cap = 80;
  const r = rig({ stride, cap });
  // only aligned points would be cached: 1000 frames at the same unaligned target would cost up to stride - 1 each, every time
  for (let i = 0; i < 1000; i++) await r.walker.walkTo(base(), 10 + 5 * stride + (stride - 1));
  assert.ok(r.work.steps <= cap + stride, `walked ${r.work.steps}`);
  // targets that only go further inside the same stride add nothing beyond that one stride
  const r2 = rig({ stride, cap });
  for (let t = 5 * stride; t < 6 * stride; t++) for (let i = 0; i < 50; i++) await r2.walker.walkTo(base(), 10 + t);
  assert.ok(r2.work.steps <= 6 * stride, `walked ${r2.work.steps}`);
});

test('B3: the yield chunk is apart from the checkpoint stride: a break every `chunk` steps, checkpoints every `stride`', async () => {
  const r = rig({ stride: 16, chunk: 4, cap: 200 });
  let breaks = 0;
  await r.walker.walkTo(base(), 10 + 50, { yieldFn: async () => void breaks++ });
  assert.equal(breaks, Math.ceil(50 / 4));
  assert.equal(r.work.calls, 13);
  const w = r.work.steps;
  assert.equal(toHex((await r.walker.walkTo(base(), 10 + 40))!), r.truth(base(), 40));
  assert.equal(r.work.steps - w, 8, 'resumed from the checkpoint at +32, so the checkpoints are the stride, not the chunk');
  // an unaligned chunk size never walks past a checkpoint without caching it
  const q = rig({ stride: 16, chunk: 6, cap: 200 });
  await q.walker.walkTo(base(), 10 + 40);
  const v = q.work.steps;
  await q.walker.walkTo(base(), 10 + 33);
  assert.equal(q.work.steps - v, 1, 'the point at +32 was cached');
});

test('B1: a different chain at the same counter resets the cache (and so does a chain of another length)', async () => {
  const r = rig({ stride: 8, cap: 100 });
  await r.walker.walkTo(base(), 50);
  const other = { ctr: 10, chain: c.advance(root, 1) };
  const w = r.work.steps;
  assert.equal(
    toHex((await r.walker.walkTo(other, 50))!),
    toHex(c.advance(other.chain, 40)),
    'the chain of the new base, not the cached one',
  );
  assert.equal(r.work.steps - w, 40, 'walked from the new base');
  const short = { ctr: 10, chain: other.chain.slice(0, 16) };
  const x = r.work.steps;
  await r.walker.walkTo(short, 50);
  assert.equal(r.work.steps - x, 40, 'a chain of another length is another chain');
  const same = { ctr: 10, chain: Uint8Array.from(short.chain) };
  const y = r.work.steps;
  await r.walker.walkTo(same, 50);
  assert.equal(r.work.steps - y, 0, 'equal bytes in another array keep the cache');
});

test('reset drops every cached point and the base: points() is empty and the next walk recomputes from the base', async () => {
  const r = rig({ stride: 8, cap: 100 });
  assert.deepEqual(r.walker.points(), [], 'nothing cached before the first walk');
  await r.walker.walkTo(base(), 53); // points at +8 ... +40 and a tail at +43
  assert.deepEqual(r.walker.points(), [10, 18, 26, 34, 42, 50, 53]);
  r.walker.reset();
  assert.deepEqual(r.walker.points(), []);
  const w = r.work.steps;
  assert.equal(toHex((await r.walker.walkTo(base(), 53))!), r.truth(base(), 43));
  assert.equal(r.work.steps - w, 43, 'recomputed from the base, not from a point that was dropped');
  r.walker.reset();
  r.walker.reset();
  assert.deepEqual(r.walker.points(), [], 'resetting twice is harmless');
});

test('points() lists an aligned walk without a tail, and a tail only when the target is off the stride', async () => {
  const r = rig({ stride: 8, cap: 100 });
  await r.walker.walkTo(base(), 26);
  assert.deepEqual(r.walker.points(), [10, 18, 26]);
});
