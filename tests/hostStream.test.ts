// The Host session stream (host/src/stream.mjs, shared/host/stream.mjs): Hello then frames, durable-only replay on reconnect, a terminal delta promoted to a durable, one shared seq, and the bounded queue that closes with overflow (B1-B3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createStreamHub } from '../host/src/stream.mjs';
// @ts-ignore
import { parseFrame, StreamFrameError, MAX_QUEUE, MAX_INFLIGHT_DELTAS } from '../shared/host/stream.mjs';

function setup(opts: { maxQueue?: number } = {}) {
  let rev = 0;
  const hub = createStreamHub({ snapshot: () => ({ rev, items: [rev] }), epoch: () => 7, generation: 'gen-1', ...opts });
  const durable = (chatId = 'c', promotes?: string) => (hub.durable(chatId, { rev: ++rev, item: { n: rev }, promotes }), rev);
  const open = (fromRev?: number, chatId = 'c', backpressure = false, generation?: string) => {
    const frames: any[] = [];
    const closed: string[] = [];
    const sub = hub.subscribe(chatId, {
      fromRev,
      generation,
      send: (f: object) => (frames.push(f), !backpressure),
      close: (why: string) => closed.push(why),
    });
    return { frames, closed, sub };
  };
  return { hub, durable, open, setRev: (n: number) => (rev = n) };
}

test('Hello comes first with snapshot, rev, epoch and the in-flight keys; live frames follow on one seq', () => {
  const { hub, durable, open } = setup();
  durable();
  hub.delta('c', 'msg1', 'he');
  hub.delta('c', 'msg1', 'llo');
  const { frames } = open();
  assert.deepEqual(frames[0], {
    t: 'hello',
    seq: 3,
    rev: 1,
    epoch: 7,
    generation: 'gen-1',
    snapshot: { rev: 1, items: [1] },
    inFlightEphemeral: [{ key: 'msg1', deltas: ['he', 'llo'], truncated: false }],
  });
  hub.delta('c', 'msg1', '!');
  durable();
  assert.deepEqual(
    frames.slice(1).map((f) => [f.t, f.seq]),
    [
      ['delta', 4],
      ['durable', 5],
    ],
  );
  assert.equal(parseFrame(frames[0]).t, 'hello');
});

test('a reconnect replays durable frames only: the tail after its rev, no snapshot, the ephemeral deltas not replayed', () => {
  const { hub, durable, open } = setup();
  durable();
  hub.delta('c', 'k', 'x');
  durable();
  durable();
  const { frames } = open(1);
  assert.equal(frames[0].snapshot, null);
  assert.deepEqual(
    frames.slice(1).map((f) => [f.t, f.rev]),
    [
      ['durable', 2],
      ['durable', 3],
    ],
  );
  assert.deepEqual(frames[0].inFlightEphemeral, [{ key: 'k', deltas: ['x'], truncated: false }]);
  // up to date: Hello alone
  assert.equal(open(3).frames.length, 1);
});

test('a reconnect the tail cannot cover gets the snapshot instead (a gap, a rev ahead of the Host, none given)', () => {
  const { durable, open, setRev } = setup();
  durable();
  // the chat moved to rev 3 without publishing durables 2 and 3 on this Host
  setRev(3);
  const gap = open(0).frames;
  assert.equal(gap[0].snapshot.rev, 3);
  assert.equal(gap.length, 1);
  assert.equal(open(99).frames[0].snapshot.rev, 3);
  assert.notEqual(open().frames[0].snapshot, null);
});

test('a terminal delta is promoted to a durable and its key leaves the in-flight set; a retract drops a key without one', () => {
  const { hub, durable, open } = setup();
  hub.delta('c', 'a', 1);
  hub.delta('c', 'b', 2);
  const live = open();
  durable('c', 'a');
  hub.retract('c', 'b');
  assert.deepEqual(
    live.frames.slice(1).map((f) => [f.t, f.promotes ?? f.key]),
    [
      ['durable', 'a'],
      ['retract', 'b'],
    ],
  );
  assert.deepEqual(open().frames[0].inFlightEphemeral, []);
  assert.deepEqual(parseFrame(live.frames[1]), live.frames[1]);
});

test('an in-flight run longer than the cap is cut from the front and flagged', () => {
  const { hub, open } = setup();
  for (let i = 0; i < MAX_INFLIGHT_DELTAS + 3; i++) hub.delta('c', 'k', i);
  const run = open().frames[0].inFlightEphemeral[0];
  assert.equal(run.deltas.length, MAX_INFLIGHT_DELTAS);
  assert.equal(run.deltas[0], 3);
  assert.equal(run.truncated, true);
  assert.equal((parseFrame(open().frames[0]) as any).inFlightEphemeral[0].truncated, true);
});

test('a slow consumer is closed with overflow once its queue holds the maximum, and later frames reach nobody', () => {
  assert.equal(MAX_QUEUE, 1024);
  const { hub, open } = setup({ maxQueue: 3 });
  const slow = open(undefined, 'c', true);
  const fast = open();
  for (let i = 0; i < 6; i++) hub.delta('c', 'k', i);
  // the Hello went out and paused the writer; three frames queue, the fourth overflows
  assert.deepEqual(slow.closed, ['overflow']);
  assert.equal(slow.frames.length, 1);
  assert.deepEqual(fast.closed, []);
  assert.equal(fast.frames.length, 7);
  slow.sub.resume();
  assert.equal(slow.frames.length, 1);
  slow.sub.unsubscribe();
  assert.deepEqual(slow.closed, ['overflow']);
});

test('a consumer that drains in time keeps its stream; resume writes what queued', () => {
  const { hub, open } = setup({ maxQueue: 3 });
  const s = open(undefined, 'c', true);
  hub.delta('c', 'k', 1);
  hub.delta('c', 'k', 2);
  assert.equal(s.frames.length, 1);
  s.sub.resume();
  assert.equal(s.frames.length, 2, 'the writer pauses again after one frame under backpressure');
  assert.deepEqual(s.closed, []);
});

test('unsubscribe and close end a stream once; closing a chat ends every subscription and forgets its state', () => {
  const { hub, durable, open } = setup();
  const a = open();
  const b = open();
  a.sub.unsubscribe();
  a.sub.unsubscribe();
  assert.deepEqual(a.closed, ['unsubscribed']);
  durable();
  assert.equal(a.frames.length, 1);
  hub.close('c', 'moved');
  assert.deepEqual(b.closed, ['moved']);
  hub.delta('c', 'k', 1);
  assert.equal(b.frames.length, 2);
});

test('B1: a frame that is missing a field or has the wrong type is never applied', () => {
  const ok = { t: 'durable', seq: 1, rev: 1, item: {} };
  const rejects = (f: unknown) =>
    assert.throws(
      () => parseFrame(f),
      (e: any) => e instanceof StreamFrameError && e.code === 'bad_stream_frame',
    );
  for (const f of [null, [], 'x', {}, { ...ok, seq: -1 }, { ...ok, seq: '1' }, { ...ok, t: 'other' }]) rejects(f);
  rejects({ ...ok, rev: undefined });
  rejects({ ...ok, item: [] });
  rejects({ ...ok, promotes: '' });
  rejects({ t: 'delta', seq: 1, key: '' });
  rejects({ t: 'delta', seq: 1, key: 'k' });
  rejects({ t: 'retract', seq: 1 });
  const hello = { t: 'hello', seq: 0, rev: 0, epoch: 0, snapshot: null };
  rejects({ ...hello, epoch: undefined });
  rejects({ ...hello, snapshot: [] });
  rejects({ ...hello, inFlightEphemeral: 'x' });
  rejects({ ...hello, inFlightEphemeral: [{ key: 'k' }] });
});

test('B2/B3: an older Host without the in-flight list or the promotes field still parses; extra fields are dropped', () => {
  const hello = parseFrame({ t: 'hello', seq: 0, rev: 2, epoch: 1, snapshot: { rev: 2 }, future: 1 });
  assert.deepEqual(hello, { t: 'hello', seq: 0, rev: 2, epoch: 1, generation: '', snapshot: { rev: 2 }, inFlightEphemeral: [] });
  assert.equal((parseFrame({ t: 'hello', seq: 0, rev: 2, epoch: 1 }) as any).snapshot, null);
  assert.deepEqual(parseFrame({ t: 'durable', seq: 3, rev: 2, item: {}, extra: 1 }), { t: 'durable', seq: 3, rev: 2, item: {} });
  assert.deepEqual(parseFrame({ t: 'delta', seq: 4, key: 'k', delta: 0 }), { t: 'delta', seq: 4, key: 'k', delta: 0 });
  assert.deepEqual(parseFrame({ t: 'retract', seq: 5, key: 'k', x: 1 }), { t: 'retract', seq: 5, key: 'k' });
});

test('a replay longer than the queue overflows the new subscription instead of delivering a partial tail', () => {
  const { durable, open } = setup({ maxQueue: 2 });
  for (let i = 0; i < 5; i++) durable();
  const s = open(0, 'c', true);
  assert.deepEqual(s.closed, ['overflow']);
  assert.equal(s.frames.length, 1);
});

test('the durable tail is bounded: a reconnect from before its start gets the snapshot', () => {
  const { durable, open } = setup();
  for (let i = 0; i < 502; i++) durable();
  assert.equal(open(0).frames[0].snapshot.rev, 502);
  const resumed = open(500).frames;
  assert.equal(resumed[0].snapshot, null);
  assert.deepEqual(
    resumed.slice(1).map((f) => f.rev),
    [501, 502],
  );
});

test('a reconnect resumes only in the numbering it counted in: another generation (a restarted Host) gets the snapshot, none given resumes', () => {
  const { durable, open } = setup();
  durable();
  durable();
  durable();
  for (const [name, generation, resumed] of [
    ['same numbering', 'gen-1', true],
    ['an older client names none', undefined, true],
    ['the Host restarted since', 'gen-0', false],
  ] as const) {
    const { frames } = open(1, 'c', false, generation);
    assert.equal(frames[0].snapshot === null, resumed, name);
    assert.equal(frames[0].generation, 'gen-1');
    assert.equal(frames.length, resumed ? 3 : 1, name);
  }
});

test('every hub names its numbering, and a different one for each Host process', () => {
  const a = createStreamHub({ snapshot: () => ({ rev: 0 }), epoch: () => 0 });
  const b = createStreamHub({ snapshot: () => ({ rev: 0 }), epoch: () => 0 });
  const named = (hub: any) => {
    let hello: any;
    hub.subscribe('c', { send: (f: any) => ((hello = f), true), close: () => undefined });
    return hello.generation;
  };
  assert.match(named(a), /^[0-9a-f-]{36}$/);
  assert.notEqual(named(a), named(b));
});

test('B3: a Hello from an older Host that names no numbering reads as an empty generation', () => {
  const hello = (o: object) => parseFrame({ t: 'hello', seq: 0, rev: 0, epoch: 0, snapshot: null, ...o }) as any;
  assert.equal(hello({}).generation, '');
  assert.equal(hello({ generation: 'g' }).generation, 'g');
  assert.equal(hello({ generation: 7 }).generation, '');
});
