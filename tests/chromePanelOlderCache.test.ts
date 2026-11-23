// A phone paging back through a long chat reads its history once, not once per page (#5379): the page producer holds the rows it made, for as long as the history's stamp is the one they were made from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPanelOlder } = require('../electron/app/chromePanelOlder.cjs');
const { createPanelRowsCache } = require('../electron/app/panelRowsCache.cjs');
const { rowsOf, recentRowsOf, allRowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');

/** A chat of `n` turns of two messages each; `tag` says which version of its text this is. */
const chat = (n: number, tag = 'a') =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    items: [
      { id: `u${i}`, type: 'userMessage', content: [{ type: 'text', text: `${tag} question ${i}` }] },
      { id: `a${i}`, type: 'agentMessage', text: `${tag} answer ${i}` },
    ],
  }));

/** The history source of a chat: windows of the last 4, 16 and 64 turns, then the whole chat, with a stamp that changes when `state.turns` does. */
function source(turns: any[]) {
  const state = { turns, stamp: 's1' as string | null | 'throw' };
  const calls = { recent: 0, whole: 0, stamp: 0 };
  const historyOf: any = async () => (calls.whole++, { turns: state.turns, earlierContentOmitted: false });
  historyOf.recent = async (_chat: string, { enough }: any) => {
    calls.recent++;
    for (const n of [4, 16, 64]) {
      const window = state.turns.slice(-n);
      if (n < state.turns.length && enough(window)) return { turns: window, earlierContentOmitted: true };
    }
    return { turns: state.turns, earlierContentOmitted: false };
  };
  historyOf.stamp = async () => {
    calls.stamp++;
    if (state.stamp === 'throw') throw new Error('stat failed');
    return state.stamp;
  };
  return { historyOf, state, calls };
}
const producer = (historyOf: any, notes: any[] = [], extra: object = {}) => {
  const records = new Map<string, any>([['c', { meta: { notes }, segments: [] }]]);
  return { records, older: createPanelOlder({ live: { chats: { records } }, reachable: () => true, historyOf, ...extra }) };
};
/** Every page from the snapshot back to the start, the way a phone asks: each ends before the first row of the last. */
async function walk(older: any, turns: any[], limit = 10) {
  let before = (recentRowsOf(turns, {}).rows[0] as any).id;
  const pages: any[] = [];
  for (;;) {
    const page = await older('c', before, limit);
    assert.ok(page, 'the row asked for is there');
    pages.push(page);
    if (!page.more) return pages;
    before = page.rows[0].id;
  }
}

test('pages from held rows are the pages a fresh read gives, and the history is read a few times, not once per page', async () => {
  const turns = chat(400);
  const fresh = source(turns);
  fresh.state.stamp = null;
  const held = source(turns);
  const expected = await walk(producer(fresh.historyOf).older, turns);
  const got = await walk(producer(held.historyOf).older, turns);
  assert.deepEqual(got, expected);
  assert.ok(expected.length > 50, `${expected.length} pages`);
  assert.equal(fresh.calls.recent, expected.length, 'with no stamp every page reads');
  assert.ok(held.calls.recent <= 6, `${held.calls.recent} reads for ${got.length} pages: one per window that was too small`);
  assert.equal(held.calls.stamp, got.length, 'a stamp is asked for at every page, which is how a changed history is told');
});

test('a history that grows between pages is read again, and the page is the new history, never the held one', async () => {
  const { historyOf, state, calls } = source(chat(150));
  const { older } = producer(historyOf);
  const first = (recentRowsOf(chat(150), {}).rows[0] as any).id;
  const page = await older('c', first, 10);
  const reads = calls.recent;
  assert.equal(page.rows.length, 10);
  // another turn is appended: the stamp changes, and the oldest rows are read again under it
  state.turns = chat(151);
  state.stamp = 's2';
  const next = await older('c', page.rows[0].id, 10);
  assert.ok(calls.recent > reads, 'read again');
  const after = calls.recent;
  assert.deepEqual(next, await older('c', page.rows[0].id, 10), 'and held under the new stamp: the same page, with no read');
  assert.equal(calls.recent, after);
});

test('a history rewritten or compacted between pages: rows made from the old one are not served, and a row that is gone says so', async () => {
  const { historyOf, state, calls } = source(chat(150, 'a'));
  const { older } = producer(historyOf);
  const start = (recentRowsOf(chat(150), {}).rows[0] as any).id;
  const page = await older('c', start, 10);
  assert.match(page.rows[0].text, /^a /);
  // the same ids with other text (an edit and a resend): another stamp, so the text is the new text
  state.turns = chat(150, 'b');
  state.stamp = 's2';
  const rewritten = await older('c', start, 10);
  assert.ok(
    rewritten.rows.every((r: any) => /^b /.test(r.text)),
    'the rewritten text',
  );
  // a compaction folds the earliest turns away: the row a phone names is not in the history any more
  state.turns = chat(150, 'b').slice(75);
  state.stamp = 's3';
  assert.equal(await older('c', (rowsOf(chat(150)).rows[5] as any).id, 10), null);
  assert.ok(calls.recent >= 3);
});

test('a history with no stamp, a stamp that cannot be read, and a source that has none are read at every page, as before', async () => {
  const a = source(chat(150));
  a.state.stamp = null;
  const { older } = producer(a.historyOf);
  const id = (recentRowsOf(chat(150), {}).rows[0] as any).id;
  await older('c', id, 10);
  await older('c', id, 10);
  assert.equal(a.calls.recent, 2);
  const b = source(chat(150));
  b.state.stamp = 'throw';
  const other = producer(b.historyOf).older;
  assert.equal((await other('c', id, 10)).rows.length, 10);
  assert.equal((await other('c', id, 10)).rows.length, 10);
  assert.equal(b.calls.recent, 2);
  // a source with no stamp at all (a runtime that cannot read an end, or a harness that cannot name its history)
  const plain: any = async () => ({ turns: chat(150), earlierContentOmitted: false });
  const bare = producer(plain).older;
  assert.equal((await bare('c', id, 10)).rows.length, 10);
});

test('what is held is for the same notes and the same kind of chat: another note changes the rows, so they are made again', async () => {
  const { historyOf, calls } = source(chat(150));
  const { older, records } = producer(historyOf, []);
  const id = (recentRowsOf(chat(150), {}).rows[0] as any).id;
  await older('c', id, 10);
  await older('c', id, 10);
  const reads = calls.recent;
  records.get('c').meta.notes = [{ id: 'n1', turnId: 't95', text: 'a note' }];
  await older('c', id, 10);
  assert.ok(calls.recent > reads, 'a note was added');
});

test("rows made from a window that stopped short are not served as the chat's first page: the page that reaches the first row held reads again", async () => {
  const { historyOf, calls } = source(chat(150));
  const { older } = producer(historyOf);
  const near = (allRowsOf(chat(150), false, false)[250] as any).id;
  // a page near the end is made from a window of the last 64 turns, with earlier turns left unread
  const page = await older('c', near, 10);
  assert.equal(page.more, true);
  const reads = calls.recent;
  await older('c', near, 10);
  assert.equal(calls.recent, reads, 'a page inside the held rows is a slice');
  // a page that would reach back past the window's first row cannot be said to start the chat: the history is read for it
  const deep = await older('c', near, 200);
  assert.ok(calls.recent > reads);
  assert.equal(deep.rows.length, 200);
  assert.equal(deep.more, true);
});

test('the byte bound holds even for a chat paged to its start: a cache that holds nothing still serves every page', async () => {
  const cache = createPanelRowsCache({ maxBytes: 10 });
  const { historyOf, calls } = source(chat(300));
  const { older } = producer(historyOf, [], { cache });
  const turns = chat(300);
  const pages = await walk(older, turns);
  assert.ok(pages.length > 10);
  assert.equal(cache.size().chats, 0);
  assert.equal(calls.recent, pages.length, 'nothing was held: every page read');
});
