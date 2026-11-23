// The stream batcher's leading edge (electron/harness/coreBatcher.cjs): the first delta after a quiet spell goes out
// at once and starts the tick that paces the deltas behind it; the rest of the batcher is in streamBatcher.test.ts.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CoreBatcher, WATCHED_MS } = require('../electron/harness/coreBatcher.cjs');
const { familyChats } = require('../electron/harness/coreBatcher.cjs');

mock.timers.enable({ apis: ['setTimeout'] });

let sent: [string, any, any][] = [];
const made: any[] = [];
const make = (o: any = {}) => {
  const b = new CoreBatcher({
    send: (family: string, event: any, target: any) => (sent.push([family, event, target]), true),
    ...o,
  });
  for (const [family, c] of Object.entries(familyChats({ chatOf: (key: string) => key }))) b.register(family, c);
  made.push(b);
  return b;
};
beforeEach(() => {
  for (const b of made.splice(0)) b.cancel();
  sent = [];
});

const codex = (chat: string, itemId: string, delta: string, method = 'item/agentMessage/delta') => ({
  kind: 'notification',
  chatId: chat,
  method,
  params: { threadId: chat, turnId: 'turn-1', itemId, delta },
});
const acp = (key: string, text: string) => ({
  kind: 'update',
  key,
  turnId: 'turn-1',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});
/** each send as family:kind:text */
const shape = () =>
  sent.map(([family, e]) => `${family}:${e.kind}:${family === 'codex' ? (e.params?.delta ?? '') : (e.update?.content?.text ?? '')}`);

test('the leading edge: a delta after a pause goes out at once; a steady stream is sent once per tick', () => {
  const b = make();
  b.push('codex', codex('c', 'm', 'a'));
  assert.deepEqual(shape(), ['codex:notification:a'], 'the first delta waits for no tick');
  // the tick it started holds the deltas behind it
  b.push('codex', codex('c', 'm', 'b'));
  b.push('codex', codex('c', 'm', 'c'));
  assert.equal(sent.length, 1);
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape(), ['codex:notification:a', 'codex:notification:bc']);
  // a tick that sent something is followed by another: a steady stream stays at one send per frame
  b.push('codex', codex('c', 'm', 'd'));
  assert.equal(sent.length, 2);
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape().at(-1), 'codex:notification:d');
  // a tick that sent nothing ends the cooldown: the next delta is a first delta again
  mock.timers.tick(WATCHED_MS);
  b.push('codex', codex('c', 'm', 'e'));
  assert.deepEqual(shape().at(-1), 'codex:notification:e');
  assert.equal(sent.length, 4);
});

test('the leading edge keeps each chat in order, across chats and with other events', () => {
  const b = make();
  // chat 1 opens the tick; chat 2's first delta waits behind it, and sends with it
  b.push('codex', codex('one', 'm', '1a'));
  b.push('codex', codex('two', 'm', '2a'));
  b.push('codex', codex('one', 'm', '1b'));
  assert.deepEqual(shape(), ['codex:notification:1a']);
  // another event of chat two sends its pending delta first, and does not end the cooldown for the rest
  b.push('codex', { kind: 'turnCompleted', chatId: 'two' });
  assert.deepEqual(shape(), ['codex:notification:1a', 'codex:notification:2a', 'codex:turnCompleted:']);
  b.push('codex', codex('two', 'm', '2b'));
  assert.equal(sent.length, 3, 'chat two is still inside the tick chat one started');
  mock.timers.tick(WATCHED_MS);
  // order across chats is not promised: only that both go out, in the one tick
  assert.deepEqual(shape().slice(3).sort(), ['codex:notification:1b', 'codex:notification:2b']);
});

test('the leading edge: a flush from outside keeps the tick, and the bound still sends at once', () => {
  const b = make({ maxPending: 10 });
  b.push('acp', acp('k', '12345'));
  assert.equal(sent.length, 1);
  // a window closing or a reply flushes what is pending but the tick runs on: the next delta waits behind it
  b.push('acp', acp('k', 'abc'));
  b.flushAll();
  assert.equal(shape().at(-1), 'acp:update:abc');
  b.push('acp', acp('k', 'def'));
  assert.equal(sent.length, 2, 'no second leading edge after a flush');
  mock.timers.tick(WATCHED_MS);
  assert.equal(shape().at(-1), 'acp:update:def');
  // inside the tick, text past the bound goes out at once and leaves the tick running
  b.push('acp', acp('k', '123456'));
  b.push('acp', acp('k', '7890'));
  assert.equal(shape().at(-1), 'acp:update:1234567890');
  b.push('acp', acp('k', 'z'));
  assert.equal(sent.length, 4);
  mock.timers.tick(WATCHED_MS);
  assert.equal(shape().at(-1), 'acp:update:z');
});

test('a delta past the bound with no tick running starts the tick: the next delta waits behind it', () => {
  const b = make({ maxPending: 10 });
  b.push('acp', acp('k', '1234567890'));
  assert.equal(sent.length, 1);
  b.push('acp', acp('k', 'a'));
  b.push('acp', acp('k', 'b'));
  assert.equal(sent.length, 1, 'not a second leading edge right behind the large one');
  mock.timers.tick(WATCHED_MS);
  assert.equal(shape().at(-1), 'acp:update:ab');
});

test('a send that throws on the leading edge still starts the tick', () => {
  let fail = true;
  const b = make({
    send: (family: string, event: any, target: any) => {
      if (fail) throw new Error('window gone');
      sent.push([family, event, target]);
      return true;
    },
  });
  b.push('codex', codex('c', 'm', 'lost'));
  fail = false;
  b.push('codex', codex('c', 'm', 'a'));
  b.push('codex', codex('c', 'm', 'b'));
  assert.equal(sent.length, 0, 'the delta behind the failed one waits for the tick');
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape(), ['codex:notification:ab']);
});
