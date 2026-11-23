// The Claude translator as main calls it (electron/harness/items/claudeTranslator.cjs, electron/platform/claudeHistory.cjs), on the real core: what it says arrives in
// order and before the call returns, its turn is mirrored, a session survives what the CLI sends, a read goes through the core
// and is let go of on every path, and every translator has something that forgets it. What it translates to is the Rust
// crate's own tests (core/crates/translate/src/claude).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ClaudeTranslator } = require('../electron/harness/items/claudeTranslator.cjs');
const { openHistory, historyPage, releaseHistory, allTurns, agentItems } = require('../electron/platform/claudeHistory.cjs');
const { ClaudeItems } = require('../electron/harness/items/claude.cjs');
const { createItemFeed } = require('../electron/harness/remoteItemFeed.cjs');
const { openPhoneItems } = require('../electron/app/chromePanelPhones.cjs');
const { core } = require('../electron/platform/core.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const prompt = (uuid: string, extra: object = {}) => ({
  type: 'user',
  uuid,
  timestamp: '2026-01-01T00:00:00Z',
  message: { content: uuid },
  ...extra,
});
const reply = (uuid: string, text = 'ok') => ({
  type: 'assistant',
  uuid,
  timestamp: '2026-01-01T00:00:01Z',
  message: { id: `m-${uuid}`, content: [{ type: 'text', text }] },
});
const translator = () => {
  const out: [string, any][] = [];
  const tr = new ClaudeTranslator('chat', '/w', (method: string, params: any) => out.push([method, params]));
  return { tr, out, methods: () => out.map(([method]) => method) };
};
/** Whether the core still holds handle `id` of a route family: a release says so, and lets it go. */
const held = (route: string, id: number) => String(core().dispatchSync(route, Buffer.from(String(id)))) === 'true';
/** Until the core threads have done what was left to them. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
const history = (messages: unknown[]) => openHistory(messages, 'chat', '/w', { key: 'session' });
const parsed = async (id: number, asked = {}) => JSON.parse(String((await historyPage(id, asked)).page));

test('what a translator says has reached its listener, in order, by the time the call returns', () => {
  const { tr, methods, out } = translator();
  tr.beginTurn('t', { id: 'u', clientId: null, content: [] });
  assert.deepEqual(methods(), ['turn/started', 'item/completed']);
  tr.onMessage({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } });
  tr.onMessage({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
  tr.onMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } });
  assert.deepEqual(methods().slice(2), ['item/started', 'item/agentMessage/delta']);
  assert.equal(out.at(-1)![1].delta, 'hi');
  tr.onMessage({ type: 'result', subtype: 'success', usage: {} });
  assert.deepEqual(methods().slice(4), ['thread/tokenUsage/updated', 'turn/completed']);
  tr.close();
});

test('its turn and whether it was interrupted are mirrored, for what main decides from them', () => {
  const { tr } = translator();
  assert.equal(tr.turnId, null);
  tr.beginTurn('t');
  assert.equal(tr.turnId, 't');
  tr.addSteer();
  tr.dropSteer();
  assert.equal(tr.turnId, 't', 'its own result is still to come');
  tr.markInterrupted();
  assert.equal(tr.interrupted, true);
  tr.endTurn('interrupted', null);
  assert.equal(tr.turnId, null);
  tr.close();
  assert.equal(tr.interrupted, false);
});

test('a folder learned late goes to the core, and one learned first goes with the opening', () => {
  const { tr, out } = translator();
  tr.beginTurn('t');
  tr.cwd = '/late';
  assert.equal(tr.cwd, '/late');
  tr.onMessage({ type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: {} }] } });
  assert.equal(out.at(-1)![1].item.cwd, '/late');
  tr.close();
  const early = translator();
  early.tr.cwd = '/first';
  early.tr.beginTurn('t');
  early.tr.onMessage({
    type: 'assistant',
    uuid: 'a',
    message: { id: 'm', content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: {} }] },
  });
  assert.equal(early.out.at(-1)![1].item.cwd, '/first');
  early.tr.close();
});

test("a sub-agent's transcript comes as bytes for the window, and not at all where nothing shows it", () => {
  const launch = {
    type: 'assistant',
    uuid: 'a',
    message: { id: 'm', content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'Dig' } }] },
  };
  const step = {
    type: 'assistant',
    uuid: 's',
    parent_tool_use_id: 'ag',
    message: { id: 'c', content: [{ type: 'text', text: 'line\none' }] },
  };
  const { tr, out } = translator();
  tr.beginTurn('t');
  tr.onMessage(launch);
  tr.onMessage(step);
  const [, said] = out.find(([method]) => method === 'agent/items') as [string, any];
  assert.ok(said.items instanceof Uint8Array);
  assert.equal(said.itemsAt, undefined);
  assert.equal(JSON.parse(String(said.items))[0].text, 'line\none');
  assert.equal(said.agentKey, 'ag');
  tr.close();
  const quiet: string[] = [];
  const phone = new ClaudeTranslator('chat', '/w', (method: string) => quiet.push(method), { children: false });
  phone.beginTurn('t');
  phone.onMessage(launch);
  phone.onMessage(step);
  assert.equal(quiet.includes('agent/items'), false);
  assert.ok(quiet.includes('item/updated') || quiet.includes('item/completed') || quiet.includes('item/started'));
  phone.close();
});

test('a session survives what it could not translate, keeping what the event said first', () => {
  clearIgnored();
  const { tr, methods } = translator();
  tr.onMessage({
    type: 'assistant',
    uuid: 'a',
    message: {
      id: 'm',
      content: [
        { type: 'text', text: 'said' },
        { type: 'tool_use', id: 't', name: 7 },
      ],
    },
  });
  assert.deepEqual(methods(), ['turn/started', 'item/completed']);
  assert.match(JSON.stringify(recentIgnored()), /a tool has no name/);
  const circular: any = {};
  circular.self = circular;
  tr.onMessage(circular);
  assert.match(JSON.stringify(recentIgnored()), /read a Claude Code event/);
  tr.onMessage(undefined);
  assert.match(JSON.stringify(recentIgnored()), /a message is missing/);
  // a call the core itself refuses goes no further than the note, and the turn it knows stays
  const id = tr.id;
  tr.id = 987654321;
  tr.endTurn('completed', null);
  tr.id = id;
  assert.match(JSON.stringify(recentIgnored()), /no Claude translator/);
  tr.endTurn('completed', null);
  assert.equal(tr.turnId, null);
  tr.close();
  clearIgnored();
});

test('a message nested as far as a transcript may hold reads live, with no envelope taking from its depth', () => {
  clearIgnored();
  const { tr, methods } = translator();
  const deep = JSON.parse(`${'{"a":'.repeat(990)}1${'}'.repeat(990)}`);
  tr.onMessage({ type: 'assistant', uuid: 'a', deep, message: { id: 'm', content: [{ type: 'text', text: 'hi' }] } });
  assert.deepEqual(methods(), ['turn/started', 'item/completed']);
  assert.equal(JSON.stringify(recentIgnored()).includes("can't be read"), false);
  tr.close();
});

test('closing lets the core let go, and a later event starts afresh', async () => {
  const { tr, out } = translator();
  tr.beginTurn('t');
  const id = tr.id;
  tr.close();
  tr.close();
  assert.equal(tr.id, null);
  assert.equal(tr.turnId, null);
  await settled();
  assert.equal(held('translate.claudeClose', id), false);
  tr.beginTurn('u');
  assert.notEqual(tr.id, id);
  assert.equal(out.at(-1)![1].turn.id, 'u');
  tr.close();
});

test('a session is dropped with its owner, when it closes, and past the bound the oldest idle one goes', async () => {
  const owner = new Map<string, string>();
  const emit = () => {};
  const items = new ClaudeItems({ chatOf: (key: string) => owner.get(key) ?? key, cwdOf: () => '/w', emit });
  const turn = (key: string) => items.onEvent({ key, kind: 'turnStarting', turnId: `t-${key}`, clientId: 'c', text: 'x' });
  turn('a');
  const first = items.entries.get('a').translator.id;
  owner.set('a', 'other');
  assert.equal(items.get('a'), undefined, 'a session with a new owner starts again');
  await settled();
  assert.equal(held('translate.claudeClose', first), false);
  turn('b');
  const closing = items.entries.get('b').translator.id;
  items.onEvent({ key: 'b', kind: 'closed' });
  await settled();
  assert.equal(items.entries.has('b'), false);
  assert.equal(held('translate.claudeClose', closing), false);
  // one turn runs on; everything idle past the bound goes, oldest first
  turn('running');
  for (let i = 0; i < 256; i++) {
    const key = `idle-${i}`;
    turn(key);
    items.onEvent({ key, kind: 'message', msg: { type: 'result', subtype: 'success' } });
  }
  assert.equal(items.entries.size, 256);
  assert.equal(items.entries.has('running'), true);
  assert.equal(items.entries.has('idle-0'), false);
  turn('idle-0');
  assert.equal(items.entries.has('idle-1'), false);
  for (const key of [...items.entries.keys()]) items.drop(key);
  items.dropIdle('none');
  await settled();
});

test('a read gives its turns a page at a time, and goes when it is released', async () => {
  const id = await history([prompt('p1'), reply('a1'), prompt('p2'), reply('a2'), prompt('p3'), reply('a3')]);
  const { page, ids, older } = await historyPage(id, { limit: 2 });
  assert.deepEqual(ids, ['h-p2', 'h-p3']);
  assert.equal(older, true);
  const body = JSON.parse(String(page));
  assert.equal(body.olderCursor, 'h-p2');
  assert.deepEqual(
    (await parsed(id, { limit: 2, before: body.olderCursor })).turns.map((t: any) => t.id),
    ['h-p1'],
  );
  assert.equal((await allTurns(id)).length, 3);
  releaseHistory(id);
  await settled();
  assert.equal(held('translate.claudeRelease', id), false);
});

test('a line the core could not take is left out and counted, without its text', async () => {
  clearIgnored();
  const notes: unknown[][] = [];
  const bad = { type: 'assistant', uuid: 'x', message: { id: 'x', content: [{ type: 'tool_use', id: 't', name: 7 }] } };
  const steps: string[] = [];
  const id = await openHistory([prompt('p1'), bad, prompt('p2')], 'chat', '/w', {
    key: 's',
    step: (run: () => unknown) => (steps.push('step'), run()),
    ignored: (...note: unknown[]) => notes.push(note),
  });
  assert.deepEqual(notes, [["read a Claude Code chat's transcript", '1 unreadable line skipped']]);
  assert.ok(steps.length >= 2);
  releaseHistory(id);
  const two = await openHistory([bad, bad], 'chat', '/w', { key: 's' });
  assert.match(JSON.stringify(recentIgnored()), /2 unreadable lines skipped/);
  releaseHistory(two);
  clearIgnored();
});

test('a long transcript goes across in batches, each a step of its own', async () => {
  const steps: number[] = [];
  const messages = Array.from({ length: 4097 }, (_, i) => prompt(`p${i}`));
  const id = await openHistory(messages, 'chat', '/w', { key: 's', step: (run: () => any) => (steps.push(1), run()) });
  assert.equal(steps.length, 4);
  assert.equal((await historyPage(id, { limit: 1 })).ids[0], 'h-p4096');
  releaseHistory(id);
});

test('reading every turn cuts even one long turn in steps, and gives what one read of it would', async () => {
  const messages: unknown[] = [prompt('p1')];
  const long = 'x'.repeat(40_000);
  for (let i = 0; i < 40; i++) messages.push(reply(`a${i}`, long));
  messages.push(prompt('p2'), reply('b'));
  const id = await history(messages);
  const whole = (await parsed(id)).turns;
  assert.deepEqual(await allTurns(id), whole);
  assert.equal(whole[0].items.length, 41);
  // a session going on between steps changes nothing of what the read holds
  const live = translator();
  const walking = allTurns(id);
  live.tr.beginTurn('t');
  assert.deepEqual(await walking, whole);
  live.tr.close();
  releaseHistory(id);
});

test('a turn left open is left open, or closed, as a reader asks', async () => {
  const running = { type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } };
  const id = await history([prompt('p1'), running]);
  assert.equal((await allTurns(id)).at(-1).status, 'completed');
  assert.equal((await allTurns(id, { open: true })).at(-1).status, 'inProgress');
  assert.deepEqual((await historyPage(id, { open: true, live: 'ct-1' })).ids, ['ct-1']);
  releaseHistory(id);
});

test('a page of a read the core no longer holds fails, for its caller to read again', async () => {
  await assert.rejects(historyPage(987654321), /no Claude history/);
});

test("a sub-agent's stored transcript comes back as its items, written on a core thread", async () => {
  const messages = [
    {
      type: 'assistant',
      uuid: 'a',
      message: { id: 'm', model: 'sonnet', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] },
    },
  ];
  const open = JSON.parse(String(await agentItems(messages, 'chat', '/w', false)));
  assert.equal(open.items[0].status, 'inProgress');
  assert.equal(open.model, 'sonnet');
  const settledRun = JSON.parse(String(await agentItems(messages, 'chat', '/w', true)));
  assert.equal(settledRun.items[0].status, 'failed');
});

test("a feed's Claude translator goes with its session, its chat or its last follower", async () => {
  const ids: number[] = [];
  const events: any[] = [];
  const feed = createItemFeed({ emit: (e: any) => events.push(e) });
  const started = (chat: string) =>
    feed.push(chat, 'claude', { kind: 'turnStarting', key: chat, turnId: `t-${chat}`, clientId: 'c', text: 'x' }, 'origin');
  const spy = (make: () => void) => {
    const open = core().dispatchSync;
    core().dispatchSync = (route: string, payload: Buffer) => {
      const reply = open.call(core(), route, payload);
      if (route === 'translate.claudeOpen') ids.push(Number(String(reply)));
      return reply;
    };
    try {
      make();
    } finally {
      core().dispatchSync = open;
    }
  };
  spy(() => started('a'));
  // its session closed
  feed.push('a', 'claude', { kind: 'closed', key: 'a' }, 'origin');
  await settled();
  assert.equal(held('translate.claudeClose', ids[0]), false);
  // a failed session's translator goes on, ready for its next turn
  spy(() => started('b'));
  feed.push('b', 'claude', { kind: 'error', key: 'b', error: 'boom' }, 'origin');
  await settled();
  assert.equal(held('translate.claudeClose', ids[1]), true);
  // its chat was deleted
  spy(() => started('c'));
  feed.forget('c');
  await settled();
  assert.equal(held('translate.claudeClose', ids[2]), false);
  // no one follows any more
  spy(() => started('d'));
  feed.closeTranslators();
  await settled();
  assert.equal(held('translate.claudeClose', ids[3]), false);
});

test('the phones let go of their translators once remote control has gone, and of a chat when it is deleted', async () => {
  let attached = true;
  const service = { attached: true, onFeedEvent: () => {} };
  Object.defineProperty(service, 'attached', { get: () => attached });
  const phones = openPhoneItems({ service: () => service, chatOf: (key: string) => key, rows: async () => [] });
  const opened: number[] = [];
  const open = core().dispatchSync;
  core().dispatchSync = (route: string, payload: Buffer) => {
    const reply = open.call(core(), route, payload);
    if (route === 'translate.claudeOpen') opened.push(Number(String(reply)));
    return reply;
  };
  try {
    const event = { kind: 'turnStarting', key: 'claude:s', turnId: 't', clientId: 'c', text: 'x' };
    phones.live('claude', event);
    assert.equal(opened.length, 1);
    attached = false;
    phones.live('claude', { ...event, key: 'claude:other' });
    await settled();
    assert.equal(held('translate.claudeClose', opened[0]), false);
    // nothing changes while no one is back
    phones.live('claude', event);
    assert.equal(opened.length, 1);
    attached = true;
    phones.live('claude', event);
    assert.equal(opened.length, 2);
    phones.forget('claude:s');
    await settled();
    assert.equal(held('translate.claudeClose', opened[1]), false);
  } finally {
    core().dispatchSync = open;
  }
});
