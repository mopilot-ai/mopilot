// Live frames around a subscribe reply (electron/host/remote.cjs, #3525): a delta the Host writes after the Hello, even in the same read as the reply, reaches the windows after the subscription's catch-up, never dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { hostWorld, onlineRemote, tick } from './support/host-wire-kit.ts';
const require = createRequire(import.meta.url);
const frames = require('../shared/host/frames.mjs');

const hello = (chatId: string, rev: number, inflight: object[] = []) => ({
  event: 'frame',
  chatId,
  frame: { t: 'hello', seq: 0, rev, epoch: 0, snapshot: { rev, items: [] }, inFlightEphemeral: inflight },
});
const delta = (chatId: string, text: string) => ({
  event: 'frame',
  chatId,
  frame: { t: 'delta', seq: 1, key: 'k1', delta: { turnId: 't1', sessionUpdate: 'agent_message_chunk', text } },
});

/** A held subscribe and what the windows heard, in order. */
async function held(t: any) {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const heard: string[] = [];
  host.events.onFrame((p: any) => heard.push(`frame:${p.frame.delta?.text ?? p.frame.t}`));
  host.events.onInflight((p: any) => heard.push(`inflight:${p.inflight.length}`));
  w.net.hold.add('chat.subscribe');
  return { w, host, heard };
}

test('a delta written in the same read as the subscribe reply is not dropped: it reaches the windows after the subscribe resolves', async (t) => {
  const { w, host, heard } = await held(t);
  const sub = host.subscribe('a');
  await tick();
  const id = w.net.last.written.at(-1).id;
  w.net.last.feed(hello('a', 0, [{ key: 'k1', deltas: [], truncated: false }]));
  // the reply and the turn's first delta arrive in one chunk: the decoder hands both over before the subscribe's continuation runs
  w.net.last.feed(
    Buffer.concat([frames.encodeControl({ id, result: { subscribed: true } }), frames.encodeControl(delta('a', 'fake-host: '))]),
  );
  assert.deepEqual(heard, [], 'held until the subscription is applied');
  const res = await sub;
  assert.deepEqual(res.inflight, [{ key: 'k1', deltas: [], truncated: false }]);
  await tick();
  assert.deepEqual(heard, ['frame:fake-host: ']);
  // later deltas go straight through
  w.net.last.feed(delta('a', 'while away'));
  assert.deepEqual(heard, ['frame:fake-host: ', 'frame:while away']);
});

test('a delta between the Hello and the reply is kept; one before the Hello is in the Hello already and is not sent twice', async (t) => {
  const { w, host, heard } = await held(t);
  const sub = host.subscribe('a');
  await tick();
  const id = w.net.last.written.at(-1).id;
  w.net.last.feed(delta('a', 'before'));
  w.net.last.feed(hello('a', 0, [{ key: 'k1', deltas: [{ text: 'before' }], truncated: false }]));
  w.net.last.feed(delta('a', 'after'));
  w.net.last.feed({ event: 'frame', chatId: 'a', frame: { t: 'retract', seq: 2, key: 'k2' } });
  w.net.last.feed({ id, result: { subscribed: true } });
  await sub;
  assert.deepEqual(heard, ['frame:after', 'frame:retract']);
});

test('a catch-up hands over the unfinished text first, then the live frames that came with its reply', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const heard: string[] = [];
  host.events.onFrame((p: any) => heard.push(`frame:${p.frame.delta.text}`));
  host.events.onInflight((p: any) => heard.push(`inflight:${p.inflight[0]?.deltas.map((d: any) => d.text).join('')}`));
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 1 }, patches: [] });
  await host.subscribe('a');
  // a revision skipped starts a catch-up; its reply comes with a live delta in the same read
  w.net.hold.add('chat.subscribe');
  w.net.last.feed({ event: 'frame', chatId: 'a', frame: { t: 'durable', seq: 3, rev: 3, item: {} } });
  await tick();
  const id = w.net.last.written.at(-1).id;
  w.net.last.feed({
    event: 'frame',
    chatId: 'a',
    frame: {
      t: 'hello',
      seq: 3,
      rev: 3,
      epoch: 0,
      snapshot: null,
      inFlightEphemeral: [{ key: 'k1', deltas: [{ text: 'one ' }], truncated: false }],
    },
  });
  w.net.last.feed(Buffer.concat([frames.encodeControl({ id, result: { subscribed: true } }), frames.encodeControl(delta('a', 'two'))]));
  await tick();
  await tick();
  assert.deepEqual(heard, ['inflight:one ', 'frame:two']);
});

test('a subscribe that fails hands over no live frames it held', async (t) => {
  const { w, host, heard } = await held(t);
  const sub = host.subscribe('a');
  await tick();
  const id = w.net.last.written.at(-1).id;
  w.net.last.feed(hello('a', 0));
  w.net.last.feed(delta('a', 'lost with the subscribe'));
  w.net.last.feed({ id, error: { code: 'host_error', message: 'no' } });
  await assert.rejects(sub);
  assert.deepEqual(heard, []);
});

test('two subscribes of one chat serialize their entire baseline transaction', async (t) => {
  const { w, host } = await held(t);
  const first = host.subscribe('a');
  await tick();
  const second = host.subscribe('a');
  await tick();
  assert.equal(w.net.last.written.filter((m: any) => m.method === 'chat.subscribe').length, 1);
  const id1 = w.net.last.written.at(-1).id;
  w.net.last.feed(hello('a', 0));
  w.net.last.feed({ id: id1, result: { subscribed: true } });
  assert.equal((await first).snapshot.rev, 0, 'the first Hello went to the first subscribe');
  await tick();
  const id2 = w.net.last.written.at(-1).id;
  w.net.last.feed(hello('a', 0));
  w.net.last.feed({ id: id2, result: { subscribed: true } });
  assert.equal((await second).snapshot.rev, 0, 'its Hello was collected, not dropped');
});

test('a subscribe that settles after its connection let go of every collector closes nothing else', () => {
  const { createCollecting } = require('../electron/host/remoteSubscribe.cjs');
  const c = createCollecting();
  const got = c.open('a');
  c.clear();
  c.close('a', got);
  assert.equal(c.has('a'), false);
  assert.equal(c.take('a', { t: 'delta' }), false);
});
