// A Claude Code chat's events translated once in main (electron/harness/items/claude.cjs): the notifications match what
// the shared translator makes of the same events, steers and stops land in that turn, a CLI that quits
// ends it, the translator follows the chat that owns the session, and a transcript page gets the running turn's live id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ClaudeItems, claudeSender, QUIT } = require('../electron/harness/items/claude.cjs');
const { ClaudeTranslator } = await import('./support/claude-translate.ts');
const { userInput } = require('../shared/userInput.mjs');

const KEY = 'claude:s1';
const said = (id: string, text: string) => ({
  type: 'assistant',
  uuid: `a-${id}`,
  message: { id, content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
});
const result = { type: 'result', subtype: 'success', duration_ms: 5, is_error: false, result: 'done', parent_tool_use_id: null };
const starting = { key: KEY, kind: 'turnStarting', chatId: 'chat-1', turnId: 'ct-c1', clientId: 'c1', text: 'hi', attachments: [] };

/** `value` without the clock's readings, which differ between two runs. */
const untimed = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (k, v) => (['startedAt', 'completedAt', 'durationMs'].includes(k) ? undefined : v));

/** Main's items for `events`. */
function feed(events: any[], o: { chat?: (key: string) => string } = {}) {
  const out: any[] = [];
  const items = new ClaudeItems({
    chatOf: o.chat ?? (() => 'chat-1'),
    cwdOf: () => '/w',
    emit: (chatId: string, key: string, method: string, params: any) => out.push({ chatId, key, method, params }),
  });
  for (const e of events) items.onEvent(e);
  return { out, items };
}

test('main emits what the shared translator makes of a turn', () => {
  const expected: any[] = [];
  const tr = new ClaudeTranslator('chat-1', '/w', (method: string, params: any) => expected.push({ method, params }));
  tr.beginTurn('ct-c1', { id: 'u-c1', clientId: 'c1', content: userInput('hi', []) });
  tr.onMessage(said('m1', 'Hello'));
  tr.onMessage(result);
  const { out } = feed([
    starting,
    { key: KEY, kind: 'message', msg: said('m1', 'Hello') },
    { key: KEY, kind: 'message', msg: { type: 'rate_limit_event', rate_limit_info: {} } },
    { key: KEY, kind: 'message', msg: result },
  ]);
  assert.deepEqual(untimed(out.map(({ method, params }) => ({ method, params }))), untimed(expected));
  assert.ok(out.every((x) => x.chatId === 'chat-1' && x.key === KEY));
});

test('a steer shows in the running turn, or opens one; a failed steer and a stop reach the translator', () => {
  const steer = { key: KEY, kind: 'steered', chatId: 'chat-1', clientId: 'c2', text: 'also this', attachments: [] };
  const { out, items } = feed([starting, steer]);
  const shown = out.at(-1);
  assert.equal(shown.method, 'item/completed');
  assert.deepEqual([shown.params.turnId, shown.params.item.type, shown.params.item.id], ['ct-c1', 'userMessage', 'c2']);
  items.onEvent({ key: KEY, kind: 'steerFailed', clientId: 'c2' });
  items.onEvent({ key: KEY, kind: 'interrupting' });
  assert.equal(items.get(KEY).interrupted, true);
  // with no turn open, the steer opens the turn it is shown in
  const fresh = feed([steer]);
  assert.equal(fresh.out[0].method, 'turn/started');
  assert.equal(fresh.out[0].params.turn.id, 'ct-c2');
  // events for a session with nothing translated yet change nothing
  const none = feed([{ key: KEY, kind: 'steerFailed' }, { key: KEY, kind: 'interrupting' }, { kind: 'message' }]);
  assert.deepEqual(none.out, []);
});

test('a steer racing the end of its turn: shown once, before its reply, in the turn that waits for its result', () => {
  const msg = (m: any) => ({ key: KEY, kind: 'message', msg: m });
  const { out } = feed([
    starting,
    msg(said('m1', 'first answer')),
    // main shows the steer before it goes to the CLI, so it is here before the turn's own result
    { key: KEY, kind: 'steered', chatId: 'chat-1', clientId: 'k1', text: 'also check the docs', attachments: [] },
    msg(result),
  ]);
  const ended = () => out.filter((x) => x.method === 'turn/completed');
  assert.equal(ended().length, 0, 'the steer has a result of its own still to come');
  const again = feed([
    starting,
    msg(said('m1', 'first answer')),
    { key: KEY, kind: 'steered', chatId: 'chat-1', clientId: 'k1', text: 'also check the docs', attachments: [] },
    msg(result),
    // the CLI answers the steered message as its own segment
    msg(said('m2', 'docs checked')),
    msg(result),
  ]);
  const inTurn = again.out.filter((x) => x.method === 'item/completed' && x.params.turnId === 'ct-c1').map((x) => x.params.item);
  assert.equal(inTurn.filter((i) => i.type === 'userMessage' && i.clientId === 'k1').length, 1);
  const order = inTurn.map((i) => (i.type === 'userMessage' ? i.content[0].text : i.text));
  assert.ok(order.indexOf('also check the docs') < order.lastIndexOf('docs checked'), 'the reply comes after the steered message');
  assert.deepEqual(
    again.out.filter((x) => x.method === 'turn/completed').map((x) => [x.params.turn.id, x.params.turn.status]),
    [['ct-c1', 'completed']],
  );
});

test('a steer that never reached Claude: the turn goes on until its own result, and ends if that already came', () => {
  const msg = (m: any) => ({ key: KEY, kind: 'message', msg: m });
  const steer = (clientId: string) => ({ key: KEY, kind: 'steered', chatId: 'chat-1', clientId, text: 'more', attachments: [] });
  const ended = (out: any[]) => out.filter((x) => x.method === 'turn/completed').map((x) => x.params.turn.status);
  // still waiting for the turn's own result: the turn goes on
  const waiting = feed([starting, steer('k1'), { key: KEY, kind: 'steerFailed', clientId: 'k1' }]);
  assert.deepEqual(ended(waiting.out), []);
  // its own result already came: the failed steer ends it
  const done = feed([starting, steer('k2'), msg(result)]);
  assert.deepEqual(ended(done.out), []);
  done.items.onEvent({ key: KEY, kind: 'steerFailed', clientId: 'k2' });
  assert.deepEqual(ended(done.out), ['completed']);
  // after a stop the failed steer leaves the turn to the next result
  const stopped = feed([starting, steer('k3'), { key: KEY, kind: 'interrupting' }, { key: KEY, kind: 'steerFailed', clientId: 'k3' }]);
  assert.deepEqual(ended(stopped.out), []);
});

test('a CLI that quits or fails mid-turn ends the turn, interrupted when it was being stopped; a failed start ends it too', () => {
  const quit = feed([starting, { key: KEY, kind: 'closed' }]);
  const end = quit.out.find((x) => x.method === 'turn/completed');
  assert.equal(end.params.turn.status, 'failed');
  assert.equal(end.params.turn.error.message, QUIT);
  const stopped = feed([starting, { key: KEY, kind: 'interrupting' }, { key: KEY, kind: 'error', error: 'boom' }]);
  assert.equal(stopped.out.find((x) => x.method === 'turn/completed').params.turn.status, 'interrupted');
  const failed = feed([starting, { key: KEY, kind: 'turnFailed', error: 'no' }]);
  assert.equal(failed.out.find((x) => x.method === 'turn/completed').params.turn.status, 'failed');
  // no turn running: nothing to end
  assert.deepEqual(feed([{ key: KEY, kind: 'closed' }]).out, []);
  assert.equal(quit.items.liveTurn(KEY), null);
  assert.equal(feed([starting]).items.liveTurn(KEY), 'ct-c1');
});

test("a turn names its CLI's folder, once started; a closed CLI leaves nothing behind for the next one", () => {
  const out: any[] = [];
  const items = new ClaudeItems({ chatOf: () => 'chat-1', cwdOf: () => null, emit: (...a: any[]) => out.push(a) });
  // a resumed chat: no window registered its folder, and its CLI starts after the message is shown
  items.onEvent(starting);
  assert.equal(items.get(KEY).cwd, '');
  items.onEvent({ key: KEY, kind: 'processStarted', cwd: '/repo' });
  assert.equal(items.get(KEY).cwd, '/repo');
  items.onEvent({ key: KEY, kind: 'processStarted', cwd: '/elsewhere' });
  assert.equal(items.get(KEY).cwd, '/repo', 'a translator that knows its folder keeps it');
  items.onEvent({ key: KEY, kind: 'processStarted' });
  items.onEvent({ key: KEY, kind: 'closed' });
  assert.equal(items.get(KEY), undefined);
  assert.equal(items.cwds.size, 0);
  // a CLI that starts before any turn: the turn opens in its folder
  items.onEvent({ key: KEY, kind: 'processStarted', cwd: '/next' });
  items.onEvent({ key: 'claude:other', kind: 'processStarted', cwd: '/o' });
  items.onEvent(starting);
  assert.equal(items.get(KEY).cwd, '/next');
  // an error ends the turn but keeps the session's translator: its CLI's close follows
  items.onEvent({ key: KEY, kind: 'error', error: 'boom' });
  assert.ok(items.get(KEY));
});

test('the translator follows the chat that owns the session: a new owner starts afresh', () => {
  let owner = 'chat-1';
  const { out, items } = feed([starting], { chat: () => owner });
  owner = 'chat-2';
  assert.equal(items.get(KEY), undefined);
  items.onEvent({ ...starting, turnId: 'ct-c9', clientId: 'c9' });
  assert.equal(out.at(-1).chatId, 'chat-2');
});

test("main's services: the controller maps sessions to chats and the adapter knows their folders, before either exists too", () => {
  const out: any[] = [];
  const emit = (chatId: string, key: string, method: string, params: any) => out.push({ chatId, key, method, params });
  const bare = ClaudeItems.of({}, emit);
  bare.onEvent(starting);
  assert.equal(out.at(-1).chatId, KEY, 'no controller yet: the session is its own chat');
  const live = { controller: { chatOf: () => 'chat-9' }, claudeTurns: { sessions: new Map([[KEY, { cwd: '/repo' }]]) } };
  const items = ClaudeItems.of(live, emit);
  items.onEvent(starting);
  assert.equal(out.at(-1).chatId, 'chat-9');
  assert.equal(items.get(KEY).cwd, '/repo');
  const unmapped = ClaudeItems.of({ controller: { chatOf: () => undefined }, claudeTurns: {} }, emit);
  unmapped.onEvent(starting);
  assert.equal(out.at(-1).chatId, KEY);
});

test('the sender translates every Claude event, whichever window it is for, right after passing it on', () => {
  const sent: any[] = [];
  const send = (channel: string, event: any, target?: any) => (sent.push([channel, event.kind ?? event.method, target]), true);
  const s = claudeSender({ controller: { chatOf: () => 'chat-1' } }, send);
  assert.equal(s.send(starting, 7), true);
  // the window the message came from shows it before main's turn/started names its turn
  assert.deepEqual(
    sent.map((x) => x.slice(0, 2)),
    [
      ['claude:event', 'turnStarting'],
      ['claude:items', 'turn/started'],
      ['claude:items', 'item/completed'],
    ],
  );
  assert.equal(sent[0][2], 7, 'the event still goes to its window');
  // the batcher's slow lane repeats a delta already sent (and translated) for the windows showing its chat
  sent.length = 0;
  s.send({ key: KEY, kind: 'message', msg: said('m1', 'Hi') }, undefined, { chat: 'chat-1', background: true });
  assert.deepEqual(
    sent.map((x) => x[0]),
    ['claude:event'],
  );
  assert.equal(s.pages.liveTurn(KEY), 'ct-c1');
  assert.deepEqual(s.pages.diffs(KEY, ['ct-c1']), {}, 'no snapshots yet');
  assert.deepEqual(claudeSender({}, send).pages.diffs(KEY, ['ct-c1']), {}, 'no controller yet');
  const turnSnapshots = { savedDiffs: (key: string, ids: string[]) => ({ [ids[0]]: key }) };
  const saved = claudeSender({ controller: { chatOf: () => 'chat-1', turnSnapshots } }, send);
  assert.deepEqual(saved.pages.diffs(KEY, ['ct-c1']), { 'ct-c1': KEY });
});
