// A follow snapshot carries the feed watermark it includes, including text flushed while the snapshot is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { createItemFeed } = require('../electron/harness/remoteItemFeed.cjs');
const { openPhoneItems } = require('../electron/app/chromePanelPhones.cjs');
const started = { method: 'item/started', params: { item: { type: 'agentMessage', id: 'm', text: '' } } };
const delta = (text: string) => ({ method: 'item/agentMessage/delta', params: { itemId: 'm', delta: text } });

test('a snapshot watermark covers batched deltas and its copied items never change underneath the client', () => {
  const events: any[] = [];
  const feed = createItemFeed({ emit: (event: any) => events.push(event) });
  feed.push('c1', 'codex', started);
  feed.push('c1', 'codex', delta('a'));
  feed.push('c1', 'codex', delta('b'));
  const first = feed.snapshot('c1', 10);
  assert.equal(first.items[0].text, 'ab');
  assert.equal(first.feedSeq, events.at(-1).feedSeq);
  feed.push('c1', 'codex', delta('c'));
  const second = feed.snapshot('c1', 10);
  assert.equal(second.items[0].text, 'abc');
  assert.equal(first.items[0].text, 'ab');
  assert.ok(second.feedSeq > first.feedSeq);
  assert.equal(
    events
      .filter((e) => e.feedSeq > first.feedSeq)
      .map((e) => e.text)
      .join(''),
    'c',
  );
  second.items[0].text = 'caller mutation';
  assert.equal(feed.snapshotItems('c1')[0].text, 'abc');
  assert.deepEqual(feed.snapshot('none', 0), {
    items: [],
    entries: [],
    liveItems: [],
    liveTurn: null,
    liveUnavailable: false,
    feedSeq: 0,
    historyChangedAt: 0,
  });
  assert.deepEqual(feed.snapshot('none'), {
    items: [],
    entries: [],
    liveItems: [],
    liveTurn: null,
    liveUnavailable: false,
    feedSeq: 0,
    historyChangedAt: 0,
  });
  feed.forget('c1');
});

test('a follow response and earlier live events share a watermark even when the reply is delayed', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const r = rig({
    ops: {
      cardsOf: async () => {
        await gate;
        return [];
      },
    },
  });
  const items = openPhoneItems({ service: () => r.service, chatOf: () => 'c1', rows: async () => [] });
  r.ops.items = items.items;
  const p = r.phone('p1');
  items.live('codex', { ...started, params: { ...started.params, threadId: 'native' } });
  items.live('codex', { ...delta('text'), params: { ...delta('text').params, threadId: 'native' } });
  items.live('codex', { ...delta(' batched'), params: { ...delta(' batched').params, threadId: 'native' } });
  await p.send({ id: 'follow', kind: 'request', method: 'chat.follow', params: { chatId: 'c1' } });
  await settle();
  assert.ok(p.events('items.delta').length > 0, 'live output reaches the phone before the reply');
  release();
  await settle();
  const response = p.inbox.find((m) => m.inReplyTo === 'follow');
  assert.equal(response.ok, true);
  assert.equal(response.result.items[0].text, 'text batched');
  assert.ok(p.events().every((e) => e.feedSeq <= response.result.feedSeq));
});

test('history fallback rechecks the live feed after the asynchronous rows read', async () => {
  let release!: (rows: any[]) => void;
  const rows = new Promise<any[]>((resolve) => {
    release = resolve;
  });
  const events: any[] = [];
  const service = { attached: true, onFeedEvent: (e: any) => events.push(e) };
  const items = openPhoneItems({ service: () => service, chatOf: () => 'c1', rows: async () => rows });
  const pending = items.items('c1', 10);
  items.live('codex', { ...started, params: { ...started.params, threadId: 'native' } });
  items.live('codex', { ...delta('new'), params: { ...delta('new').params, threadId: 'native' } });
  const history = [
    { role: 'user', text: 'Older message' },
    { role: 'assistant', text: 'Older reply' },
  ];
  release(history);
  const snap = await pending;
  assert.equal(snap.itemsShape, 'items');
  assert.equal(snap.items[0].text, 'new');
  assert.deepEqual(snap.history, history, 'a new live item must not replace the saved conversation');
  assert.equal(snap.feedSeq, events.at(-1).feedSeq);
  assert.deepEqual((await items.items('c1', 10)).history, history, 'history is retained when the live ring already exists');
  assert.deepEqual(await items.items('c1', 0), {
    itemsShape: 'rows',
    items: [],
    liveTurn: null,
    feedSeq: snap.feedSeq,
    historyStale: false,
    liveUnavailable: false,
  });
  const empty = openPhoneItems({ service: () => service, chatOf: () => '', rows: async () => [{ role: 'user', text: 'history' }] });
  assert.deepEqual(await empty.items('c1', 10), {
    itemsShape: 'rows',
    items: [{ role: 'user', text: 'history' }],
    liveTurn: null,
    feedSeq: 0,
    historyStale: false,
    liveUnavailable: false,
  });
});

test('a new turn retains saved history and exposes only its own live items', async () => {
  const events: any[] = [];
  const feed = createItemFeed({ emit: (event: any) => events.push(event) });
  const turn = (id: string, status: string, method = 'turn/started') => ({ method, params: { turn: { id, status } } });
  const item = (id: string, text: string, turnId: string) => ({
    method: 'item/completed',
    params: { turnId, item: { id, type: 'agentMessage', text } },
  });
  feed.push('c1', 'codex', turn('one', 'inProgress'));
  feed.push('c1', 'codex', item('a', 'First reply', 'one'));
  feed.push('c1', 'codex', turn('one', 'completed', 'turn/completed'));
  feed.push('c1', 'codex', turn('two', 'inProgress'));
  feed.push('c1', 'codex', item('b', 'Second reply', 'two'));
  feed.push('c1', 'codex', turn('two', 'inProgress'));
  const snapshot = feed.snapshot('c1');
  assert.deepEqual(
    snapshot.items.map((i: any) => i.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    snapshot.liveItems.map((i: any) => i.id),
    ['b'],
  );
  assert.deepEqual(snapshot.liveTurn, { id: 'two', status: 'inProgress' });
  snapshot.liveItems[0].text = 'changed';
  snapshot.liveTurn.id = 'changed';
  assert.equal(feed.snapshot('c1').liveItems[0].text, 'Second reply');
  assert.equal(feed.snapshot('c1').liveTurn.id, 'two');
  feed.push('c1', 'codex', turn('two', 'completed', 'turn/completed'));
  feed.push('c1', 'codex', turn('two', 'inProgress'));
  assert.equal(events.at(-1).live, false, 'reused ids cannot identify a new run without a new native identity');
  assert.equal(feed.snapshot('c1').liveTurn, null);
  assert.equal(feed.snapshot('c1').liveUnavailable, true);
  feed.push('c1', 'codex', item('ambiguous', 'Not an identified new run', 'two'));
  feed.push('c1', 'codex', { method: 'item/agentMessage/delta', params: { turnId: 'two', itemId: 'b', delta: ' ambiguous' } });
  assert.ok(events.slice(-2).every((event) => event.live === false));
  assert.deepEqual(feed.snapshot('c1').liveItems, []);
  feed.push('c1', 'codex', turn('three', 'inProgress'));
  feed.push('c1', 'codex', item('c', 'Identified run', 'three'));
  assert.equal(events.at(-1).live, true);
  assert.equal(feed.snapshot('c1').liveItems[0].text, 'Identified run');
  assert.ok(events.filter((e) => e.ev === 'turn.state' && e.started).length >= 2);
});

test('late events from an older turn cannot change the current live turn, including reused item ids', () => {
  const events: any[] = [];
  const feed = createItemFeed({ emit: (event: any) => events.push(event) });
  const push = (method: string, params: object) => feed.push('chat', 'codex', { method, params });
  push('turn/started', { turn: { id: 'old', status: 'inProgress' } });
  push('item/started', { turnId: 'old', item: { id: 'same', type: 'agentMessage', text: 'old' } });
  push('turn/started', { turn: { id: 'new', status: 'inProgress' } });
  push('item/started', { turnId: 'new', item: { id: 'same', type: 'agentMessage', text: 'current' } });
  push('item/completed', { turnId: 'old', item: { id: 'same', type: 'agentMessage', text: 'old complete' } });
  push('item/agentMessage/delta', { turnId: 'old', itemId: 'same', delta: ' old suffix' });
  push('item/agentMessage/delta', { turnId: 'new', itemId: 'same', delta: ' new suffix' });
  push('turn/completed', { turn: { id: 'old', status: 'completed' } });
  push('turn/started', { turn: { id: 'old', status: 'inProgress' } });
  push('turn/started', { turn: { status: 'inProgress' } });
  const snapshot = feed.snapshot('chat');
  assert.deepEqual(snapshot.liveTurn, { id: 'new', status: 'inProgress' });
  assert.equal(snapshot.liveItems.length, 1);
  assert.equal(snapshot.liveItems[0].text, 'current new suffix');
  assert.deepEqual(
    snapshot.items.map((item: any) => item.text),
    ['old complete old suffix', 'current new suffix'],
  );
  assert.ok(events.filter((e) => e.turnId === 'old' && e.feedSeq > 4).every((e) => e.live === false));
  push('item/completed', { item: { id: 'unknown', type: 'agentMessage', text: 'missing native ownership' } });
  assert.equal(feed.snapshot('chat').liveItems.length, 1, 'unowned events cannot claim a known current turn');
  assert.equal(events.at(-1).live, false);
});

test('a historical update during the rows read leaves an explicit snapshot refresh notice', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: any[] = [];
  const service = { attached: true, onFeedEvent: (event: any) => events.push(event) };
  let reading = false;
  const items = openPhoneItems({
    service: () => service,
    chatOf: () => 'chat',
    rows: async () => {
      const rows = [{ role: 'assistant', text: 'old history' }];
      if (reading) await gate;
      return rows;
    },
  });
  const push = (method: string, params: object) => items.live('codex', { method, params: { threadId: 'native', ...params } });
  push('turn/started', { turn: { id: 'old', status: 'inProgress' } });
  push('turn/started', { turn: { id: 'current', status: 'inProgress' } });
  reading = true;
  const pending = items.items('chat', 10);
  push('item/completed', { turnId: 'old', item: { id: 'old-reply', type: 'agentMessage', text: 'changed history' } });
  release();
  const snapshot = await pending;
  assert.equal(snapshot.historyStale, true);
  assert.equal(snapshot.feedSeq, events.at(-1).feedSeq);
  assert.equal((await items.items('chat', 10)).historyStale, false, 'a new read acknowledges the historical update');
});

test('exhausted turn identity tracking fails closed while history and current output remain readable', () => {
  const { MAX_TRACKED_TURNS } = require('../electron/harness/remoteItemFeed.cjs');
  const events: any[] = [];
  const feed = createItemFeed({ emit: (event: any) => events.push(event) });
  for (let index = 0; index <= MAX_TRACKED_TURNS; index++) {
    feed.push('chat', 'codex', { method: 'turn/started', params: { turn: { id: String(index), status: 'inProgress' } } });
  }
  assert.equal(events.at(-1).live, false);
  assert.equal(feed.snapshot('chat').liveTurn, null);
  assert.equal(feed.snapshot('chat').liveUnavailable, true);
  assert.equal(feed.snapshot('chat').historyChangedAt, events.at(-1).feedSeq);
  const ended = createItemFeed({ emit: (event: any) => events.push(event) });
  ended.push('chat', 'codex', { method: 'turn/completed', params: { turn: { id: 'joined-mid-turn', status: 'completed' } } });
  assert.equal(ended.snapshot('chat').liveTurn.status, 'completed');
});

test('the same native turn and item id in another session have distinct feed identities', () => {
  const events: any[] = [];
  const feed = createItemFeed({ emit: (event: any) => events.push(event) });
  const push = (origin: string, method: string, params: object) => feed.push('chat', 'codex', { method, params }, origin);
  push('first', 'turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  push('first', 'item/completed', { turnId: 'turn', item: { id: 'same', type: 'agentMessage', text: 'first' } });
  push('second', 'turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  push('second', 'item/completed', { turnId: 'turn', item: { id: 'same', type: 'agentMessage', text: 'second' } });
  push('first', 'item/completed', { turnId: 'turn', item: { id: 'same', type: 'agentMessage', text: 'late old' } });
  assert.equal(events.at(-1).live, false);
  assert.deepEqual(
    feed.snapshot('chat').liveItems.map((item: any) => item.text),
    ['second'],
  );
  assert.equal(feed.snapshot('chat').liveTurn.id, JSON.stringify(['second', 'turn']));
});

test('a direct chat notification without native identity does not claim the known live turn', async () => {
  const events: any[] = [];
  const service = { attached: true, onFeedEvent: (event: any) => events.push(event) };
  const items = openPhoneItems({ service: () => service, chatOf: () => 'chat', rows: async () => [] });
  items.live('codex', { method: 'turn/started', params: { threadId: 'native', turn: { id: 'turn', status: 'inProgress' } } });
  items.live('codex', {
    chatId: 'chat',
    method: 'item/completed',
    params: { item: { id: 'unowned', type: 'agentMessage', text: 'unowned' } },
  });
  assert.equal(events.at(-1).live, false);
  assert.deepEqual((await items.items('chat', 10)).items, []);
});
