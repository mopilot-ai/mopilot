// Flushes that name a chat, and joined sends (electron/harness/coreBatcher.cjs, electron/bridge/spec.cjs): a broadcast or a
// window's request flushes only the chat it names, one flush is one `batch` call, and a stream batch unpacks in order.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { CoreBatcher, orderedReplies, namedChats, BACKGROUND_MS } = require('../electron/harness/coreBatcher.cjs');
const { unpackStreamBatches, STREAM_BATCH } = require('../electron/bridge/spec.cjs');

mock.timers.enable({ apis: ['setTimeout'] });

/** the remote item feed's delta (core/crates/batcher `feed`): one key for every delta of a chat */
const text = (chat: string, t: string) => ({ ev: 'items.delta', chatId: chat, turnId: 't', itemId: 'i', field: 'text', index: 0, text: t });

function make(o: any = {}) {
  const sent: any[] = [];
  const batches: number[] = [];
  let depth = 0;
  const b = new CoreBatcher({
    send: (_f: string, e: any) => (sent.push(e), true),
    batch: (fn: () => void) => {
      depth++;
      const before = sent.length;
      try {
        fn();
      } finally {
        depth--;
        if (depth === 0) batches.push(sent.length - before);
      }
    },
    ...o,
  });
  b.register('feed', (e: any) => e.chatId);
  return { b, sent, batches };
}

/** a chat's first delta leads out; the next two wait for the tick */
function pend(b: any, chat: string) {
  b.push('feed', text(chat, 'lead'));
  b.push('feed', text(chat, 'a'));
  b.push('feed', text(chat, 'b'));
}

test('namedChats reads strings, known properties of objects and of their params, and ignores the rest', () => {
  assert.deepEqual(namedChats(['c1', { sessionId: 's1', params: { threadId: 't1' } }, { key: 7, id: '' }, null, 3, 'x'.repeat(300)]), [
    'c1',
    's1',
    't1',
  ]);
  assert.deepEqual(
    namedChats([
      { chatId: 'a', params: 4 },
      { chat: 'a', key: 'k' },
    ]),
    ['a', 'k'],
  );
  assert.deepEqual(namedChats([]), []);
  assert.deepEqual(namedChats(['threadTurns', ['t9', { chatId: 'c9' }, 5]]), ['threadTurns', 't9', 'c9'], 'a list of arguments');
});

test("a flush by name sends that chat's pending deltas, in order, and leaves other chats on the tick", () => {
  const { b, sent } = make();
  pend(b, 'c1');
  pend(b, 'c2');
  sent.length = 0;
  b.flushNamed(['c1']);
  assert.deepEqual(sent, [text('c1', 'ab')]);
  b.flushNamed(['c1', 'nobody']);
  assert.equal(sent.length, 1, 'nothing pending for c1 now; an unknown name flushes nothing');
  mock.timers.tick(BACKGROUND_MS);
  assert.deepEqual(sent, [text('c1', 'ab'), text('c2', 'leadab')], "c2's first delta waited too: c1's tick was running");
  b.cancel();
});

test('a name that is a session key flushes the chat it resolves to, and a resolver that throws flushes the name itself', () => {
  const { b, sent } = make({ resolve: (k: string) => (k === 'boom' ? assert.fail('x') : k === 'key1' ? 'c1' : k) });
  pend(b, 'c1');
  pend(b, 'boom');
  sent.length = 0;
  b.flushNamed(['key1']);
  assert.deepEqual(sent, [text('c1', 'ab')]);
  b.flushNamed(['boom']);
  assert.deepEqual(sent, [text('c1', 'ab'), text('boom', 'leadab')], 'the throw is noted and the name flushed as itself');
  b.cancel();
});

test('an ordered request flushes the chats its arguments name before it answers; one that names none flushes nothing', async () => {
  const { b, sent } = make();
  pend(b, 'c1');
  pend(b, 'c2');
  sent.length = 0;
  assert.equal(await b.ordered(async () => 'answer', [{}, 'c2']), 'answer');
  assert.deepEqual(sent, [text('c2', 'leadab')]);
  await b.ordered(() => 1, []);
  await b.ordered(() => 2, [{}]);
  assert.equal(sent.length, 1);
  await b.ordered(() => 3);
  assert.deepEqual(sent.at(-1), text('c1', 'ab'), 'a caller that names nothing at all gets every chat flushed');
  await assert.rejects(b.ordered(async () => assert.fail('failed'), ['c1']));
  assert.deepEqual(sent.at(-1), text('c1', 'ab'), 'a failed request still flushes first');
  b.cancel();
});

test('orderedReplies hands the handler its arguments to the batcher', async () => {
  const seen: unknown[][] = [];
  const handlers = new Map<string, (...a: any[]) => any>();
  const ipc: any = {
    handle: (c: string, f: any) => handlers.set(c, f),
    on: function () {
      return this === ipc;
    },
  };
  const wrapped = orderedReplies(ipc, async (fn: () => unknown, args: unknown[]) => (seen.push(args), fn()));
  wrapped.handle('claude:turns', (_e: unknown, id: string) => `turns ${id}`);
  wrapped.handle('other:thing', (x: string) => x);
  assert.equal(await handlers.get('claude:turns')!({}, 'c9'), 'turns c9');
  assert.deepEqual(seen, [[{}, 'c9']]);
  assert.equal(handlers.get('other:thing')!('plain'), 'plain', 'a channel outside the families is not wrapped');
  assert.equal(wrapped.on(), true, 'other members stay bound to ipcMain');
});

test('a flush, a tick and the background tick each make their sends inside one batch', () => {
  const { b, sent, batches } = make({ hasBackground: () => true });
  b.push('feed', text('c1', 'lead'));
  assert.deepEqual(batches, [2], 'the leading edge: its foreground and background copies leave together');
  b.push('feed', text('c1', 'a'));
  b.push('feed', text('c2', 'x'));
  b.push('feed', text('c2', 'y'));
  batches.length = 0;
  mock.timers.tick(BACKGROUND_MS);
  assert.equal(batches.length >= 2, true, 'the frame tick and the background tick');
  assert.equal(sent.length > 0, true);
  b.cancel();
});

test("the preload unpacks a stream batch to each channel's listeners in order, and drops one of the wrong shape", () => {
  const ipc = new EventEmitter();
  unpackStreamBatches(ipc);
  const heard: string[] = [];
  ipc.on('claude:event', (_e, ev) => heard.push(`claude ${ev}`));
  ipc.on('codex:item', (_e, ev) => heard.push(`codex ${ev}`));
  ipc.emit(STREAM_BATCH, {}, [
    ['claude:event', 1],
    ['codex:item', 2],
    ['claude:event', 3],
  ]);
  ipc.emit(STREAM_BATCH, {}, 'junk');
  assert.deepEqual(heard, ['claude 1', 'codex 2', 'claude 3']);
});

test('the background tick passes over a chat that has nothing for the slow lane', () => {
  const { b, sent } = make({ hasBackground: (chat: string) => chat === 'bg', watched: () => false });
  // the slow lane's timer is set first, so it fires before the tick that would empty the other chat's queue
  b.push('feed', text('bg', 'lead'));
  b.push('feed', text('plain', 'a'));
  b.push('feed', text('bg', 'b'));
  sent.length = 0;
  mock.timers.tick(BACKGROUND_MS);
  assert.equal(
    sent.some((e: any) => e.chatId === 'bg'),
    true,
  );
  b.cancel();
});
