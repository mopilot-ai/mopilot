// One deadline for the Switch host plan (Remote Run #5197): a stopped destination is reported as unreachable in 20 s, not after each of the plan's steps has waited its own 15 s, the chat's hold is released, and the dialog offers the retry in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { planHandler, PLAN_MS } = require('../electron/host/moveSettle.cjs');

const service = (held: string[]) => ({
  moving: () => false,
  holdMove: (c: string) => held.push(`hold ${c}`),
  endMove: async (c: string) => void held.push(`end ${c}`),
});
const req = { chatId: 'c1', targetHostId: 'box', cwd: '/srv' };

test('a plan that never answers is refused as unreachable at the deadline, and the chat is let go', async (t) => {
  const clock = installFakeClock(t, 1_000);
  const held: string[] = [];
  const handler = planHandler({ remote: () => service(held), nameOf: () => 'box', plan: () => new Promise(() => undefined) });
  let outcome: unknown = 'pending';
  const asked = handler.call({}, req).then(
    (v: unknown) => (outcome = v),
    (e: unknown) => (outcome = e),
  );
  clock.advance(PLAN_MS - 1);
  await Promise.resolve();
  assert.equal(outcome, 'pending', 'inside the deadline it still waits');
  clock.advance(1);
  await asked;
  assert.equal((outcome as { code?: string }).code, 'host_unreachable');
  assert.match((outcome as unknown as Error).message, /did not answer/);
  assert.deepEqual(held, ['hold c1', 'end c1'], 'the hold is released with the refusal');
});

test('a plan that answers in time is returned, and one that fails on its own says what it said', async (t) => {
  const clock = installFakeClock(t, 1_000);
  const held: string[] = [];
  const ok = planHandler({ remote: () => service(held), nameOf: () => 'box', plan: async () => ({ state: 'ready', plan: null }) });
  assert.deepEqual(await ok.call({}, req), { state: 'ready', plan: null });
  const bad = planHandler({
    remote: () => service(held),
    nameOf: () => 'box',
    plan: async () => {
      throw Object.assign(new Error('Folder missing'), { code: 'directory_missing' });
    },
  });
  await assert.rejects(bad.call({}, req), { code: 'directory_missing' });
  clock.advance(PLAN_MS * 2);
  await Promise.resolve();
});

test('a plan that fails after its deadline is not an unhandled rejection', async (t) => {
  const clock = installFakeClock(t, 1_000);
  let fail: (e: Error) => void = () => undefined;
  const handler = planHandler({ remote: () => service([]), nameOf: () => 'box', plan: () => new Promise((_, reject) => (fail = reject)) });
  const asked = handler.call({}, req);
  clock.advance(PLAN_MS);
  await assert.rejects(asked, { code: 'host_unreachable' });
  fail(new Error('late'));
  await Promise.resolve();
});
