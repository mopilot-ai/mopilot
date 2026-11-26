// An open chat fills the rows above its snapshot in the background (#5379): silently (no busy row, no error), in order, in memory, up to a cap of rows and bytes, and politely (not while a turn streams, the app is away, a finger is down, or just after a failure).
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { useEffect } from 'react';
import { act, createElement, createRoot } from './support/phone/component-kit';
import { waitFor } from './support/waitFor';
// the path is a variable, so the root typecheck does not take the whole phone app in with this file
const useEarlierPath = '../mobile/src/remote/useEarlier';
const { useEarlier, backfill, BACKFILL_PAGE, FILL_RETRIES } = await import(useEarlierPath);

// the test kit holds every other phone test's fill off (rows 0): this file turns it on and puts the kit's values back
const defaults = { ...backfill };
afterEach(() => {
  Object.assign(backfill, defaults);
  (globalThis as any).__phoneAppState = undefined;
});
/** The same loop at a fiftieth of the pace, so that "nothing is asked" is watched over many ticks. */
const quick = (extra: object = {}) => Object.assign(backfill, { rows: 1000, gap: 5, retry: 20, retryMax: 40 }, extra);

const id = (n: number) => `r${String(n).padStart(5, '0')}`;
const thread = (top: number, turnStatus = 'idle') => ({
  shape: 'rows',
  items: [{ id: id(top), role: 'user', text: 'newest question' }],
  history: [],
  session: { turnStatus },
});
/** A page of `n` rows ending before row `from`, newest last. */
const page = (from: number, n: number, more = true) => ({
  chatId: 'c',
  rows: Array.from({ length: n }, (_, i) => ({ id: id(from - n + i), role: 'user', text: `older ${from - n + i}` })),
  more,
  omitted: false,
});
const start = (p: any) => Number(p.before.slice(1));
const pause = (ms: number) => act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** `read` answers chat.read; `hello`: what machine.hello says about older rows held (or that it cannot be asked). */
function rig(read: (params: any, calls: any[]) => unknown, hello: 'held' | 'older' | 'fails' = 'held') {
  const calls: any[] = [];
  const request: any = async (method: string, params: any) => {
    if (method === 'machine.hello') {
      if (hello === 'fails') throw new Error('hello failed');
      return { capabilities: { methods: ['chat.read'], olderRowsHeld: hello === 'held' } };
    }
    calls.push(params);
    return read(params, calls);
  };
  return { request, calls };
}

async function mount(request: any, first: any) {
  const seen: { busy: boolean; error: string | null }[] = [];
  const out: { api: any } = { api: null };
  const Probe = ({ thread: t }: { thread: any }) => {
    const api = useEarlier(request, 'c');
    out.api = api;
    seen.push({ busy: api.busy, error: api.error });
    useEffect(() => api.fill(t), [api.fill, t]);
    return null;
  };
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe, { thread: first })));
  return {
    out,
    seen,
    render: (t: any) => act(async () => root.render(createElement(Probe, { thread: t }))),
    done: () => act(async () => root.unmount()),
  };
}
// polls on the real clock, flushing React between looks (a loaded runner gets the same chance as an idle one)
const until = (done: () => boolean) => waitFor(done, 'the fill to get there', { step: () => pause(10) });
const ids = (api: any) => api.rows.map((r: any) => r.id);
const near = { nativeEvent: { contentOffset: { y: 0 }, layoutMeasurement: { height: 800 } } };

test('the fill adds pages above the snapshot in order, silently, and stops at the start of the chat', async () => {
  quick();
  const { request, calls } = rig((p) => page(start(p), Math.min(100, start(p)), start(p) > 100));
  const t = await mount(request, thread(250));
  await until(() => t.out.api.more === false);
  assert.deepEqual(
    calls.map((c) => [c.before, c.limit]),
    [
      ['r00250', BACKFILL_PAGE],
      ['r00150', BACKFILL_PAGE],
      ['r00050', BACKFILL_PAGE],
    ],
  );
  const held = ids(t.out.api);
  assert.equal(held.length, 250, 'every row above the snapshot, once');
  assert.deepEqual(held, [...held].sort(), 'oldest first, in order');
  assert.equal(held[0], id(0));
  assert.equal(held.at(-1), id(249));
  assert.ok(
    t.seen.every((s) => !s.busy && s.error === null),
    'no render of the fill showed a busy row or an error',
  );
  await pause(100);
  assert.equal(calls.length, 3, 'a chat that starts there is asked no more');
  await t.done();
});

test('a failed fill page shows nothing and is asked again later, from the same row, and the fill goes on', async () => {
  quick();
  let failing = 2;
  const { request, calls } = rig((p) => {
    if (failing-- > 0) throw new Error('Your computer is offline.');
    return page(start(p), 100, false);
  });
  const t = await mount(request, thread(500));
  await until(() => t.out.api.rows.length === 100);
  await pause(100);
  assert.deepEqual(
    calls.map((c) => c.before),
    ['r00500', 'r00500', 'r00500'],
    'the same page, three times, and nothing after the page that said the chat starts there',
  );
  assert.equal(t.out.api.rows.length, 100);
  assert.ok(
    t.seen.every((s) => !s.busy && s.error === null),
    'neither the failures nor the retries were shown',
  );
  await t.done();
});

test('the fill gives up after FILL_RETRIES failures in a row (a page that adds nothing is one), and the reader can still ask', async () => {
  quick({ retry: 1, retryMax: 2 });
  // every page repeats the snapshot's own first row: it adds nothing, though it says there is more
  const stalled = rig(() => ({ chatId: 'c', rows: [{ id: id(500), role: 'user', text: 'newest question' }], more: true, omitted: false }));
  const t = await mount(stalled.request, thread(500));
  await until(() => stalled.calls.length >= FILL_RETRIES);
  await pause(150);
  assert.equal(stalled.calls.length, FILL_RETRIES, 'then no more');
  assert.equal(t.out.api.error, null, 'nothing was shown');
  await act(async () => t.out.api.load(thread(500)));
  assert.equal(stalled.calls.length, FILL_RETRIES + 1, 'the reader asks, and is told it did not work');
  assert.match(t.out.api.error, /did not load/);
  await t.done();
});

test('a fill that gave up while the Mac was away tries again when the Mac answers with a new snapshot, and goes on', async () => {
  quick({ retry: 1, retryMax: 2 });
  // the first page is answered; the Mac then goes away, so that every ask after it times out, until the test lets it back
  let away = true;
  const { request, calls } = rig((p, seen) => {
    if (away && seen.length > 1) throw new Error('Request timed out');
    return page(start(p), 100, start(p) > 100);
  });
  const t = await mount(request, thread(500));
  await until(() => calls.length >= 1 + FILL_RETRIES);
  await pause(100);
  assert.equal(calls.length, 1 + FILL_RETRIES, 'given up while the Mac is away');
  assert.equal(t.out.api.rows.length, 100);
  away = false;
  // the Mac answers again with a snapshot that starts at the same row: the rows held stay, nothing is read again from the start
  const next = { ...thread(500), items: [...thread(500).items, { id: id(501), role: 'assistant', text: 'newer' }] };
  await act(async () => t.out.api.reread(thread(500), next));
  await t.render(next);
  await until(() => t.out.api.rows.length >= 200);
  assert.ok(calls.length > 1 + FILL_RETRIES, 'asked again');
  await t.done();
});

test('a Mac that could not be asked what it holds is asked again when it next answers, and the fill starts', async () => {
  quick();
  let hello = 'down';
  const inner = rig((p) => page(start(p), 100, false));
  const request: any = async (method: string, params: any) => {
    if (method === 'machine.hello' && hello === 'down') throw new Error('Connect to a computer first');
    return inner.request(method, params);
  };
  const t = await mount(request, thread(500));
  await pause(100);
  assert.equal(inner.calls.length, 0, 'not known to be cheap: nothing is asked');
  hello = 'up';
  const next = { ...thread(500), items: [...thread(500).items, { id: id(501), role: 'assistant', text: 'newer' }] };
  await act(async () => t.out.api.reread(thread(500), next));
  await t.render(next);
  await until(() => t.out.api.rows.length === 100);
  await t.done();
});

test('the fill waits while a turn streams, while the app is away and while a finger is on the list, and goes on after', async () => {
  quick();
  const { request, calls } = rig((p) => page(start(p), 100, start(p) > 300));
  const t = await mount(request, thread(1000, 'running'));
  await pause(120);
  assert.equal(calls.length, 0, 'a turn is streaming');
  await t.render(thread(1000, 'idle'));
  await until(() => calls.length >= 1);
  (globalThis as any).__phoneAppState = 'background';
  await pause(30);
  const away = calls.length;
  await pause(120);
  assert.equal(calls.length, away, 'the app is away');
  (globalThis as any).__phoneAppState = 'inactive';
  await pause(60);
  assert.equal(calls.length, away, 'on its way away counts');
  (globalThis as any).__phoneAppState = 'active';
  await until(() => calls.length > away);
  await act(async () => t.out.api.grab());
  await pause(30);
  const down = calls.length;
  await pause(120);
  assert.equal(calls.length, down, 'a finger is on the list');
  await act(async () => t.out.api.release());
  await until(() => calls.length > down);
  await t.done();
});

test('the fill stops at its byte cap, keeping the rows it held', async () => {
  quick({ bytes: 3000 });
  const { request, calls } = rig((p) => page(start(p), 100, true));
  const t = await mount(request, thread(5000));
  await until(() => calls.length >= 1);
  await pause(150);
  assert.equal(calls.length, 1, 'one page of about 10 KB is past a cap of 3 KB');
  assert.equal(t.out.api.rows.length, 100);
  await t.done();
});

test('the fill stops at its row cap', async () => {
  quick({ rows: 250 });
  const { request, calls } = rig((p) => page(start(p), 100, true));
  const t = await mount(request, thread(5000));
  await until(() => t.out.api.rows.length >= 250);
  await pause(150);
  assert.equal(calls.length, 3, '100, 200, 300 rows held: past 250, no more');
  await t.done();
});

test('the reader asking while a fill page is on its way waits for it, shows loading meanwhile, and the next scroll asks again', async () => {
  quick();
  let release: (v: unknown) => void = () => {};
  const { request, calls } = rig((p, all) =>
    all.length === 1 ? new Promise((resolve) => (release = resolve)) : page(start(p), 100, true),
  );
  const t = await mount(request, thread(5000));
  await until(() => calls.length === 1);
  await act(async () => t.out.api.grab());
  await act(async () => t.out.api.scrolled(thread(5000), near));
  assert.equal(t.out.api.busy, true, 'the reader is waiting, and the row says so');
  assert.equal(calls.length, 1, 'no second request while one is out');
  await act(async () => release(page(5000, 100, true)));
  // the page has arrived, but nothing is mounted above a finger that is down: the rows join when it lifts
  const before = calls.length;
  await act(async () => t.out.api.scrolled(thread(5000), near));
  assert.ok(calls.length > before, 'the finger that asked is still down: the next scroll asks');
  await act(async () => t.out.api.release());
  await until(() => t.out.api.busy === false);
  assert.equal(t.out.api.rows.length >= 100, true);
  await t.done();
});

test("a list that cannot hold the reader's place adds nothing above it", async () => {
  quick({ rows: 0 });
  const { request } = rig(() => page(100, 10));
  const t = await mount(request, thread(5000));
  let revealed = 0;
  await act(async () => t.out.api.grab());
  await act(async () => t.out.api.scrolled(thread(5000), near, { hidden: 40, reveal: () => revealed++, holds: false }));
  assert.equal(revealed, 0);
  await act(async () => t.out.api.scrolled(thread(5000), near, { hidden: 40, reveal: () => revealed++, holds: true }));
  assert.equal(revealed, 0, 'the finger is down: the rows wait for it');
  await act(async () => t.out.api.release());
  assert.equal(revealed, 1);
  await t.done();
});

test('a Host chat, whose history is read whole, is asked once and the fill ends there', async () => {
  quick();
  const { request, calls } = rig(() => ({ chatId: 'c', rows: [], more: false, omitted: false }));
  const t = await mount(request, thread(5000));
  await until(() => t.out.api.more === false);
  await pause(100);
  assert.equal(calls.length, 1);
  assert.equal(t.out.api.rows.length, 0);
  assert.equal(t.out.api.error, null);
  assert.ok(t.seen.every((s) => !s.busy));
  await t.done();
});

test('a Mac that does not say it pages from held rows, or cannot be asked, is not filled', async () => {
  quick();
  for (const hello of ['older', 'fails'] as const) {
    const { request, calls } = rig(() => page(100, 10), hello);
    const t = await mount(request, thread(5000));
    await pause(120);
    assert.equal(calls.length, 0, hello);
    await t.done();
  }
});

test('a chat that is left stops filling, and a page on its way then is not added', async () => {
  quick();
  let release: (v: unknown) => void = () => {};
  const { request, calls } = rig((p, all) =>
    all.length === 2 ? new Promise((resolve) => (release = resolve)) : page(start(p), 100, true),
  );
  const t = await mount(request, thread(5000));
  await until(() => calls.length === 2);
  await t.done();
  const asked = calls.length;
  release(page(4900, 100, true));
  await pause(120);
  assert.equal(calls.length, asked, 'nothing is asked after the chat is closed');
});
