// Paging the Claude Code session list reads each transcript once: the pages of one read, and callers listing at the same
// time, are cut from one SDK listing rather than one listing each (which rescanned every transcript up to the page's end).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { createSessionList, SNAPSHOT_MS, RUNNING_MS, EVERY } = require('../electron/harness/claude/sessionList.cjs');

type Row = { sessionId: string; cwd?: string };

/** An SDK whose every listing is counted and answers when the test says (or at once). */
function fakeSdk(rows: () => Row[], { hold = false } = {}) {
  const calls: unknown[] = [];
  const waiting: { ok: () => void; fail: (e: Error) => void }[] = [];
  const sdk = {
    listSessions: (o: unknown) => {
      calls.push(o);
      const answer = rows().map((r) => ({ ...r }));
      if (!hold) return Promise.resolve(answer);
      return new Promise<Row[]>((resolve, reject) => waiting.push({ ok: () => resolve(answer), fail: reject }));
    },
  };
  return { calls, waiting, load: async () => sdk };
}

const ids = (rows: Row[]) => rows.map((r) => r.sessionId);
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}` }));

test('the pages of one read come from one listing, and agree with one another', async (t) => {
  const clock = useFakeClock(t, 1000);
  let rows = many(5);
  const sdk = fakeSdk(() => rows);
  const filled: string[][] = [];
  const page = createSessionList(sdk.load, async (list: Row[]) => {
    filled.push(ids(list));
  });
  assert.deepEqual(ids(await page(2, 0)), ['s0', 's1']);
  // a session written meanwhile does not shift the later pages of the read that already took its first
  rows = [{ sessionId: 'new' }, ...rows];
  clock.advance(SNAPSHOT_MS - 1);
  assert.deepEqual(ids(await page(2, 2)), ['s2', 's3']);
  assert.deepEqual(ids(await page(2, 4)), ['s4']);
  assert.deepEqual(sdk.calls, [{ limit: EVERY, offset: 0 }], 'one listing for every page');
  assert.deepEqual(filled, [['s0', 's1'], ['s2', 's3'], ['s4']], 'each page has its cwd filled in');
  // a first page lists afresh
  assert.deepEqual(ids(await page(2, 0)), ['new', 's0']);
  assert.equal(sdk.calls.length, 2);
  // a limit of 0 takes the rest
  assert.deepEqual(ids(await page(0, 4)), ['s3', 's4']);
  assert.equal(sdk.calls.length, 2);
});

test('a later page asked for long after any listing lists afresh, and the listing is let go once stale', async (t) => {
  const clock = useFakeClock(t, 1000);
  const sdk = fakeSdk(() => many(3));
  const page = createSessionList(sdk.load, async () => {});
  await page(1, 0);
  assert.equal(clock.pending, 1, 'the listing is let go after a while');
  clock.advance(SNAPSHOT_MS);
  assert.equal(clock.pending, 0);
  assert.deepEqual(ids(await page(1, 1)), ['s1']);
  assert.equal(sdk.calls.length, 2);
  // a first page lists afresh: when the older listing's time is up, the newer one stays
  clock.advance(SNAPSHOT_MS - 1);
  await page(1, 0);
  clock.advance(1);
  assert.deepEqual(ids(await page(1, 2)), ['s2']);
  assert.equal(sdk.calls.length, 3, 'the later page is cut from the newer listing');
});

test('a listing that does not answer is let go, so the reads after it list again; its late answer replaces nothing', async (t) => {
  const clock = useFakeClock(t, 1000);
  let rows = many(3);
  const sdk = fakeSdk(() => rows, { hold: true });
  const page = createSessionList(sdk.load, async () => {});
  const hung = page(1, 0);
  await new Promise((r) => setImmediate(r));
  clock.advance(RUNNING_MS);
  rows = [{ sessionId: 'new' }, ...rows];
  const fresh = page(1, 0);
  const later = page(1, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(sdk.calls.length, 2);
  sdk.waiting[1].ok();
  assert.deepEqual(ids(await fresh), ['new']);
  // the hung listing answers late: its reads get it, and the later pages still come from the newer listing
  sdk.waiting[0].ok();
  assert.deepEqual(ids(await hung), ['s0']);
  assert.deepEqual(ids(await later), ['s0']);
  clock.advance(SNAPSHOT_MS - 1);
  assert.deepEqual(ids(await page(1, 2)), ['s1']);
  assert.equal(sdk.calls.length, 2);
  // one that fails late leaves the newer listing alone too
  clock.advance(1);
  const failing = page(1, 0);
  await new Promise((r) => setImmediate(r));
  clock.advance(RUNNING_MS);
  const next = page(1, 0);
  await new Promise((r) => setImmediate(r));
  sdk.waiting[3].ok();
  await next;
  sdk.waiting[2].fail(new Error('late'));
  await assert.rejects(failing, /late/);
  assert.deepEqual(ids(await page(1, 1)), ['s0']);
  assert.equal(sdk.calls.length, 4);
});

test('callers listing at the same time share the listing in flight', async (t) => {
  useFakeClock(t, 1000);
  const sdk = fakeSdk(() => many(4), { hold: true });
  const page = createSessionList(sdk.load, async () => {});
  const sidebar = page(2, 0);
  const sweep = page(500, 0);
  const later = page(2, 2);
  await new Promise((r) => setImmediate(r));
  assert.equal(sdk.calls.length, 1);
  sdk.waiting[0].ok();
  assert.deepEqual(ids(await sidebar), ['s0', 's1']);
  assert.deepEqual(ids(await sweep), ['s0', 's1', 's2', 's3']);
  assert.deepEqual(ids(await later), ['s2', 's3']);
});

test('a failed listing fails its pages and serves none after it', async (t) => {
  useFakeClock(t, 1000);
  const sdk = fakeSdk(() => many(3), { hold: true });
  const page = createSessionList(sdk.load, async () => {});
  const first = page(1, 0);
  await new Promise((r) => setImmediate(r));
  sdk.waiting[0].fail(new Error('signed out'));
  await assert.rejects(first, /signed out/);
  const next = page(1, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(sdk.calls.length, 2, 'the next page lists again');
  sdk.waiting[1].ok();
  assert.deepEqual(ids(await next), ['s1']);
});
