// Frame activity and capture budget survive overlap, hidden watches, failure and transport retirement without changing tool outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';
const { createDesktopFramePacing, ACTIVE_FRAME_MS, GAP_FACTOR, GAP_MAX_MS, FRAME_PARAMS } = createRequire(import.meta.url)(
  '../electron/capabilities/hostDesktopFrames.cjs',
);
function rig() {
  let now = 0;
  const waits: { at: number; resolve: () => void }[] = [];
  const calls: { host: string; chat: string; at: number; result: ReturnType<typeof deferred<any>> }[] = [];
  const hosts: Record<string, string> = { c1: 'h1', c2: 'h1', c3: 'h2' };
  const generations: Record<string, number> = { h1: 1, h2: 1 };
  const remotes: Record<string, any> = {};
  for (const host of ['h1', 'h2'])
    remotes[host] = {
      generation: () => generations[host],
      command: async (chat: string, _method?: string, params?: any) => {
        const result = deferred<any>();
        calls.push({ host, chat, at: now, result, params } as any);
        return result.promise;
      },
    };
  const pacing = createDesktopFramePacing({
    remoteOf: (h: string) => remotes[h],
    hostOf: (c: string) => hosts[c] ?? null,
    now: () => now,
    sleep: (ms: number) => new Promise<void>((resolve) => waits.push({ at: now + ms, resolve })),
  });
  return {
    pacing,
    calls,
    waits,
    hosts,
    generations,
    remotes,
    advance(ms: number) {
      now += ms;
      for (const w of waits.splice(0))
        if (w.at <= now) w.resolve();
        else waits.push(w);
    },
  };
}

test('all chats/panes share one Host capture and rate cap; another Host can capture independently', async () => {
  const r = rig();
  const a = r.pacing.fetch('h1', 'c1', () => true);
  const b = r.pacing.fetch('h1', 'c2', () => true);
  const c = r.pacing.fetch('h2', 'c3', () => true);
  await waitFor(() => r.calls.length === 2);
  assert.deepEqual(
    r.calls.map((x) => x.host),
    ['h1', 'h2'],
  );
  r.calls[0].result.resolve('one');
  assert.equal(await a, 'one');
  await waitFor(() => r.waits.length === 1);
  r.advance(ACTIVE_FRAME_MS - 1);
  assert.equal(r.calls.length, 2);
  r.advance(1);
  await waitFor(() => r.calls.length === 3);
  assert.equal(r.calls[2].at, ACTIVE_FRAME_MS);
  r.calls[2].result.resolve('two');
  r.calls[1].result.resolve('other');
  assert.deepEqual(await Promise.all([b, c]), ['two', 'other']);
});

test('early timer wakes recheck the deadline and queued hidden/moved watches never reach the Host', async () => {
  const r = rig();
  const a = r.pacing.fetch('h1', 'c1', () => true);
  await waitFor(() => r.calls.length === 1);
  r.calls[0].result.resolve('one');
  await a;
  let visible = true;
  const b = r.pacing.fetch('h1', 'c1', () => visible);
  const refused = assert.rejects(b, (e: any) => e.code === 'stale_frame' && /no longer current/.test(e.message));
  await waitFor(() => r.waits.length === 1);
  r.waits.shift()!.resolve();
  await waitFor(() => r.waits.length === 1);
  assert.equal(r.calls.length, 1);
  visible = false;
  r.advance(ACTIVE_FRAME_MS);
  await refused;
  r.hosts.c1 = 'h2';
  await assert.rejects(
    r.pacing.fetch('h1', 'c1', () => true),
    /current/,
  );
  assert.equal(r.calls.length, 1);
});

for (const replacement of ['generation', 'object', 'dispose'])
  test(`${replacement} retires queued and late capture without blocking a new connection`, async () => {
    const r = rig();
    const a = r.pacing.fetch('h1', 'c1', () => true);
    const badA = assert.rejects(a, /current/);
    await waitFor(() => r.calls.length === 1);
    const b = r.pacing.fetch('h1', 'c2', () => true);
    const badB = assert.rejects(b, /current/);
    if (replacement === 'generation') r.generations.h1++;
    if (replacement === 'object') r.remotes.h1 = { ...r.remotes.h1 };
    if (replacement === 'dispose') r.pacing.dispose();
    if (replacement !== 'dispose') {
      const fresh = r.pacing.fetch('h1', 'c1', () => true);
      await waitFor(() => r.calls.length === 2);
      r.calls[1].result.resolve('fresh');
      assert.equal(await fresh, 'fresh');
    }
    r.calls[0].result.resolve('late');
    await Promise.all([badA, badB]);
  });

test('a hung capture stays the only underlying request; a rejection releases its budget for retry', async () => {
  const r = rig();
  const a = r.pacing.fetch('h1', 'c1', () => true);
  const failed = assert.rejects(a, /offline/);
  await waitFor(() => r.calls.length === 1);
  const b = r.pacing.fetch('h1', 'c2', () => true);
  r.advance(100_000);
  assert.equal(r.calls.length, 1);
  r.calls[0].result.reject(new Error('offline'));
  await failed;
  await waitFor(() => r.waits.length === 1);
  r.advance(GAP_FACTOR * 100_000); // a capture that cost 100 s backs the next one off in proportion
  await waitFor(() => r.calls.length === 2);
  r.calls[1].result.resolve('retry');
  assert.equal(await b, 'retry');
});

test('missing connection fails before I/O; default clock and delay work for a live connection', async () => {
  const r = rig();
  delete r.remotes.h1;
  await assert.rejects(
    r.pacing.fetch('h1', 'c1', () => true),
    /current/,
  );
  const pacing = createDesktopFramePacing({ remoteOf: () => ({}), hostOf: () => null });
  await assert.rejects(
    pacing.fetch('h', 'c', () => true),
    /current/,
  );
  const remote = { command: async () => 42 };
  const live = createDesktopFramePacing({ remoteOf: () => remote, hostOf: () => 'h' });
  assert.equal(await live.fetch('h', 'c', () => true), 42);
  assert.equal(await live.fetch('h', 'c', () => true), 42);
});

test('activity combines overlapping actions, excludes reads, and refreshes after success and failure', async () => {
  const r = rig();
  const updates: any[] = [];
  const off = r.pacing.subscribe('h1', 'c1', (active: boolean, refresh: boolean) => updates.push([active, refresh]));
  for (const method of ['screenshot', 'app.screenshot', 'target.info', 'input.release', 'unknown'])
    assert.equal(await r.pacing.around('h1', 'c1', method, async () => 7), 7);
  assert.deepEqual(updates, [[false, false]]);
  const first = deferred<number>();
  const second = deferred<number>();
  const a = r.pacing.around('h1', 'c1', 'input.click', () => first.promise);
  const b = r.pacing.around('h1', 'c1', 'app.setText', () => second.promise);
  const bad = assert.rejects(b, /refused/);
  first.resolve(1);
  assert.equal(await a, 1);
  assert.deepEqual(updates.at(-1), [true, true]);
  second.reject(new Error('refused'));
  await bad;
  assert.deepEqual(updates.at(-1), [false, true]);
  off();
  assert.equal(await r.pacing.around('h2', 'c1', 'input.click', async () => 3), 3);
  r.pacing.dispose();
  assert.equal(await r.pacing.around('h1', 'c1', 'input.click', async () => 4), 4);
});

test('Stop/Host loss retire old action tokens; late completion never turns off a new action', async () => {
  const r = rig();
  const updates: any[] = [];
  const off = r.pacing.subscribe('h1', 'c1', (on: boolean, refresh: boolean) => updates.push([on, refresh]));
  const old = deferred();
  const a = r.pacing.around('h1', 'c1', 'input.click', () => old.promise);
  r.pacing.retireChat('c1');
  const fresh = deferred();
  const b = r.pacing.around('h1', 'c1', 'input.type', () => fresh.promise);
  const before = updates.length;
  old.resolve();
  await a;
  assert.equal(updates.length, before);
  const third: any[] = [];
  const off3 = r.pacing.subscribe('h2', 'c3', (on: boolean) => third.push(on));
  r.pacing.retireHost('h1');
  assert.deepEqual(updates.at(-1), [false, false]);
  assert.deepEqual(third, [false]);
  fresh.resolve();
  await b;
  off();
  off3();
});

test('late subscribers see an already running action, and a failing pane cannot change its result', async () => {
  const r = rig();
  const work = deferred<number>();
  const run = r.pacing.around('h1', 'c1', 'input.click', () => work.promise);
  const active: boolean[] = [];
  const off = r.pacing.subscribe('h1', 'c1', (on: boolean) => active.push(on));
  const broken = r.pacing.subscribe('h1', 'c1', () => {
    throw new Error('closed pane');
  });
  assert.equal(active[0], true);
  broken();
  work.resolve(9);
  assert.equal(await run, 9);
  assert.equal(active.at(-1), false);
  off();
  r.pacing.dispose();
});

test('a stack rebuild on a live connection (retireHost) keeps the slot: the new capture waits for the one outstanding, never beside it', async () => {
  const r = rig();
  const a = r.pacing.fetch('h1', 'c1', () => true);
  await waitFor(() => r.calls.length === 1);
  r.pacing.retireHost('h1');
  const fresh = r.pacing.fetch('h1', 'c1', () => true);
  await new Promise((res) => setImmediate(res));
  assert.equal(r.calls.length, 1, 'still one outstanding');
  r.calls[0].result.resolve('first');
  assert.equal(await a, 'first');
  await waitFor(() => r.waits.length === 1);
  r.advance(ACTIVE_FRAME_MS);
  await waitFor(() => r.calls.length === 2);
  r.calls[1].result.resolve('second');
  assert.equal(await fresh, 'second');
});

test('a pane frame asks for a small JPEG; the next capture waits at least three times what the last one cost, and no less than the budget', async () => {
  const r = rig();
  const slow = r.pacing.fetch('h1', 'c1', () => true);
  const next = r.pacing.fetch('h1', 'c1', () => true);
  await waitFor(() => r.calls.length === 1);
  assert.deepEqual((r.calls[0] as any).params, FRAME_PARAMS);
  assert.equal(FRAME_PARAMS.format, 'jpeg');
  r.advance(600); // the capture took 600 ms
  r.calls[0].result.resolve('slow');
  await slow;
  await waitFor(() => r.waits.length === 1);
  r.advance(GAP_FACTOR * 600 - 1);
  await new Promise((res) => setImmediate(res));
  assert.equal(r.calls.length, 1, 'backed off for 1800 ms, not 250');
  r.advance(1);
  await waitFor(() => r.calls.length === 2);
  r.calls[1].result.resolve('fast'); // took 0 ms
  await next;
  const third = r.pacing.fetch('h1', 'c1', () => true);
  await waitFor(() => r.waits.length === 1);
  r.advance(ACTIVE_FRAME_MS - 1);
  await new Promise((res) => setImmediate(res));
  assert.equal(r.calls.length, 2, 'a quick capture still waits the budget');
  r.advance(1);
  await waitFor(() => r.calls.length === 3);
  r.calls[2].result.resolve('ok');
  await third;
});

test('the back-off is capped: one very slow capture does not silence the pane for longer than the watch cadence', async () => {
  const r = rig();
  const slow = r.pacing.fetch('h1', 'c1', () => true);
  const next = r.pacing.fetch('h1', 'c1', () => true);
  await waitFor(() => r.calls.length === 1);
  r.advance(2600); // a cold first capture
  r.calls[0].result.resolve('cold');
  await slow;
  await waitFor(() => r.waits.length === 1);
  r.advance(GAP_MAX_MS - 1);
  await new Promise((res) => setImmediate(res));
  assert.equal(r.calls.length, 1);
  r.advance(1);
  await waitFor(() => r.calls.length === 2);
  r.calls[1].result.resolve('warm');
  await next;
});
