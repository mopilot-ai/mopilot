// A long chat mounts its newest blocks only; older ones the phone already holds come a page at a time as the reader scrolls up, before the computer is asked (#4986 F4b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const windowPath = '../mobile/src/remote/useBlockWindow';
const { Thread } = await import(threadPath);
const { WINDOW, ALL, blockKey, windowStart } = await import(windowPath);

/** `n` saved rows, each its own block: you and the reply in turn, so nothing folds into a run. */
const rowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, role: i % 2 === 0 ? 'user' : 'assistant', text: `row-${i}-end` }));
const shownCount = (host: HTMLElement) => (host.textContent!.match(/row-\d+-end/g) ?? []).length;

async function mount(n: number) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const reads: any[] = [];
  const listeners = new Set<(e: any) => void>();
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: (e: any) => void) => (listeners.add(f), () => listeners.delete(f)),
    request: async (method: string, params: any) => {
      if (method === 'chat.follow')
        return { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: rowsOf(n) };
      if (method === 'chat.read') {
        reads.push(params);
        return { chatId: 'c', rows: [{ id: 'r-older', role: 'user', text: 'row-older-end' }], more: false };
      }
      return {};
    },
  };
  withOutbox(runtime);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  const open = (chatId: string) =>
    act(async () => root.render(createElement(Thread, { runtime, chatId, back: () => {}, drafts: fakeDraft('') })));
  const toTop = async () => {
    await act(async () => (globalThis as any).__scrollEvents.onScrollBeginDrag());
    const event = new Event('scroll');
    Object.assign(event, { contentOffset: { y: 0 } });
    await act(async () => void document.querySelector('[scrolleventthrottle]')!.dispatchEvent(event));
    await flush();
  };
  return {
    host,
    reads,
    emit: (e: any) => act(async () => listeners.forEach((l) => l({ kind: 'event', chatId: 'c', ...e }))),
    open,
    toTop,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a chat of 400 rows opens with its newest 120 blocks mounted, and a short one mounts all', async () => {
  const t = await mount(400);
  assert.equal(shownCount(t.host), WINDOW);
  assert.match(t.host.textContent!, /row-399-end/);
  assert.doesNotMatch(t.host.textContent!, /row-0-end/);
  assert.match(t.host.textContent!, /Load earlier messages/, 'the row above says there is more');
  await t.done();
  const short = await mount(30);
  assert.equal(shownCount(short.host), 30);
  assert.match(short.host.textContent!, /row-0-end/);
  await short.done();
});

test('a finger that reaches the top mounts the next page of held rows, and the computer is asked only when all are shown', async () => {
  const t = await mount(400);
  await t.toTop();
  assert.equal(shownCount(t.host), 2 * WINDOW);
  assert.equal(t.reads.length, 0, 'held rows first: nothing is asked of the computer');
  await t.toTop();
  assert.equal(shownCount(t.host), 3 * WINDOW);
  await t.toTop();
  assert.equal(shownCount(t.host), 400, 'the last page is what is left');
  assert.match(t.host.textContent!, /row-0-end/);
  assert.equal(t.reads.length, 0);
  await t.toTop();
  assert.equal(t.reads.length, 1, 'everything held is mounted: now the computer is asked for the page before');
  assert.match(t.host.textContent!, /row-older-end/, 'and what it sends is shown, not held back');
  await t.done();
});

test('the Load earlier row mounts held rows first, then asks the computer', async () => {
  const t = await mount(200);
  assert.equal(shownCount(t.host), WINDOW);
  await click('Load earlier messages');
  assert.equal(shownCount(t.host), 200);
  assert.equal(t.reads.length, 0);
  await click('Load earlier messages');
  assert.equal(t.reads.length, 1);
  await t.done();
});

test('the window starts at the end, keeps its first block while the chat grows, and starts again when that block is gone', () => {
  const blocks = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ type: 'row', row: { key: `k${from + i}`, role: 'user', text: '' } })) as any[];
  const open = windowStart(blocks(300), null);
  assert.equal(open.from, 300 - WINDOW);
  assert.equal(open.anchor, blockKey(blocks(300)[300 - WINDOW]));
  const grown = windowStart(blocks(310), open.anchor);
  assert.equal(grown.from, 300 - WINDOW, 'nothing falls off the top while the chat grows');
  assert.equal(windowStart(blocks(300, 1000), open.anchor).from, 300 - WINDOW, 'the first block is gone: from the end again');
  assert.deepEqual(windowStart(blocks(30), null), { from: 0, anchor: null });
  assert.deepEqual(windowStart(blocks(30), 'gone'), { from: 0, anchor: null }, 'a short chat whose first block went shows all of it');
  assert.deepEqual(windowStart(blocks(500), ALL), { from: 0, anchor: ALL }, 'opened to the first block: all of it, whatever joins above');
});

test('another chat opens at its end again, not where the last one was scrolled to', async () => {
  const t = await mount(400);
  await t.toTop();
  assert.equal(shownCount(t.host), 2 * WINDOW);
  await t.open('other');
  await flush();
  assert.equal(shownCount(t.host), WINDOW);
  await t.done();
});

test('a streamed delta while the reader is far up changes the live reply only: no row above it is mounted again or moved', async () => {
  const t = await mount(400);
  await t.toTop();
  await t.toTop();
  const rows = () =>
    [...t.host.querySelectorAll('p, span, div')].filter((n) => /^row-\d+-end$/.test(n.textContent ?? '') && n.children.length === 0);
  const before = rows();
  assert.equal(before.length, 3 * WINDOW);
  await t.emit({ ev: 'items.append', feedSeq: 1, live: true, items: [{ id: 'live', type: 'agentMessage', text: 'Hello' }] });
  await t.emit({ ev: 'items.delta', feedSeq: 2, itemId: 'live', field: 'text', text: ' there' });
  assert.match(t.host.textContent!, /Hello/, 'the live reply is there (its words are revealed at the stream pace)');
  const after = rows();
  assert.equal(after.length, before.length, 'the window did not slide: nothing fell off its top');
  assert.ok(
    before.every((node) => after.includes(node)),
    'every mounted row is the same element as before',
  );
  await t.done();
});

test('a page revealed above keeps the rows under the finger as they are and brings no entrance with it', async () => {
  const t = await mount(400);
  const last = () => [...t.host.querySelectorAll('*')].find((n) => n.children.length === 0 && n.textContent === 'row-399-end')!;
  const node = last();
  // the first page draws without its entrance (the test kit keeps the entrance a row asked for as data): the page that joins above asks for none
  const entrances = () => t.host.querySelectorAll('[data-entering]').length;
  const before = entrances();
  await t.toTop();
  assert.equal(shownCount(t.host), 2 * WINDOW);
  assert.equal(last(), node, 'the row at the end is the same element: nothing below was mounted again');
  assert.ok(before > 0, 'the rows of the first page asked for their entrance');
  assert.equal(entrances(), 0, 'rows that joined above ask for none, and the page stays still');
  await t.done();
});

test('your own message sent in a windowed chat is the last block mounted, in the window', async () => {
  const t = await mount(400);
  await t.emit({
    ev: 'items.append',
    feedSeq: 1,
    live: true,
    items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'sent-now' }] }],
  });
  assert.match(t.host.textContent!, /sent-now/);
  assert.equal(shownCount(t.host), WINDOW, 'the window grew at its end and kept its start');
  await t.done();
});

test('a folded run of steps is known by its own key in the list, a row by the row key, and a window can start at a run', () => {
  const row = (key: string) => ({ type: 'row', row: { key, role: 'assistant', text: key } }) as any;
  const run = { type: 'run', key: 'steps-1', steps: [], summary: 'Ran 2 commands', running: false } as any;
  assert.equal(blockKey(run), 'run:steps-1');
  assert.equal(blockKey(row('r1')), 'r1');
  // a window of two over [row, run, row]: it starts at the run and remembers it by that key
  assert.deepEqual(windowStart([row('a'), run, row('b')], null, 2), { from: 1, anchor: 'run:steps-1' });
  assert.deepEqual(windowStart([row('a'), run, row('b')], 'run:steps-1', 2), { from: 1, anchor: 'run:steps-1' });
});
