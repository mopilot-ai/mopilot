// The remote history assembler never publishes a partial snapshot or advances through stale or malformed pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { historyPage } from '../host/src/historyPage.mjs';
import { HISTORY_CHARS } from '../shared/host/history.mjs';
const { fillHistory } = createRequire(import.meta.url)('../electron/host/remoteHistory.cjs');
const hello = () => ({ generation: 'g', rev: 1, snapshot: { items: [], paged: true, droppedItems: 1 } });
const good = { generation: 'g', rev: 1, chunk: '{"text":"full"}\n', next: null };
test('old small snapshots need no requests; valid multiple pages replace the clipped copy atomically', async () => {
  await fillHistory(null, () => assert.fail('no hello'));
  await fillHistory({ snapshot: { items: [] } }, () => assert.fail('old snapshot'));
  const h = hello(),
    item = { text: '🦊'.repeat(HISTORY_CHARS) };
  await fillHistory(h, async (_: string, p: any) => historyPage({ generation: 'g', frames: [{ item }] }, p));
  assert.deepEqual(h.snapshot.items, [item]);
  assert.equal(h.snapshot.paged, false);
  assert.equal('droppedItems' in h.snapshot, false);
});
test('malformed pages and cursor loops retain the original snapshot for a retry', async () => {
  for (const patch of [
    null,
    { generation: 'x' },
    { rev: 2 },
    { chunk: 3 },
    { chunk: 'x'.repeat(HISTORY_CHARS + 1) },
    { chunk: 'not-json\n' },
    { chunk: 'null\n' },
    { chunk: '[]\n' },
    { chunk: '3\n' },
    { chunk: '{}' },
    { chunk: '' },
    { next: undefined },
    { next: {} },
    { next: { index: 0, offset: 0 } },
    { next: { index: -1, offset: 1 } },
    { next: { index: 2, offset: 0 } },
    { next: { index: 0, offset: -1 } },
    { next: { index: 1.5, offset: 0 } },
    { chunk: '', next: { index: 0, offset: 1 } },
  ]) {
    const h = hello(),
      original = h.snapshot;
    await assert.rejects(
      fillHistory(h, async () => (patch === null ? null : { ...good, ...patch })),
      /incomplete chat history/,
    );
    assert.equal(h.snapshot, original);
  }
  const h = hello();
  await assert.rejects(
    fillHistory(h, async () => {
      throw new Error('connection lost');
    }),
    /connection lost/,
  );
  assert.equal(h.snapshot.paged, true);
});

test('the actual remote proxy holds live frames until every pinned page is received', async (t) => {
  const { hostWorld, onlineRemote } = await import('./support/host-wire-kit.ts');
  const { helloParams } = await import('../shared/host/schema.mjs');
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = () => helloParams();
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 1, items: [], paged: true }, generation: 'g' });
  const { host } = await onlineRemote(w);
  const seen: any[] = [];
  host.events.onFrame((e: any) => seen.push(e));
  w.net.handlers['chat.history'] = (_p: any, socket: any) => {
    socket.feed({ event: 'frame', chatId: 'a', frame: { t: 'delta', seq: 2, key: 'live', delta: { text: 'later' } } });
    assert.deepEqual(seen, [], 'the transcript must get its baseline before later live deltas');
    return good;
  };
  const result = await host.subscribe('a');
  assert.deepEqual(result.snapshot.items, [{ text: 'full' }]);
  assert.equal(seen[0].frame.delta.text, 'later');
  assert.equal(w.net.last.written.filter((p: any) => p.method === 'chat.history').length, 1);
});

test('a remote history read fails on connection retirement without publishing its partial snapshot', async (t) => {
  const { hostWorld, onlineRemote } = await import('./support/host-wire-kit.ts');
  const { helloParams } = await import('../shared/host/schema.mjs');
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = () => helloParams();
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 1, items: [], paged: true }, generation: 'g' });
  const { host } = await onlineRemote(w);
  w.net.handlers['chat.history'] = () => {
    queueMicrotask(() => host.dispose());
    return good;
  };
  await assert.rejects(host.subscribe('a'), (e: any) => e.code === 'host_unreachable');
});

test('same-chat subscribe and all pages are serialized as one baseline transaction', async () => {
  const { createCollecting, readSubscription } = createRequire(import.meta.url)('../electron/host/remoteSubscribe.cjs');
  const collecting = createCollecting();
  let release!: (v: any) => void;
  const page = new Promise((r) => (release = r));
  const opts = {
    chatId: 'c',
    epoch: 1,
    needs() {},
    collecting,
    generations: new Map(),
    history: true,
    current() {},
    send: async (method: string) => {
      if (method === 'chat.subscribe') {
        collecting.take('c', { t: 'hello', generation: 'g', rev: 1, snapshot: { items: [], paged: true } });
        return {};
      }
      return page;
    },
  };
  const a = readSubscription(opts);
  await Promise.resolve();
  const b = readSubscription(opts);
  await Promise.resolve();
  release({ generation: 'g', rev: 1, chunk: '{"full":true}\n', next: null });
  const results = await Promise.all([a, b]);
  for (const result of results) assert.deepEqual(result.snapshot.items, [{ full: true }]);
});

test('overflowing held live frame bytes or count aborts before exposing a baseline and permits retry', async () => {
  const { createCollecting, readSubscription } = createRequire(import.meta.url)('../electron/host/remoteSubscribe.cjs');
  for (const limits of [{ maxFrames: 1 }, { maxBytes: 1 }]) {
    const collecting = createCollecting(limits);
    const options = {
      chatId: 'c',
      epoch: 1,
      needs() {},
      collecting,
      generations: new Map(),
      history: true,
      current() {},
      send: async () => {
        collecting.take('c', { t: 'hello', generation: 'g', rev: 1, snapshot: { items: [], paged: true } });
        collecting.take('c', { t: 'delta', delta: { text: 'held' } });
        collecting.take('c', { t: 'delta', delta: { text: 'ignored after overflow' } });
        return {};
      },
    };
    await assert.rejects(readSubscription(options), /Too much live history/);
    assert.equal(collecting.has('c'), false);
    assert.equal(collecting.take('c', { t: 'delta' }), false);
  }
});

test('history assembly refuses its configured content budget and never allocates a partial published snapshot', async () => {
  const h = hello();
  await assert.rejects(
    fillHistory(h, async () => good, { maxChars: 1 }),
    /incomplete chat history/,
  );
  assert.equal(h.snapshot.paged, true);
  await fillHistory(null, () => assert.fail('no request'), {});
});

test('a proxy with no live connection refuses a subscribe before writing any history request', async (t) => {
  const { hostWorld } = await import('./support/host-wire-kit.ts');
  const w = hostWorld(t),
    host = w.remote(w.tunnel());
  await assert.rejects(host.subscribe('a'), (e: any) => e.code === 'host_unreachable');
});

test('a resumed subscribe with three large durables catches up instead of repeatedly hitting the live-frame budget', async (t) => {
  const { hostWorld, onlineRemote } = await import('./support/host-wire-kit.ts');
  const { helloParams } = await import('../shared/host/schema.mjs');
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = () => helloParams();
  const items = Array.from({ length: 3 }, (_, i) => ({ text: `${i}:` + 'x'.repeat(6 * 1024 * 1024) }));
  const calls: any[] = [];
  w.net.handlers.subscribe = (params: any) => {
    calls.push(params);
    return params.fromRev === 0
      ? { snapshot: { rev: 3 }, generation: 'g', patches: items.map((item, i) => ({ rev: i + 1, patch: { item } })) }
      : { snapshot: { rev: 3, items: [], paged: true }, generation: 'g' };
  };
  w.net.handlers['chat.history'] = (params: any) => historyPage({ generation: 'g', frames: items.map((item) => ({ item })) }, params);
  const { host } = await onlineRemote(w);
  const result = await host.subscribe('a', 0, 'g');
  const received = result.patches ? result.patches.map((p: any) => p.patch.item) : result.snapshot.items;
  assert.deepEqual(received, items);
  assert.ok(calls.length <= 2, 'one read-only fallback must replace the oversized replay, not loop the same resume cursor');
});

test('a malformed Host replaying beyond budget even without a resume cursor fails once instead of looping', async () => {
  const { createCollecting, readSubscription } = createRequire(import.meta.url)('../electron/host/remoteSubscribe.cjs');
  const collecting = createCollecting({ maxReplayBytes: 1 });
  let requests = 0;
  await assert.rejects(
    readSubscription({
      chatId: 'c',
      fromRev: 0,
      generation: 'g',
      epoch: 1,
      needs() {},
      collecting,
      generations: new Map(),
      history: false,
      current() {},
      send: async () => {
        requests++;
        collecting.take('c', { t: 'hello', generation: 'g', rev: 2, snapshot: null });
        for (const rev of [1, 2]) collecting.take('c', { t: 'durable', rev, item: { text: 'kept in journal' } });
        return {};
      },
    }),
    /could not restore this chat/,
  );
  assert.equal(requests, 2);
});

test('only post-Hello live output consumes the live collector budget; newer durables still count', () => {
  const { createCollecting } = createRequire(import.meta.url)('../electron/host/remoteSubscribe.cjs');
  const c = createCollecting({ maxFrames: 1, maxBytes: 1 });
  const got = c.open('c');
  c.take('c', { t: 'delta', delta: { text: 'belongs in the upcoming Hello' } });
  assert.equal(got.overflow, false);
  c.take('c', { t: 'hello', rev: 1, snapshot: { rev: 1, items: [] } });
  c.take('c', { t: 'durable', rev: 2, item: { text: 'live' } });
  assert.equal(got.overflow, true);
});

test('a failed subscribe transaction rejects its caller while the next queued read runs and keeps its own result', async () => {
  const { createCollecting } = createRequire(import.meta.url)('../electron/host/remoteSubscribe.cjs');
  const collecting = createCollecting(),
    error = new Error('first read failed'),
    order: string[] = [];
  const failed = collecting.serialize('c', async () => {
    order.push('first');
    throw error;
  });
  const next = collecting.serialize('c', async () => {
    order.push('second');
    return { full: true };
  });
  await assert.rejects(failed, (e: any) => e === error);
  assert.deepEqual(await next, { full: true });
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(await collecting.serialize('c', async () => 'third'), 'third');
});
