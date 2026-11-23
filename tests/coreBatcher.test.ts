// The batcher's JS side (electron/harness/coreBatcher.cjs) around the core's queues (core/crates/batcher): what crosses,
// what the JS holds, and what it does when the core or an event fails it.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CoreBatcher, familyChats, WATCHED_MS, BACKGROUND_MS } = require('../electron/harness/coreBatcher.cjs');
const { core } = require('../electron/platform/core.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

mock.timers.enable({ apis: ['setTimeout'] });

let sent: { family: string; event: any; scope: any; envelope: any }[] = [];
const made: any[] = [];
beforeEach(() => {
  for (const b of made.splice(0)) b.cancel();
  sent = [];
});

/** The real core, with `fail(route, payload)` deciding which calls throw or answer otherwise. */
function addon(fail: (route: string, payload: Buffer) => Buffer | Error | undefined = () => undefined) {
  const real = core();
  const calls: string[] = [];
  return {
    calls,
    dispatchSync(route: string, payload: Buffer) {
      calls.push(route);
      const odd = fail(route, payload);
      if (odd instanceof Error) throw odd;
      return odd ?? real.dispatchSync(route, payload);
    },
  };
}

function make(o: any = {}) {
  const b = new CoreBatcher({
    send: (family: string, event: any, _target: any, scope: any, envelope: any) => (sent.push({ family, event, scope, envelope }), true),
    ...o,
  });
  for (const [family, chatOf] of Object.entries(familyChats({ chatOf: (key: string) => key }))) b.register(family, chatOf);
  made.push(b);
  return b;
}

const delta = (chat: string, text: string) => ({
  kind: 'notification',
  chatId: chat,
  method: 'item/agentMessage/delta',
  params: { threadId: chat, turnId: 't', itemId: 'm', delta: text },
});
const texts = () => sent.map((s) => s.event.params?.delta ?? s.event.kind);

test('there is no batcher without the core', () => {
  assert.throws(() => new CoreBatcher({ send: () => true, addon: null }), { message: 'The Rust core is missing.' });
});

test('a core older than the JS says so once, where the batcher is made, rather than starting over at every call', () => {
  // a core from before Stage 4.4 replies with the list alone, no line after it
  const old = addon((route) => (route === 'batcher.cancel' ? Buffer.from('[0,0,0]') : undefined));
  assert.throws(() => new CoreBatcher({ send: () => true, addon: old }), /older than this app's JS/);
  assert.deepEqual(old.calls, ['batcher.families', 'batcher.open', 'batcher.cancel'], 'one check, and no call after it');
});

test('only an event a delta gate admits crosses as JSON, and the window gets its own object back when nothing joined it', () => {
  const fake = addon();
  const b = make({ addon: fake });
  const lead = delta('c', 'a');
  b.push('codex', lead);
  assert.equal(sent[0].event, lead, 'the leading edge sends the adapter object');
  const big = { kind: 'turnCompleted', chatId: 'c', toJSON: () => assert.fail('never serialized') };
  b.push('codex', delta('c', 'b'));
  b.push('codex', big);
  assert.equal(sent[2].event, big);
  assert.deepEqual(texts(), ['a', 'b', 'turnCompleted']);
  assert.equal(b.held.size, 0, 'nothing held once sent');
  // a chat with nothing pending needs no call to flush it
  fake.calls.length = 0;
  b.flushNamed(['c', null]);
  b.flushChat(null);
  b.flushAll();
  b.drop('c');
  assert.deepEqual(fake.calls, []);
});

test('an event whose JSON is nothing, or whose key the core cannot read, goes out alone after every chat', () => {
  const b = make({ hostOf: (chat: string | null) => (chat ? 'hostA' : 'local') });
  b.push('codex', delta('a', 'lead'));
  b.push('codex', delta('a', 'x'));
  b.push('codex', { ...delta('b', 'y'), toJSON: () => undefined });
  assert.deepEqual(texts(), ['lead', 'x', 'y']);
  assert.equal(sent[2].envelope.hostId, 'local');
  b.push('codex', delta('a', 'z'));
  // String() of an object whose own toString is no function throws in JS: the core says so
  const odd = {
    kind: 'message',
    key: 'k',
    account: { toString: 1 },
    msg: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'q' } } },
  };
  assert.equal(b.push('claude', odd), true);
  assert.deepEqual(texts(), ['lead', 'x', 'y', 'z', 'message']);
  assert.equal(sent[4].envelope.hostId, 'local');
  assert.ok(recentIgnored().some((n: any) => /read a claude stream event's chat and key/.test(n.context)));
});

test('a core that fails a call is noted, starts over with nothing pending, and the event goes out at once', () => {
  let failing = '';
  const b = make({ addon: addon((route) => (route === failing ? new Error('broken') : undefined)) });
  b.push('codex', delta('c', 'lead'));
  b.push('codex', delta('c', 'lost'));
  failing = 'batcher.push';
  assert.equal(b.push('codex', delta('c', 'now')), true);
  assert.deepEqual(texts(), ['lead', 'now'], 'what the failed core held is gone');
  assert.equal(b.pending, 0);
  assert.equal(b.timer, null, 'its ticks went with it');
  failing = '';
  b.push('codex', delta('c', 'after'));
  assert.deepEqual(texts(), ['lead', 'now', 'after'], 'the next delta leads a new batcher');
  b.push('codex', delta('c', 'tick'));
  failing = 'batcher.tick';
  mock.timers.tick(WATCHED_MS);
  assert.equal(b.timer, null);
  failing = '';
  // a background tick, a flush and a drop the core fails are noted too, and nothing is sent for them
  for (const route of ['batcher.backgroundTick', 'batcher.flush', 'batcher.flushAll', 'batcher.drop']) {
    const before = sent.length;
    const bg = make({ hasBackground: () => true, addon: addon((r) => (r === route ? new Error('broken') : undefined)) });
    bg.push('codex', delta('d', 'lead'));
    bg.push('codex', delta('d', 'held'));
    if (route === 'batcher.backgroundTick') mock.timers.tick(BACKGROUND_MS);
    if (route === 'batcher.flush') bg.flushChat('d');
    if (route === 'batcher.flushAll') bg.flushAll();
    if (route === 'batcher.drop') bg.drop('d');
    assert.equal(bg.held.size, 0, route);
    assert.ok(sent.length >= before + 2, route);
  }
  assert.ok(recentIgnored().some((n: any) => /batch stream events in the core \(batcher.push\)/.test(n.context)));
  // closing the broken one fails too: noted, and the new one opens
  const closing = make({ addon: addon((r) => (r === 'batcher.push' || r === 'batcher.close' ? new Error('broken') : undefined)) });
  closing.push('codex', delta('e', 'x'));
  assert.ok(recentIgnored().some((n: any) => /close a stream batcher in the core/.test(n.context)));
});

test('an entry the core names that the JS never gave it is noted, and the rest still go out', () => {
  const b = make({
    addon: addon((route) => (route === 'batcher.flushAll' ? Buffer.from('[0,0,0,"c",[999,0,0,2,0,0]]\n') : undefined)),
  });
  b.push('codex', delta('c', 'lead'));
  b.push('codex', delta('c', 'x'));
  b.flushAll();
  assert.deepEqual(texts(), ['lead', 'x']);
  assert.ok(recentIgnored().some((n: any) => /the core flushed event 999/.test(n.message)));
});

test('a dropped chat lets go of what the JS held for it, and a cancelled batcher ticks no more', () => {
  const b = make({ hasBackground: () => true });
  b.push('acp', { kind: 'update', key: 'k', turnId: 't', update: { sessionUpdate: 'tool_call', toolCallId: '1' } });
  b.push('acp', { kind: 'update', key: 'k', turnId: 't', update: { sessionUpdate: 'tool_call', toolCallId: '2' } });
  b.push('codex', delta('other', 'x'));
  assert.equal(b.held.size, 2, 'a waiting update in both lanes, and a delta');
  b.drop('k');
  assert.equal(b.held.size, 1);
  b.cancel();
  mock.timers.tick(BACKGROUND_MS * 2);
  assert.equal(sent.length, 2, 'the two leading edges only: no tick ran');
  b.flushAll();
  assert.deepEqual(
    sent.slice(2).map((s) => [s.event.params.delta, s.scope.background]),
    [
      ['x', false],
      ['x', true],
    ],
  );
});

test("a delta keeps the JSON it crossed as, a joined one the core's, for the windows' stream batch", () => {
  const { knownJson } = require('../electron/harness/eventJson.cjs');
  const b = make();
  const lead = delta('c', 'lead');
  b.push('codex', lead);
  b.push('codex', delta('c', 'a\ud800'));
  b.push('codex', delta('c', '\udc00b'));
  mock.timers.tick(WATCHED_MS);
  assert.equal(knownJson(lead), JSON.stringify(lead));
  assert.equal(sent[1].event.params.delta, 'a𐀀b', 'the halves of a pair join into it');
  assert.equal(knownJson(sent[1].event), JSON.stringify(sent[1].event));
  const status = { kind: 'turnStarted', chatId: 'c' };
  b.push('codex', status);
  assert.equal(knownJson(status), undefined, 'an event no gate admits is never serialized');
});

test('a core that fails a call made from inside a send loses none of what the tick already handed out', () => {
  let failing = '';
  let b: any;
  b = make({
    addon: addon((route) => (route === failing ? new Error('broken') : undefined)),
    send: (family: string, event: any, _t: any, scope: any) => {
      sent.push({ family, event, scope, envelope: undefined });
      // the adapter emits again while the window takes "one", and the core fails that push
      if (event.params?.delta === 'one') {
        failing = 'batcher.push';
        b.push('codex', delta('c', 'reentrant'));
        failing = '';
      }
      return true;
    },
  });
  b.push('codex', delta('lead', 'x'));
  b.push('codex', delta('a', 'one'));
  b.push('codex', delta('b', 'two'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(texts(), ['x', 'one', 'reentrant', 'two']);
});

test('a restart the core refuses to open sends events unbatched, and batching comes back once it opens', () => {
  let failing = new Set<string>();
  const fake = addon((route) => (failing.has(route) ? new Error('too many stream batchers open') : undefined));
  const b = make({ addon: fake });
  b.push('codex', delta('c', 'lead'));
  failing = new Set(['batcher.push', 'batcher.open']);
  assert.equal(b.push('codex', delta('c', 'a')), true, 'sent at once, not thrown to the adapter');
  failing = new Set(['batcher.open']);
  assert.equal(b.push('codex', delta('c', 'b')), true);
  b.flushAll();
  b.cancel();
  assert.deepEqual(texts(), ['lead', 'a', 'b']);
  assert.ok(recentIgnored().some((n: any) => /open a stream batcher in the core/.test(n.context)));
  failing = new Set();
  b.push('codex', delta('c', 'c'));
  b.push('codex', delta('c', 'd'));
  assert.deepEqual(texts(), ['lead', 'a', 'b', 'c'], 'the next delta leads a batcher opened again; the one after waits');
});

test('a chat id String() throws on sends its event alone, after every chat', () => {
  const b = new CoreBatcher({
    send: (family: string, event: any, _t: any, scope: any, envelope: any) => (sent.push({ family, event, scope, envelope }), true),
  });
  made.push(b);
  b.register('codex', (e: any) => e.chatId);
  b.push('codex', delta('c', 'lead'));
  b.push('codex', delta('c', 'pending'));
  const odd = { ...delta('x', 'odd'), chatId: Object.create(null) };
  assert.equal(b.push('codex', odd), true);
  assert.deepEqual(texts(), ['lead', 'pending', 'odd']);
});

test('a resolver that names nothing flushes only the name', () => {
  const b = make({ resolve: () => null });
  b.push('codex', delta('c', 'lead'));
  b.push('codex', delta('c', 'x'));
  b.flushNamed(['c']);
  assert.deepEqual(texts(), ['lead', 'x']);
});

test('a chat id of any characters comes back from the core as it went in, and keeps its own queue', () => {
  const odd = 'a\n"b"\\ \ud800';
  const b = make();
  b.push('codex', delta(odd, 'lead'));
  b.push('codex', delta(odd, 'x'));
  b.push('codex', delta('a', 'y'));
  b.push('codex', delta(odd, 'z'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(
    sent.map((s) => [s.event.chatId, s.event.params.delta, s.scope?.chat]),
    [
      [odd, 'lead', odd],
      [odd, 'xz', odd],
      ['a', 'y', 'a'],
    ],
  );
});

test('a delta pushed while a tick sends waits for the next tick instead of leading out ahead of the rest', () => {
  let again = true;
  const b = make({
    send: (family: string, event: any, _t: any, scope: any) => {
      sent.push({ family, event, scope, envelope: undefined });
      // a send that makes the adapter emit again (a listener on the window's side of main)
      if (again && event.params?.delta === 'ab') {
        again = false;
        b.push('codex', delta('c', 'reentrant'));
      }
      return true;
    },
  });
  b.push('codex', delta('c', 'lead'));
  b.push('codex', delta('c', 'a'));
  b.push('codex', delta('c', 'b'));
  b.push('codex', delta('d', 'other'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(texts(), ['lead', 'ab', 'other']);
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(texts(), ['lead', 'ab', 'other', 'reentrant']);
});
