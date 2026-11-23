// Phone live/history reconciliation uses the real harness translators and saved-row producer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { snapshot, displayRows, update } from '../mobile/src/presentation/thread';
const require = createRequire(import.meta.url);
const { createItemFeed, originOf } = require('../electron/harness/remoteItemFeed.cjs');
const { openHistory, historyPage, releaseHistory } = require('../electron/platform/claudeHistory.cjs');
const { recentRowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const user = (uuid: string, text: string) => ({ type: 'user', uuid, message: { content: text } });
const answer = (uuid: string, text: string) => ({ type: 'assistant', uuid, message: { id: uuid, content: [{ type: 'text', text }] } });

test('real streamed Claude items reconcile with replay after prior turns and text-only steers (#4201)', async () => {
  const feed = createItemFeed({ emit: () => {} });
  const push = (raw: any) => feed.push('chat', 'claude', { key: 'claude:session', ...raw }, originOf('claude', { key: 'claude:session' }));
  push({ kind: 'turnStarting', turnId: 'ct-a', clientId: 'a', text: 'A' });
  const event = (event: any) => push({ kind: 'message', msg: { type: 'stream_event', event } });
  event({ type: 'message_start', message: { id: 't1' } });
  event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
  event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'T1' } });
  push({ kind: 'message', msg: answer('t1', 'T1') });
  push({ kind: 'steered', clientId: 'b', text: 'B' });
  push({ kind: 'message', msg: { type: 'result', subtype: 'success' } });
  push({ kind: 'message', msg: answer('t2', 'T2') });
  const held = await openHistory(
    [user('old', 'Earlier'), answer('old-reply', 'Older'), user('a', 'A'), answer('t1', 'T1'), user('b', 'B'), answer('t2', 'T2')],
    'chat',
    '/w',
    { key: 'claude:session' },
  );
  const turns = JSON.parse(String((await historyPage(held)).page)).turns;
  releaseHistory(held);
  const history = recentRowsOf(turns.map((turn: any) => ({ ...turn, sourceSession: 'claude:session' }))).rows;
  const t = snapshot({ rev: 1, feedSeq: 0, session: {}, itemsShape: 'items', history, items: feed.snapshot('chat').liveItems });
  assert.deepEqual(
    displayRows(t).map((r) => r.text),
    ['Earlier', 'Older', 'A', 'T1', 'B', 'T2'],
  );
  feed.forget('chat');
});

test('matching saved rows update in place and running tools retire on turn change', () => {
  let t = snapshot({
    rev: 1,
    feedSeq: 0,
    session: {},
    itemsShape: 'items',
    history: [
      { id: 'a', role: 'assistant', text: 'T', at: 7 },
      { id: 's', role: 'step', text: 'Run', state: 'running' },
    ],
    items: [
      { id: 'reply', rowId: 'a', type: 'agentMessage', text: 'T more' },
      { id: 'tool', rowId: 's', type: 'commandExecution', command: 'Run', status: 'completed' },
    ],
  });
  assert.equal(displayRows(t)[0].text, 'T more');
  assert.notEqual(displayRows(t)[1].state, 'running');
  t = update(t, { ev: 'turn.state', feedSeq: 1, turnId: 'next', status: 'inProgress' });
  assert.equal(t.history[0].text, 'T more');
  assert.equal(t.history[0].at, 7);
  assert.notEqual(t.history[1].state, 'running');
});

for (const family of ['codex', 'acp'] as const) {
  test(`${family}: live IDs match the real saved-row projection and stay scoped to session and turn`, () => {
    const feed = createItemFeed({ emit: () => {} });
    const native = family === 'acp' ? 'acp:agent:session' : 'session';
    const prompt = { id: 'u', clientId: null, content: [{ type: 'text', text: 'A' }] };
    let turns: any[];
    if (family === 'acp') {
      const { buildAcpTurns } = require('../electron/harness/items/acpTranslator.cjs');
      const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reply' } };
      const rows = [
        { t: 'user', turnId: 't', user: prompt },
        { t: 'update', turnId: 't', update: chunk },
        { t: 'end', turnId: 't', stopReason: 'end_turn' },
      ];
      turns = buildAcpTurns(rows, 'chat', '/w');
      for (const raw of [
        { kind: 'turnStart', turnId: 't', user: prompt },
        { kind: 'update', turnId: 't', update: chunk },
        { kind: 'turnEnd', stopReason: 'end_turn' },
      ]) {
        const event = { ...raw, key: native };
        feed.push('chat', family, event, originOf(family, event));
      }
    } else {
      // Codex's notifications already carry the native items returned by thread/read.
      const items = [
        { type: 'userMessage', ...prompt },
        { id: 'm', type: 'agentMessage', text: 'Reply' },
      ];
      turns = [{ id: 't', items }];
      const notify = (method: string, params: any) => {
        const raw = { method, params: { threadId: native, ...params } };
        feed.push('chat', family, raw, originOf(family, raw));
      };
      notify('turn/started', { turn: { id: 't', status: 'inProgress' } });
      for (const item of items) notify('item/completed', { turnId: 't', item });
    }
    const items = feed.snapshot('chat').liveItems;
    const history = recentRowsOf(turns.map((turn) => ({ ...turn, sourceSession: native }))).rows;
    const t = snapshot({ rev: 1, feedSeq: 0, session: {}, itemsShape: 'items', history, items });
    assert.deepEqual(
      displayRows(t).map((r) => r.text),
      ['A', 'Reply'],
    );
    assert.deepEqual(
      items.map((item: any) => item.rowId),
      history.map((item: any) => item.phoneId),
    );
    feed.forget('chat');
  });
}

test('a saved longer reply wins over an older live prefix; inserted live items stay before the next saved anchor', () => {
  const t = snapshot({
    rev: 1,
    feedSeq: 0,
    session: {},
    itemsShape: 'items',
    history: [{ id: 'later', role: 'assistant', text: 'Longer saved reply' }],
    items: [
      { id: 'before', rowId: 'earlier', type: 'userMessage', content: [{ type: 'text', text: 'First' }] },
      { id: 'reply', rowId: 'later', type: 'agentMessage', text: 'Longer' },
    ],
  });
  assert.deepEqual(
    displayRows(t).map((r) => r.text),
    ['First', 'Longer saved reply'],
  );
});

test('phone identity tuples distinguish sessions, reused turn IDs, kinds, and opaque delimiters', () => {
  const { phoneItemIdentity: id } = require('../shared/phoneItemIdentity.mjs');
  const item = { id: 'i', type: 'agentMessage', sourceId: 'm:0' };
  assert.notEqual(id('claude:a', 'ct-t', item), id('claude:b', 'ct-t', item));
  assert.equal(id('claude:a', 'ct-t', item), id('claude:a', 'h-other', { ...item, id: 'different' }));
  assert.notEqual(id('codex', 't', item), id('codex', 'u', item));
  assert.notEqual(id('a,b', 'c', item), id('a', 'b,c', item));
  assert.notEqual(id('claude:a', 't', item), id('claude:a', 't', { ...item, type: 'reasoning' }));
  assert.equal(id(null, 't', { id: 1 }), undefined);
  assert.equal(id(null, null, item), undefined);
});

test('streamed thinking and text use the same native block identities as transcript replay', async () => {
  const feed = createItemFeed({ emit: () => {} });
  const push = (raw: any) => feed.push('chat', 'claude', { key: 'claude:blocks', ...raw }, originOf('claude', { key: 'claude:blocks' }));
  push({ kind: 'turnStarting', turnId: 'ct-p', clientId: 'p', text: 'Prompt' });
  const stream = (event: any) => push({ kind: 'message', msg: { type: 'stream_event', event } });
  stream({ type: 'message_start', message: { id: 'm' } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Think' } });
  stream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } });
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } });
  const completed = {
    type: 'assistant',
    uuid: 'answer',
    message: {
      id: 'm',
      content: [
        { type: 'thinking', thinking: 'Think' },
        { type: 'text', text: 'Answer' },
      ],
    },
  };
  const before = feed
    .snapshot('chat')
    .liveItems.slice(1)
    .map((item: any) => item.rowId);
  push({ kind: 'message', msg: completed });
  const after = feed
    .snapshot('chat')
    .liveItems.slice(1)
    .map((item: any) => item.rowId);
  assert.deepEqual(after, before);
  const held = await openHistory([user('p', 'Prompt'), completed], 'chat', '/w', { key: 'claude:blocks' });
  try {
    const turns = JSON.parse(String((await historyPage(held)).page)).turns;
    assert.deepEqual(
      turns[0].items.slice(1).map((item: any) => item.sourceId),
      ['m:0', 'm:1'],
    );
  } finally {
    releaseHistory(held);
    feed.forget('chat');
  }
});
