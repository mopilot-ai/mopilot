// MoMo notice change detection (shared/momoNotice/changeDetect.ts): thread and event versions, the calendar probe, paging, and marking changes seen, all against a fake Google client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarToken,
  detectEventChanges,
  detectMailChanges,
  eventVersion,
  markCalendarSynced,
  markSeen,
  threadVersion,
} from '../shared/momoNotice/changeDetect.ts';
import { noticeSettings } from '../shared/momoNotice/limits.ts';
import { createMemoryVersionStore } from '../shared/momoNotice/memoryStore.ts';
import type { CalendarEvent, GoogleClient, ThreadMeta } from '../shared/momoNotice/types.d.ts';

const thread = (id: string, ...messages: ThreadMeta['messages']): ThreadMeta => ({ id, historyId: 'h', messages });
const msg = (id: string, internalDate: string, ...labelIds: string[]) => ({ id, internalDate, labelIds });
const NOW = new Date('2026-11-24T10:00:00Z');
const HOME = { now: NOW, settings: noticeSettings('UTC') };

function client(over: Partial<GoogleClient> = {}): GoogleClient {
  return {
    listThreads: async () => ({ threadIds: [] }),
    getThreadMeta: async () => null,
    listEvents: async () => ({ events: [] }),
    calendarEtag: async () => 'etag-1',
    ...over,
  };
}

test('a thread version ignores order of arrival, read state and hidden messages, and changes on a new or sent message', () => {
  const a = threadVersion(thread('t', msg('1', '100'), msg('2', '200')));
  assert.equal(a, threadVersion(thread('t', msg('2', '200'), msg('1', '100', 'UNREAD'))));
  assert.notEqual(a, threadVersion(thread('t', msg('1', '100'), msg('2', '200'), msg('3', '300'))));
  assert.notEqual(a, threadVersion(thread('t', msg('1', '100'), msg('2', '200', 'SENT'))));
  assert.equal(
    a,
    threadVersion(
      thread('t', msg('1', '100'), msg('2', '200'), msg('9', '900', 'DRAFT'), msg('8', '800', 'SPAM'), msg('7', '700', 'TRASH')),
    ),
  );
  assert.equal(threadVersion(thread('t', msg('9', '900', 'DRAFT'))), null);
  assert.equal(
    threadVersion({ id: 't', messages: [{ id: '1', internalDate: '1' }] }),
    threadVersion({ id: 't', messages: [{ id: '1', internalDate: '1', labelIds: [] }] }),
  );
});

test('an event version changes with any field and the probe token with the etag or the day', () => {
  const event: CalendarEvent = { id: 'e', status: 'confirmed', summary: 'Visit' };
  assert.equal(eventVersion(event), eventVersion({ ...event }));
  assert.notEqual(eventVersion(event), eventVersion({ ...event, summary: 'Visit 3pm' }));
  assert.notEqual(calendarToken('a', '2026-11-24'), calendarToken('b', '2026-11-24'));
  assert.notEqual(calendarToken('a', '2026-11-24'), calendarToken('a', '2026-11-25'));
});

test('mail changes: only new or changed threads, across pages, skipping gone and empty ones; marking seen silences them', async () => {
  const threads: Record<string, ThreadMeta | null> = {
    one: thread('one', msg('1', '100')),
    two: thread('two', msg('2', '200')),
    gone: null,
    draftOnly: thread('draftOnly', msg('3', '300', 'DRAFT')),
    three: thread('three', msg('4', '400')),
  };
  const queries: any[] = [];
  const google = client({
    listThreads: async (query) => {
      queries.push(query);
      return query.pageToken ? { threadIds: ['three'] } : { threadIds: ['one', 'two', 'gone', 'draftOnly'], nextPageToken: 'p2' };
    },
    getThreadMeta: async (id) => threads[id],
  });
  const store = createMemoryVersionStore();
  const first = await detectMailChanges(google, store, HOME);
  assert.deepEqual(
    first.map((c) => c.kind === 'mail' && c.threadId),
    ['one', 'two', 'three'],
  );
  assert.equal(queries[0].maxResults, 20);
  assert.equal(queries[0].afterMs, NOW.getTime() - 30 * 86_400_000);
  assert.equal(queries[1].pageToken, 'p2');
  for (const change of first) await markSeen(store, change);
  assert.deepEqual(await detectMailChanges(google, store, { ...HOME, windowMs: 1000, pageSize: 5 }), []);
  assert.equal(queries[2].maxResults, 5);
  threads.two = thread('two', msg('2', '200'), msg('5', '500'));
  const again = await detectMailChanges(google, store, HOME);
  assert.deepEqual(
    again.map((c) => c.kind === 'mail' && c.threadId),
    ['two'],
  );
});

test('a failed read is thrown, not treated as unchanged', async () => {
  const google = client({
    listThreads: async () => ({ threadIds: ['x'] }),
    getThreadMeta: async () => {
      throw new Error('HTTP 429');
    },
  });
  await assert.rejects(detectMailChanges(google, createMemoryVersionStore(), HOME), /429/);
});

test('event changes: an unchanged probe lists nothing; a changed one lists new and edited events across pages', async () => {
  const events: CalendarEvent[] = [
    { id: 'a', status: 'confirmed', summary: 'A' },
    { id: 'b', status: 'confirmed', summary: 'B' },
  ];
  const queries: any[] = [];
  let etag = 'etag-1';
  const google = client({
    calendarEtag: async () => etag,
    listEvents: async (query) => {
      queries.push(query);
      return query.pageToken ? { events: [events[1]] } : { events: [events[0]], nextPageToken: 'n2' };
    },
  });
  const store = createMemoryVersionStore();
  const first = await detectEventChanges(google, store, HOME);
  assert.deepEqual(
    first.changes.map((c) => c.kind === 'event' && c.eventId),
    ['a', 'b'],
  );
  assert.equal(queries[0].timeMin, '2026-11-24T00:00:00.000Z');
  assert.equal(queries[0].showDeleted, true);
  assert.equal(queries[0].updatedMin, undefined);
  assert.equal(queries[0].timeMax, '2026-12-25T00:00:00.000Z');
  assert.equal(queries[1].pageToken, 'n2');
  for (const change of first.changes) await markSeen(store, change);
  await markCalendarSynced(store, first.token, NOW);
  assert.deepEqual(await detectEventChanges(google, store, HOME), { changes: [], token: first.token });
  assert.equal(queries.length, 2);
  etag = 'etag-2';
  events[1] = { ...events[1], summary: 'B moved' };
  const second = await detectEventChanges(google, store, { ...HOME, pageSize: 7 });
  assert.deepEqual(
    second.changes.map((c) => c.kind === 'event' && c.eventId),
    ['b'],
  );
  assert.equal(queries[2].maxResults, 7);
  assert.equal(queries[2].updatedMin, '2026-11-24T09:55:00.000Z');
});

test('the memory version store returns what was set', async () => {
  const store = createMemoryVersionStore();
  assert.equal(await store.get('k'), undefined);
  await store.set('k', 'v');
  assert.equal(await store.get('k'), 'v');
});

test('the calendar window is the home’s days, never earlier than the connect day', async () => {
  const queries: any[] = [];
  const google = client({ listEvents: async (query) => (queries.push(query), { events: [] }) });
  const store = createMemoryVersionStore();
  // 20:00 UTC is already the 25th in Shanghai
  const shanghai = { now: new Date('2026-11-24T20:00:00Z'), settings: noticeSettings('Asia/Shanghai') };
  await detectEventChanges(google, store, shanghai);
  assert.deepEqual([queries[0].timeMin, queries[0].timeMax], ['2026-11-24T16:00:00.000Z', '2026-12-25T16:00:00.000Z']);
  await detectEventChanges(google, store, { ...shanghai, connectDay: '2026-11-27' });
  assert.equal(queries[1].timeMin, '2026-11-26T16:00:00.000Z');
  await detectEventChanges(google, store, { ...shanghai, connectDay: '2026-11-01' });
  assert.equal(queries[2].timeMin, '2026-11-24T16:00:00.000Z');
});

test('the probe token follows the home day, so a quiet calendar is still looked at once a home day', async () => {
  const google = client();
  const store = createMemoryVersionStore();
  const late = { now: new Date('2026-11-24T20:00:00Z'), settings: noticeSettings('Asia/Shanghai') };
  const first = await detectEventChanges(google, store, late);
  await markCalendarSynced(store, first.token, late.now);
  assert.deepEqual((await detectEventChanges(google, store, { ...late, now: new Date('2026-11-24T22:00:00Z') })).changes, []);
  const next = await detectEventChanges(google, store, { ...late, now: new Date('2026-11-25T16:30:00Z') });
  assert.notEqual(next.token, first.token);
});
