// The ACP translator as main calls it (electron/harness/items/acpTranslator.cjs), on the real core: what it says arrives in
// order and before the call returns, its turn is mirrored, a session survives what an adapter sends, and handles go when their
// session does. What it translates to is the Rust crate's own tests (core/crates/translate).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AcpTranslator, buildAcpTurns } = require('../electron/harness/items/acpTranslator.cjs');
const { AcpItems, acpSender } = require('../electron/harness/items/acp.cjs');
const { createItemFeed } = require('../electron/harness/remoteItemFeed.cjs');
const { core } = require('../electron/platform/core.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const translator = () => {
  const out: [string, any][] = [];
  const tr = new AcpTranslator('chat', '/w', (method: string, params: any) => out.push([method, params]));
  return { tr, out, methods: () => out.map(([method]) => method) };
};
/** Whether the core still holds handle `id`. */
const held = (id: number) => String(core().dispatchSync('translate.close', Buffer.from(String(id)))) === 'true';

test('what a translator says has reached its listener, in order, by the time the call returns', () => {
  const { tr, methods } = translator();
  tr.beginTurn('t', { id: 'u', clientId: null, content: [] });
  assert.deepEqual(methods(), ['turn/started', 'item/completed']);
  tr.onUpdate(chunk('hello'), 't');
  assert.deepEqual(methods().slice(2), ['item/started', 'item/agentMessage/delta']);
  tr.endTurn('end_turn', null);
  assert.deepEqual(methods().slice(4), ['item/completed', 'turn/completed']);
  tr.close();
});

test('its turn is mirrored, for what main decides from it', () => {
  const { tr } = translator();
  assert.equal(tr.turnId, null);
  tr.beginTurn('t');
  assert.equal(tr.turnId, 't');
  tr.endTurn('cancelled', null);
  assert.equal(tr.turnId, null);
  // an update nothing began: main sees a turn of its own, named so
  tr.onUpdate(chunk('stray'), null);
  assert.match(tr.turnId, /^auto-[0-9a-f-]{36}-0$/);
  tr.close();
});

test('two translators of one chat never read each other: auto turns differ and state is its own', () => {
  const [a, b] = [translator(), translator()];
  a.tr.onUpdate(chunk('x'), null);
  b.tr.onUpdate(chunk('x'), null);
  assert.notEqual(a.tr.turnId, b.tr.turnId);
  a.tr.close();
  b.tr.close();
});

test('an event the core refuses costs that event, is noted, and the session goes on', () => {
  clearIgnored();
  const { tr, methods } = translator();
  tr.beginTurn('t');
  // nested past what the core reads: the payload is refused whole
  let deep: any = 1;
  for (let i = 0; i < 1500; i++) deep = [deep];
  tr.onUpdate({ ...chunk('x'), rawInput: deep }, 't');
  assert.deepEqual(methods(), ['turn/started']);
  assert.match(recentIgnored().at(-1).message, /translate\.event takes a JSON object/);
  tr.onUpdate(chunk('after'), 't');
  assert.ok(methods().includes('item/agentMessage/delta'));
  assert.equal(tr.turnId, 't');
  tr.close();
});

test('a shape JS could not read says what came before it, is noted, and the session goes on', () => {
  clearIgnored();
  const { tr, out } = translator();
  tr.beginTurn('t');
  tr.onUpdate(chunk('before'), 't');
  out.length = 0;
  tr.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c', title: { toString: 1 } }, 't');
  assert.deepEqual(
    out.map(([method, params]) => [method, params.item?.text]),
    [['item/completed', 'before']],
  );
  assert.match(recentIgnored().at(-1).message, /no string/);
  tr.endTurn('end_turn', null);
  assert.equal(out.at(-1)?.[0], 'turn/completed');
  tr.close();
});

test('a lone surrogate, a huge integer and key order survive the crossing', () => {
  const { tr, out } = translator();
  tr.beginTurn('t');
  tr.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'a\ud83d', rawInput: { z: 1, 2: 'two', a: 2 ** 70 } }, 't');
  const item = out.at(-1)?.[1].item;
  assert.equal(item.tool, 'a\ud83d');
  assert.equal(item.arguments.a, 2 ** 70);
  assert.deepEqual(Object.keys(item.arguments), ['2', 'z', 'a']);
  tr.close();
});

test('close lets the handle go; a later event starts afresh', () => {
  const { tr, methods } = translator();
  tr.close();
  tr.beginTurn('t');
  const { id } = tr;
  tr.close();
  assert.equal(tr.id, null);
  assert.equal(tr.turnId, null);
  assert.equal(held(id), false);
  tr.beginTurn('t');
  assert.notEqual(tr.id, id);
  assert.deepEqual(methods(), ['turn/started', 'turn/started']);
  tr.close();
});

test('a replay of records gives finished turns, and one still running a translator to go on with', () => {
  const records = [
    { t: 'user', turnId: 't', user: { id: 'u', clientId: null, content: [] }, at: 1000 },
    { t: 'update', turnId: 't', update: chunk('one') },
  ];
  assert.equal(buildAcpTurns(records, 'chat', '/w')[0].status, 'interrupted');
  let kept: any = null;
  const turns = buildAcpTurns(records, 'chat', '/w', { live: 't', keep: (tr: any) => (kept = tr) });
  assert.deepEqual([turns[0].status, kept.turnId], ['inProgress', 't']);
  const out: [string, any][] = [];
  kept.onUpdate(chunk(' lost, as nobody took it yet'), 't');
  kept.continueLive((method: string, params: any) => out.push([method, params]));
  kept.endTurn('end_turn', null);
  assert.equal(out.at(-1)?.[0], 'turn/completed');
  kept.close();
  assert.equal(
    buildAcpTurns(
      [
        { t: 'user', turnId: 't' },
        { t: 'end', turnId: 't', stopReason: 'end_turn' },
      ],
      'c',
      '/',
      { keep: () => assert.fail() },
    )[0].status,
    'completed',
  );
  assert.throws(() => buildAcpTurns([null], 'chat', '/w'), /null/);
});

/** A reply of AcpItems.history as a window reads it. */
const read = async (reply: Promise<{ page: Uint8Array; activeTurnId: unknown }>) => {
  const { page, activeTurnId } = await reply;
  return { ...JSON.parse(new TextDecoder().decode(page)), activeTurnId };
};

describe('a read while its session goes on', () => {
  const KEY = 'acp:kimi:s';
  const user = { id: 'u', clientId: null, content: [] };
  const started = { t: 'user', turnId: 't', user };
  const tool = (status: string) => ({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'ls', kind: 'execute', status });
  const session = (flush?: (chat: string) => void) =>
    new AcpItems({ chatOf: () => 'chat', nativeOf: () => KEY, cwdOf: () => '/w', emit: () => undefined, flush });
  /** A transcript as the read found it, which the session goes on from. */
  const found =
    (...records: any[]) =>
    async () => ({ file: '', extra: records });
  const up = (update: any) => ({ key: KEY, kind: 'update', turnId: 't', update });

  test('a turn that begins during it is running in what it returns', async () => {
    const items = session();
    const reply = read(items.history(KEY, 'chat', '/w', found()));
    items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user });
    const { turns, activeTurnId } = await reply;
    assert.deepEqual([activeTurnId, turns.map((t: any) => t.status)], ['t', ['inProgress']]);
    assert.deepEqual(
      turns[0].items.map((i: any) => i.type),
      ['userMessage'],
    );
    items.get(KEY).close();
  });

  test('a turn the transcript left open and that ended during it reads as it ended, not as cut off', async () => {
    const items = session();
    items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user });
    items.onEvent(up(tool('in_progress')));
    const reply = read(items.history(KEY, 'chat', '/w', found(started, { t: 'update', turnId: 't', update: tool('in_progress') })));
    items.onEvent(up({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' }));
    items.onEvent({ key: KEY, kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' });
    const { turns, activeTurnId } = await reply;
    assert.deepEqual([activeTurnId, turns[0].status, turns[0].items.at(-1).status], [null, 'completed', 'completed']);
    assert.equal(turns[0].items.at(-1).cutOff, undefined);
    items.get(KEY).close();
  });

  test('a turn that began after the read found it ended stays running', async () => {
    const items = session();
    const reply = read(items.history(KEY, 'chat', '/w', found(started)));
    items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user });
    assert.equal((await reply).turns[0].status, 'inProgress');
    items.get(KEY).close();
  });

  test('an item finished during it is in the turn the window replaces, with the plan', async () => {
    const items = session();
    items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user });
    const reply = read(items.history(KEY, 'chat', '/w', found(started)));
    items.onEvent(up(tool('completed')));
    items.onEvent(up({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending' }] }));
    const { turns, activeTurnId } = await reply;
    assert.equal(activeTurnId, 't');
    assert.deepEqual(
      turns[0].items.map((item: any) => item.type),
      ['userMessage', 'commandExecution'],
    );
    assert.equal(turns[0].plan.steps[0].step, 'a');
    items.get(KEY).close();
  });

  test('a card that started during it says no less than what the file held of it', async () => {
    const items = session();
    items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user });
    const done = { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'ls', kind: 'execute', status: 'completed' };
    const reply = read(items.history(KEY, 'chat', '/w', found(started, { t: 'update', turnId: 't', update: done })));
    items.onEvent(up(tool('in_progress')));
    assert.equal((await reply).turns[0].items.at(-1).status, 'completed');
    items.get(KEY).close();
  });

  test('text streamed during it is whole in the message the window goes on from', async () => {
    const items = session();
    items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user });
    items.onEvent(up(chunk('one ')));
    const reply = read(items.history(KEY, 'chat', '/w', found(started, { t: 'update', turnId: 't', update: chunk('one ') })));
    items.onEvent(up(chunk('two')));
    assert.equal((await reply).turns[0].items.at(-1).text, 'one two');
    items.get(KEY).close();
  });

  test('what the stream batcher still holds is flushed into it, in the same step', async () => {
    const items = session((chat: string) => {
      assert.equal(chat, 'chat');
      items.onEvent(up(tool('completed')));
    });
    items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user });
    const { turns } = await read(items.history(KEY, 'chat', '/w', found(started)));
    assert.equal(turns[0].items.at(-1).type, 'commandExecution');
    items.get(KEY).close();
  });

  test('a session that closes during it ends its turn in what it returns, and two reads hear alike', async () => {
    const items = session();
    items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user });
    const replies = [read(items.history(KEY, 'chat', '/w', found(started))), read(items.history(KEY, 'chat', '/w', found(started)))];
    items.onEvent({ key: KEY, kind: 'closed', error: 'gone' });
    for (const reply of replies) {
      const { turns, activeTurnId } = await reply;
      assert.deepEqual([activeTurnId, turns[0].status, turns[0].error], [null, 'failed', { message: 'gone' }]);
    }
    assert.equal(items.hearing.size, 0);
  });

  test('a read that fails hears no more', async () => {
    const items = session();
    await assert.rejects(
      items.history(KEY, 'chat', '/w', async () => Promise.reject(new Error('no disk'))),
      /no disk/,
    );
    assert.equal(items.hearing.size, 0);
  });
});

describe('pages of a history', () => {
  const KEY = 'acp:kimi:s';
  const user = { id: 'u', clientId: null, content: [] };
  const conversation = (n: number) =>
    Array.from({ length: n }, (_, i) => [
      { t: 'user', turnId: `t${i}`, user },
      { t: 'end', turnId: `t${i}`, stopReason: 'end_turn' },
    ]).flat();
  const manual = () => {
    const fired: (() => void)[] = [];
    return { fired, set: (fn: () => void) => (fired.push(fn), fired.length), clear: () => undefined };
  };
  const session = (timers = manual()) =>
    new AcpItems({ chatOf: () => 'chat', nativeOf: () => KEY, cwdOf: () => '/w', emit: () => undefined, timers });
  const source = (records: any[]) => async () => ({ file: '', extra: records });
  const ids = (page: any) => page.turns.map((t: any) => t.id);

  test('the latest come first with a cursor, and older ones come from what the read holds', async () => {
    const items = session();
    let reads = 0;
    const count = async () => (reads++, { file: '', extra: conversation(5) });
    const reply = items.history(KEY, 'chat', '/w', count, { limit: 2 });
    const latest = await read(reply);
    assert.deepEqual([ids(latest), latest.olderCursor], [['t3', 't4'], '3']);
    // a view past the reply's byte and line of ids: tests/e2e/acp-history-page-bytes.spec.ts takes one over real IPC
    assert.ok((await reply).page.byteOffset > 0);
    const older = await read(items.history(KEY, 'chat', '/w', count, { limit: 2, before: '3' }));
    assert.deepEqual([ids(older), older.olderCursor], [['t1', 't2'], '1']);
    const oldest = await read(items.history(KEY, 'chat', '/w', count, { limit: 2, before: '1' }));
    assert.deepEqual([ids(oldest), oldest.olderCursor], [['t0'], null]);
    assert.equal(reads, 1);
    items.release(KEY);
  });

  test('a page with nothing older holds nothing, and no limit is every turn', async () => {
    const items = session();
    const all = await read(items.history(KEY, 'chat', '/w', source(conversation(3))));
    assert.deepEqual([ids(all), all.olderCursor], [['t0', 't1', 't2'], null]);
    assert.equal(items.held.size, 0);
  });

  test('an older page reads the transcript again once what was held has gone', async () => {
    const timers = manual();
    const items = session(timers);
    await items.history(KEY, 'chat', '/w', source(conversation(3)), { limit: 1 });
    timers.fired[0]();
    assert.equal(items.held.size, 0);
    const older = await read(items.history(KEY, 'chat', '/w', source(conversation(3)), { limit: 1, before: '2' }));
    assert.deepEqual(ids(older), ['t1']);
    items.release(KEY);
    items.release(KEY);
  });

  test('a cursor the history no longer has pages from the end', async () => {
    const items = session();
    await items.history(KEY, 'chat', '/w', source(conversation(3)), { limit: 1 });
    assert.deepEqual(ids(await read(items.history(KEY, 'chat', '/w', source([]), { limit: 1, before: 'gone' }))), ['t2']);
    items.release(KEY);
  });

  test('only so many sessions are held at once, the oldest going first', async () => {
    const items = new AcpItems({
      chatOf: (k: string) => k,
      nativeOf: () => null,
      cwdOf: () => '/w',
      emit: () => undefined,
      timers: manual(),
    });
    for (let n = 0; n < 9; n++) await items.history(`s${n}`, 'chat', '/w', source(conversation(2)), { limit: 1 });
    assert.equal(items.held.size, 8);
    assert.equal(items.held.has('s0'), false);
    for (const key of [...items.held.keys()]) items.release(key);
  });

  test('a transcript on disk is read, a line it cannot read left out and noted, and audio records it lacks added', async () => {
    clearIgnored();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-history-'));
    const file = path.join(dir, 'chat.items.jsonl');
    const line = (record: unknown) => JSON.stringify(record);
    fs.writeFileSync(
      file,
      [
        line({ t: 'user', turnId: 'at-1', user, at: 1000 }),
        '',
        'torn {',
        '7',
        line({ t: 'end', turnId: 'at-1', stopReason: 'end_turn' }),
        '',
      ].join('\n'),
    );
    const extra = [
      { t: 'user', turnId: 'at-1', user: { id: 'again' } },
      { t: 'end', turnId: 'at-2', stopReason: 'error' },
      { t: 'end', turnId: 'at-2', stopReason: 'error' },
    ];
    const items = session();
    const { turns } = await read(items.history(KEY, 'chat', '/w', async () => ({ file, extra })));
    assert.deepEqual(
      turns.map((t: any) => [t.id, t.status, t.items.length]),
      [['at-1', 'completed', 1]],
    );
    assert.match(recentIgnored().at(-1).message, /2 unreadable lines skipped/);
    fs.writeFileSync(file, 'not a record\n');
    await items.history(KEY, 'chat', '/w', async () => ({ file, extra: [] }));
    assert.match(recentIgnored().at(-1).message, /1 unreadable line skipped/);
  });
});

test('past the sessions it keeps, the oldest idle translator goes, never one running or the one just come', () => {
  const items = new AcpItems({ chatOf: (key: string) => key, nativeOf: (chat: string) => chat, cwdOf: () => '/w', emit: () => undefined });
  const key = (n: number) => `acp:kimi:${n}`;
  items.onEvent({ key: key(0), kind: 'turnStart', turnId: 't', user: null });
  for (let n = 1; n < 256; n++) {
    items.onEvent({ key: key(n), kind: 'turnStart', turnId: 't', user: null });
    items.onEvent({ key: key(n), kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' });
  }
  const { id } = items.get(key(1));
  items.onEvent({ key: key(256), kind: 'turnStart', turnId: 't', user: null });
  assert.equal(items.entries.size, 256);
  assert.ok(items.get(key(0)), 'its turn is running');
  assert.equal(items.get(key(1)), undefined);
  assert.equal(held(id), false);
  assert.ok(items.get(key(256)));
  for (const { translator } of items.entries.values()) translator.close();
  // with every other session running, there is nothing to let go
  const busy = new AcpItems({ chatOf: (k: string) => k, nativeOf: (chat: string) => chat, cwdOf: () => '/w', emit: () => undefined });
  for (let n = 0; n <= 256; n++) busy.onEvent({ key: key(n), kind: 'turnStart', turnId: 't', user: null });
  assert.equal(busy.entries.size, 257);
  for (const { translator } of busy.entries.values()) translator.close();
});

test('a session that closes takes its handle, whoever closed it', () => {
  const KEY = 'acp:kimi:s';
  const items = new AcpItems({ chatOf: () => 'chat', nativeOf: () => KEY, cwdOf: () => '/w', emit: () => undefined });
  items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user: { id: 'u', clientId: null, content: [] } });
  const { id } = items.get(KEY);
  items.onEvent({ key: KEY, kind: 'closed', error: 'gone' });
  assert.equal(items.get(KEY), undefined);
  assert.equal(held(id), false);
  // a late end after that opens nothing
  assert.deepEqual(items.onEvent({ key: KEY, kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' }), { running: false });
  assert.equal(items.get(KEY), undefined);
});

test('a session that changes owner takes its handle too', () => {
  const KEY = 'acp:kimi:s';
  let owner = 'one';
  const items = new AcpItems({ chatOf: () => owner, nativeOf: () => KEY, cwdOf: () => '/w', emit: () => undefined });
  items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user: null });
  const { id } = items.get(KEY);
  owner = 'two';
  assert.equal(items.get(KEY), undefined);
  assert.equal(held(id), false);
});

test('following a transcript replaces the translator that began the turn, and lets it go', async () => {
  const KEY = 'acp:kimi:s';
  const items = new AcpItems({ chatOf: () => 'chat', nativeOf: () => KEY, cwdOf: () => '/w', emit: () => undefined });
  const first = { t: 'user', turnId: 't', user: { id: 'u', clientId: null, content: [] } };
  items.onEvent({ key: KEY, kind: 'turnStart', turnId: 't', user: null });
  const { id } = items.get(KEY);
  await items.followTranscript(KEY, 'chat', 't', { file: '', extra: [first] });
  assert.notEqual(items.get(KEY).id, id);
  assert.equal(held(id), false);
  items.get(KEY).close();
});

test('windows hear a translated event ahead of the event, and a malformed update reaches them anyway', () => {
  const KEY = 'acp:kimi:s';
  const sent: string[] = [];
  const windows = (channel: string, event: any) => (sent.push(`${channel}:${event.method ?? event.kind}`), true);
  const live = { controller: { chatOf: () => 'chat', nativeOf: () => KEY } };
  const { send, items } = acpSender(live, windows);
  send({ key: KEY, kind: 'turnStart', turnId: 't', user: null });
  send({ key: KEY, kind: 'update', turnId: 't', update: { sessionUpdate: 'plan', entries: 'not a list' } });
  assert.deepEqual(sent, ['acp:items:turn/started', 'acp:event:turnStart', 'acp:event:update']);
  items.get(KEY).close();
});

test("a remote client's translator goes when its session closes, and all of a chat's when the chat is forgotten", () => {
  const feed = createItemFeed({ emit: () => undefined, batcher: { timers: { setTimeout: () => 0, clearTimeout: () => undefined } } });
  const before = core().routes().length;
  feed.push('chat', 'acp', { key: 'k', kind: 'turnStart', turnId: 't', user: null });
  feed.push('chat', 'acp', { key: 'k', kind: 'closed' });
  feed.push('chat', 'acp', { key: 'k', kind: 'turnStart', turnId: 't2', user: null });
  feed.forget('chat');
  // a Claude chat's translator has no handle, and a chat never seen has nothing to let go
  feed.push('other', 'claude', { key: 'k', kind: 'turnStarting', turnId: 't', clientId: 'c', text: 'x' });
  feed.forget('other');
  feed.forget('nobody');
  assert.equal(core().routes().length, before);
});
