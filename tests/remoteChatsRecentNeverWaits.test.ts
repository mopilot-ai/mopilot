// A phone's chat list never waits on a slow Git, a stuck harness or a hung disk: Git's numbers come later, each harness's list is the last good one at once, and the first read of a list has a deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { createPhoneSources, readAll } = require('../electron/app/phoneListSources.cjs');
const phone = { kind: 'phone', pairId: 'p1', follows: new Set() };
const never = () => new Promise<never>(() => undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ask = (r: any) => r.service.call(phone, 'chats.recent', { limit: 50, offset: 0 });

test('a list whose Git numbers never come still answers at once, without the numbers', async () => {
  const r = rig({ ops: { review: { statsFor: never } } });
  const t0 = Date.now();
  const answer = await ask(r);
  assert.ok(Date.now() - t0 < 400, `answered in ${Date.now() - t0} ms`);
  assert.equal(answer.chats.length, 1);
  assert.ok(!('changes' in answer.chats[0]), 'no numbers for this list');
});

test('a reader that throws, answers late or is missing leaves the list as it was; the numbers it has are sent', async () => {
  const thrown = rig({
    ops: {
      review: {
        statsFor: () => {
          throw new Error('git is gone');
        },
      },
    },
  });
  assert.equal((await ask(thrown)).chats.length, 1);
  const rejected = rig({ ops: { review: { statsFor: () => Promise.reject(new Error('no repo')) } } });
  assert.equal((await ask(rejected)).chats.length, 1);
  const none = rig({ ops: { review: undefined } });
  assert.equal((await ask(none)).chats.length, 1);
  const quick = rig({ ops: { review: { statsFor: async () => new Map([['c1', { added: 3, removed: 1 }]]) } } });
  assert.deepEqual((await ask(quick)).chats[0].changes, { added: 3, removed: 1 });
  const nothing = rig({ ops: { review: { statsFor: async () => undefined } } });
  assert.equal((await ask(nothing)).chats.length, 1, 'a reader with no answer is no numbers');
});

test('a harness list that never answers is let go after the first deadline, and the next list has what it found', async () => {
  let calls = 0;
  let late: (v: any[]) => void = () => undefined;
  const sources = createPhoneSources(
    {
      codex: () => (++calls, new Promise<any[]>((r) => (late = r))),
      claude: async () => [{ key: 'claude:1' }],
    },
    { coldMs: 30, warmMs: 20 },
  );
  const t0 = Date.now();
  const [codex, claude] = await Promise.all([sources.codex(false).catch((e: Error) => e), sources.claude(false)]);
  assert.ok(Date.now() - t0 < 500);
  assert.match((codex as Error).message, /codex list timed out/);
  assert.deepEqual(claude, [{ key: 'claude:1' }], 'the other harness answered');
  late([{ key: 'codex:1' }]);
  await sleep(5);
  assert.deepEqual(await sources.codex(false), [{ key: 'codex:1' }], 'the read that was let go still landed');
  assert.equal(calls, 1, 'one read, not one per list');
});

test('an out-of-date list is served at once while it refreshes, and a quick refresh is used', async () => {
  let t = 0;
  let n = 0;
  let release: (v: any[]) => void = () => undefined;
  let hold = false;
  const sources = createPhoneSources(
    { claude: () => (hold ? new Promise<any[]>((r) => (release = r)) : Promise.resolve([{ key: `v${++n}` }])) },
    { now: () => t, freshMs: 100, warmMs: 20, coldMs: 30 },
  );
  assert.deepEqual(await sources.claude(false), [{ key: 'v1' }]);
  t = 50;
  assert.deepEqual(await sources.claude(false), [{ key: 'v1' }], 'fresh: no read');
  t = 500;
  assert.deepEqual(await sources.claude(false), [{ key: 'v2' }], 'out of date and the refresh is quick: the new list');
  hold = true;
  t = 1000;
  assert.deepEqual(await sources.claude(false), [{ key: 'v2' }], 'out of date and the refresh is slow: the kept list, now');
  release([{ key: 'v3' }]);
  await sleep(5);
  t = 1050;
  assert.deepEqual(await sources.claude(false), [{ key: 'v3' }], 'the refresh that finished behind it is kept');
});

test('a failing harness says why on the first read, keeps its last good list afterwards, and a read that hung is tried again', async () => {
  let t = 0;
  let mode: 'fail' | 'ok' | 'hang' | 'fail-text' = 'fail';
  let calls = 0;
  const sources = createPhoneSources(
    {
      acp: () => {
        calls++;
        if (mode === 'ok') return Promise.resolve([{ key: 'a' }]);
        if (mode === 'hang') return never();
        return Promise.reject(mode === 'fail-text' ? 'plain text' : new Error('agent down'));
      },
    },
    { now: () => t, freshMs: 10, hungMs: 100, warmMs: 10, coldMs: 30 },
  );
  await assert.rejects(sources.acp(false), /agent down/);
  mode = 'fail-text';
  t = 20;
  await assert.rejects(sources.acp(false), /plain text/, 'a non-error is told as text');
  mode = 'ok';
  t = 40;
  assert.deepEqual(await sources.acp(false), [{ key: 'a' }]);
  mode = 'hang';
  t = 60;
  assert.deepEqual(await sources.acp(false), [{ key: 'a' }], 'the hung refresh does not hold the list');
  const before = calls;
  t = 80;
  await sources.acp(false);
  assert.equal(calls, before, 'a read still running is joined, not started again');
  mode = 'ok';
  t = 300;
  await sources.acp(false);
  assert.equal(calls, before + 1, 'a read that hung too long is let go and asked again');
  assert.deepEqual(await sources.acp(true), [{ key: 'a' }], 'the archive is its own list');
});

test('every harness is read together; a failing one is an Error in its place and the others keep their chats', async () => {
  const sources = createPhoneSources(
    { claude: async () => [{ key: 'claude:1' }], codex: () => Promise.reject(new Error('app server down')) },
    { coldMs: 20, warmMs: 10 },
  );
  const all = await readAll(sources, false);
  assert.deepEqual(all.claude, [{ key: 'claude:1' }]);
  assert.match(all.codex.message, /app server down/);
});

test('a read that was let go and lands late is not kept over a newer one; a warm start reads each harness once at once', async () => {
  let t = 0;
  const releases: ((v: any[]) => void)[] = [];
  const sources = createPhoneSources(
    { claude: () => new Promise<any[]>((r) => releases.push(r)) },
    { now: () => t, hungMs: 100, coldMs: 10, warmMs: 10, freshMs: 10 },
  );
  await assert.rejects(sources.claude(false), /timed out/);
  t = 500;
  await assert.rejects(sources.claude(false), /timed out/);
  assert.equal(releases.length, 2, 'the hung read was let go and asked again');
  releases[1]([{ key: 'new' }]);
  await sleep(5);
  releases[0]([{ key: 'old' }]);
  await sleep(5);
  t = 505;
  assert.deepEqual(await sources.claude(false), [{ key: 'new' }]);

  // a let-go read that fails late does not replace what the newer one kept
  const fails: ((e: Error) => void)[] = [];
  const answers: ((v: any[]) => void)[] = [];
  let u = 0;
  const later = createPhoneSources(
    { claude: () => new Promise<any[]>((ok, no) => (answers.push(ok), fails.push(no))) },
    { now: () => u, hungMs: 100, coldMs: 10, warmMs: 10, freshMs: 10 },
  );
  await assert.rejects(later.claude(false), /timed out/);
  u = 500;
  await assert.rejects(later.claude(false), /timed out/);
  answers[1]([{ key: 'kept' }]);
  await sleep(5);
  fails[0](new Error('too late'));
  await sleep(5);
  u = 505;
  assert.deepEqual(await later.claude(false), [{ key: 'kept' }]);

  let read = 0;
  createPhoneSources({ codex: async () => (read++, []), acp: () => Promise.reject(new Error('down')) }, { warm: true });
  await sleep(10);
  assert.equal(read, 1, 'warmed once; a failing harness on warm-up is only tried again with the next list');
});
