// The event sink's envelope: every event to windows carries its chat's hostId, and per-chat order holds across hosts and
// for a reply that settles while deltas are pending (electron/harness/coreBatcher.cjs).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { CoreBatcher, WATCHED_MS } = require('../electron/harness/coreBatcher.cjs');

mock.timers.enable({ apis: ['setTimeout'] });
after(() => mock.timers.reset());

const HOSTS: Record<string, string> = { a1: 'hostA', a2: 'hostA', b1: 'hostB' };
/** the remote item feed's delta (core/crates/batcher `feed`), with the chat and kind this file reads */
const delta = (chat: string, text: string) => ({
  ev: 'items.delta',
  kind: 'delta',
  chat,
  chatId: chat,
  turnId: 't',
  itemId: 'i',
  field: 'text',
  index: 0,
  text,
});
const chatOf = (e: any) => e.chat ?? null;
const make = (hostOf: ((chat: string | null) => string) | null = (chat) => (chat ? HOSTS[chat] : 'local')) => {
  const out: any[] = [];
  const b = new CoreBatcher({
    send: (family: string, event: any, _t: any, _s: any, envelope: any) => (out.push({ family, ...event, hostId: envelope?.hostId }), true),
    hostOf,
  });
  b.register('feed', chatOf);
  return { b, out };
};
const view = (out: any[], chat: string) => out.filter((e) => e.chat === chat).map((e) => `${e.kind}:${e.text ?? ''}:${e.hostId}`);

test('every event carries the hostId of its chat: deltas, other events, chat-less events and unregistered families', () => {
  const { b, out } = make();
  b.push('feed', delta('a1', 'x'));
  b.push('feed', { kind: 'status', chat: 'b1', text: '' });
  b.push('feed', { kind: 'toast', text: 'hi' });
  b.push('other', { kind: 'toast', text: 'hi' });
  assert.deepEqual(
    out.map((e) => e.hostId),
    ['hostA', 'hostB', 'local', 'local'],
  );
});

test('without a hostOf events go out untouched', () => {
  const { b, out } = make(null);
  b.push('feed', { kind: 'status', chat: 'a1', text: '' });
  assert.equal(out[0].hostId, undefined);
});

test("the hostId travels beside the event: the event a window gets is the adapter's own object", () => {
  const sent: any[] = [];
  const b = new CoreBatcher({ send: (...a: any[]) => (sent.push(a), true), hostOf: () => 'hostA' });
  b.register('feed', chatOf);
  const event = { kind: 'status', chat: 'a1', text: '' };
  b.push('feed', event);
  assert.equal(sent[0][1], event);
  assert.equal('hostId' in event, false);
  assert.deepEqual(sent[0][4], { hostId: 'hostA' });
});

test('a Host lookup that throws leaves the event on the local Host; a malformed event too', () => {
  const { b, out } = make(() => {
    throw new Error('no table');
  });
  b.push('feed', { kind: 'status', chat: 'a1', text: '' });
  assert.equal(out[0].hostId, 'local');
  const bad = make();
  bad.b.register('codex', () => {
    throw new Error('bad');
  });
  bad.b.push('codex', { kind: 'status' });
  assert.equal(bad.out[0].hostId, 'local');
});

test('order is kept per chat across two chats on two hosts, and a joined run keeps its hostId', () => {
  const { b, out } = make();
  b.push('feed', delta('a1', 'p')); // leading edge: out at once, starts the tick
  b.push('feed', delta('b1', 'q'));
  b.push('feed', delta('a1', '1'));
  b.push('feed', delta('b1', '2'));
  b.push('feed', delta('a1', '3'));
  b.push('feed', { kind: 'status', chat: 'a1', text: 'done' });
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(view(out, 'a1'), ['delta:p:hostA', 'delta:13:hostA', 'status:done:hostA']);
  assert.deepEqual(view(out, 'b1'), ['delta:q2:hostB']);
});

test('A1: a reply and a later event settle in both orders; the reply never overtakes pending deltas of its host', async () => {
  for (const slowFirst of [true, false]) {
    const { b, out } = make();
    b.push('feed', delta('a1', 'p'));
    b.push('feed', delta('a1', '1'));
    let release: (v: string) => void = () => {};
    const slow = b.ordered(() => new Promise<string>((r) => (release = r)));
    const fast = b.ordered(() => 'fast');
    if (slowFirst) {
      assert.equal(await fast, 'fast');
      b.push('feed', delta('a2', 'z'));
      release('slow');
    } else {
      release('slow');
      assert.equal(await slow, 'slow');
      assert.equal(await fast, 'fast');
    }
    assert.equal(await slow, 'slow');
    // by the time any reply settled, deltas pushed before it had gone out, in order
    assert.deepEqual(view(out, 'a1').slice(0, 2), ['delta:p:hostA', 'delta:1:hostA']);
  }
});

test('ordered flushes before a failure too', async () => {
  const { b, out } = make();
  b.push('feed', delta('a1', 'p'));
  b.push('feed', delta('a1', '1'));
  await assert.rejects(
    b.ordered(() => Promise.reject(new Error('no'))),
    /no/,
  );
  assert.equal(out.length, 2);
});
