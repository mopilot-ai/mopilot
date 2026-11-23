// The phone's follow of a chat on a Host it reaches directly (shared/remote/phoneChats.mjs): the snapshot Thread reads, the live events, resyncs, paging and the sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneChats, keyOf } from '../shared/remote/phoneChats.mjs';
import { PhoneHostError } from '../shared/remote/phoneHost.mjs';

const ev = (turnId: string, event: object) => ({ t: 'event', family: 'acp', event: { turnId, ...event } });
const start = (t: string, text: string) =>
  ev(t, { kind: 'turnStart', user: { id: `u-${t}`, clientId: t, content: [{ type: 'text', text }] } });
const said = (t: string, text: string) =>
  ev(t, { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
const done = (t: string) => ev(t, { kind: 'turnEnd', stopReason: 'end_turn' });
const hello = (o: any = {}) => ({
  t: 'hello',
  seq: 0,
  rev: 3,
  epoch: 4,
  generation: 'g1',
  snapshot: { rev: 3, items: [start('t1', 'hi'), said('t1', 'hello'), done('t1')] },
  inFlightEphemeral: [],
  ...o,
});
const durable = (rev: number, item: object, extra: object = {}) => ({ t: 'durable', seq: rev, rev, item, ...extra });

function rig(
  o: {
    frames?: any[];
    subscribe?: (p: any) => void;
    history?: (p: any) => any;
    send?: (p: any) => any;
    stop?: (p: any) => any;
    start?: (p: any) => any;
  } = {},
) {
  const emitted: any[] = [];
  const calls: any[] = [];
  const moved: string[] = [];
  const session: any = {
    async subscribe(p: any) {
      calls.push(['subscribe', p]);
      o.subscribe?.(p);
      for (const frame of o.frames ?? [hello()]) chats.onEvent('m1', { event: 'frame', chatId: p.chatId, frame });
      return { subscribed: true };
    },
    async history(p: any) {
      calls.push(['history', p]);
      return o.history?.(p);
    },
    async send(p: any) {
      calls.push(['send', p]);
      return o.send ? o.send(p) : { turnId: 'tx' };
    },
    async stop(p: any) {
      calls.push(['stop', p]);
      return o.stop ? o.stop(p) : { stopped: true };
    },
    async start(p: any) {
      calls.push(['start', p]);
      return o.start ? o.start(p) : { chatId: p.chatId };
    },
  };
  const chats = createPhoneChats({
    host: async () => session,
    hostKeyOf: (m: string) => (m === 'm1' ? 'a'.repeat(64) : null),
    emit: (chatId: string, event: any) => emitted.push({ chatId, ...event }),
    cardsMoved: (machineId: string) => moved.push(machineId),
    now: () => 1000,
  });
  return { chats, emitted, calls, session, moved };
}
const frame = (chatId: string, f: object) => ({ event: 'frame', chatId, frame: f });

test('follow answers with finished turns as rows and the epoch the Host named, then live frames become feed events', async () => {
  const r = rig();
  const snap = await r.chats.follow('m1', 'c1');
  assert.equal(snap.rev, 3);
  assert.equal(snap.itemsShape, 'items');
  assert.deepEqual(snap.session, { turn: 'completed' });
  assert.deepEqual(
    snap.history.map((h: any) => h.role),
    ['user', 'assistant'],
  );
  assert.deepEqual(r.calls[0], ['subscribe', { chatId: 'c1', epoch: 0 }]);
  r.chats.onEvent('m1', frame('c1', durable(4, start('t2', 'again'))));
  r.chats.onEvent('m1', frame('c1', durable(5, said('t2', 'x'))));
  assert.deepEqual(
    r.emitted.map((e) => [e.chatId, e.ev, e.feedSeq]),
    [
      ['c1', 'turn.state', 1],
      ['c1', 'items.append', 2],
      ['c1', 'items.append', 3],
    ],
  );
  // an old frame, another chat, another machine and a line that is no frame say nothing
  r.chats.onEvent('m1', frame('c1', durable(5, said('t2', 'dup'))));
  r.chats.onEvent('m1', frame('other', durable(6, said('t2', 'z'))));
  r.chats.onEvent('m2', frame('c1', durable(6, said('t2', 'z'))));
  r.chats.onEvent('m1', { event: 'attention', chatId: 'c1' });
  r.chats.onEvent('m1', null);
  r.chats.onEvent('m1', frame('c1', { t: 'state', seq: 9, patch: { title: 'x' } }));
  assert.equal(r.emitted.length, 3);
});

test('a Claude Code or Codex chat is followed by the id the Mac lists and spoken of to the Host by the id the Host names it', async () => {
  const uuid = '11111111-2222-4333-8444-555555555555';
  for (const [app, hostName] of [
    [`acp:host-claude:${uuid}`, `claude:${uuid}`],
    [`acp:host-codex:${uuid}`, uuid],
    ['acp:gemini:abc', 'acp:gemini:abc'],
  ]) {
    const r = rig();
    const snap = await r.chats.follow('m1', app);
    assert.equal(snap.chatId, app, 'the phone keeps the id it follows by');
    assert.deepEqual(r.calls[0], ['subscribe', { chatId: hostName, epoch: 0 }]);
    // the Host's frames and its closing line carry its own name for the chat
    r.chats.onEvent('m1', frame(hostName, durable(4, start('t2', 'again'))));
    assert.deepEqual(
      r.emitted.map((e) => [e.chatId, e.ev]),
      [
        [app, 'turn.state'],
        [app, 'items.append'],
      ],
    );
    r.chats.onEvent('m1', { event: 'closed', chatId: hostName });
    assert.equal(r.emitted.at(-1).chatId, app);
    await r.chats.follow('m1', app);
    await r.chats.send('m1', { chatId: app, text: 'go' });
    await r.chats.stop('m1', app);
    await r.chats.start('m1', { chatId: app, startId: 's1', text: 'hi', harness: 'x' });
    assert.deepEqual(
      r.calls.filter((c) => c[0] !== 'subscribe').map((c) => c[1].chatId),
      [hostName, hostName, hostName],
      'send, stop and start name it the way the Host does',
    );
  }
});

test("a hello that clips the log is filled from the Host's pages, pinned to its generation and revision", async () => {
  const lines = [start('t1', 'hi'), said('t1', 'one'), done('t1')].map((i) => JSON.stringify(i));
  const pages = [
    { generation: 'g1', rev: 3, chunk: `${lines[0]}\n${lines[1]}\n`, next: { index: 2, offset: 0 } },
    { generation: 'g1', rev: 3, chunk: `${lines[2]}\n\n`, next: null },
  ];
  const r = rig({ frames: [hello({ rev: 3, snapshot: { rev: 3, items: [], paged: true } })], history: () => pages.shift() });
  const snap = await r.chats.follow('m1', 'c1');
  assert.deepEqual(
    snap.history.map((h: any) => h.text),
    ['hi', 'one'],
  );
  assert.deepEqual(r.calls[1][1], { chatId: 'c1', epoch: 4, generation: 'g1', rev: 3, index: 0, offset: 0 });
  assert.deepEqual(r.calls[2][1].index, 2);
  const wrong = rig({
    frames: [hello({ rev: 3, snapshot: { rev: 3, items: [], paged: true } })],
    history: () => ({ generation: 'g2', rev: 3, chunk: '', next: null }),
  });
  await assert.rejects(wrong.chats.follow('m1', 'c1'), /invalid/);
  const endless = rig({
    frames: [hello({ rev: 3, snapshot: { rev: 3, items: [], paged: true } })],
    history: () => ({ generation: 'g1', rev: 3, chunk: '', next: { index: 1, offset: 0 } }),
  });
  await assert.rejects(endless.chats.follow('m1', 'c1'), /invalid/);
});

test('text the Host has not finished shows live, and a promoted or retracted key makes the Thread read the chat again', async () => {
  const r = rig({ frames: [hello({ inFlightEphemeral: [{ key: 'k1', deltas: [{ text: 'par' }, {}], truncated: false }] })] });
  const snap = await r.chats.follow('m1', 'c1');
  assert.deepEqual(snap.items, [{ id: 'e-k1', type: 'agentMessage', text: 'par' }]);
  assert.equal(snap.history.length, 2);
  r.chats.onEvent('m1', frame('c1', { t: 'delta', seq: 5, key: 'k1', delta: { text: 'tial' } }));
  r.chats.onEvent('m1', frame('c1', { t: 'delta', seq: 6, key: 'k2', delta: { text: 'new' } }));
  r.chats.onEvent('m1', frame('c1', { t: 'delta', seq: 7, key: 'k2', delta: {} }));
  assert.deepEqual(
    r.emitted.map((e) => e.ev),
    ['items.delta', 'items.append'],
  );
  r.chats.onEvent('m1', frame('c1', durable(4, said('t1', 'partial'), { promotes: 'k1' })));
  r.chats.onEvent('m1', frame('c1', { t: 'retract', seq: 8, key: 'k2' }));
  r.chats.onEvent('m1', frame('c1', { t: 'retract', seq: 9, key: 'nope' }));
  const stale = r.emitted.filter((e) => e.live === false);
  assert.equal(stale.length, 2);
});

test('a gap, a frame that cannot be read and a closed stream make the Thread read again; the next follow starts clean', async () => {
  const r = rig();
  await r.chats.follow('m1', 'c1');
  r.chats.onEvent('m1', frame('c1', durable(12, said('t1', 'jump'))));
  r.chats.onEvent('m1', frame('c1', { t: 'nonsense', seq: 1 }));
  r.chats.onEvent('m1', { event: 'closed', chatId: 'c1', reason: 'overflow' });
  r.chats.onEvent('m1', { event: 'closed', chatId: 'c1', reason: 'overflow' });
  assert.equal(r.emitted.filter((e) => e.live === false).length, 3);
  const again = await r.chats.follow('m1', 'c1');
  assert.equal(again.history.length, 2);
  // not followed: a bad frame or gap is only remembered
  r.chats.unfollow('c1');
  assert.equal(r.chats.has('c1'), false);
  assert.deepEqual(r.chats.unfollow('nope'), { unfollowed: true });
});

test('frames that arrive while the follow waits are part of the snapshot, a gap among them fails it, and no hello fails it', async () => {
  const r = rig({ frames: [hello(), durable(4, start('t2', 'late')), durable(5, said('t2', 'now'))] });
  const snap = await r.chats.follow('m1', 'c1');
  assert.equal(snap.rev, 5);
  assert.equal(snap.liveTurn.id, 't2');
  assert.deepEqual(r.emitted, []);
  const gap = rig({ frames: [hello(), durable(9, said('t1', 'x'))] });
  await assert.rejects(gap.chats.follow('m1', 'c1'), /changed while it was read/);
  const none = rig({ frames: [{ t: 'state', seq: 1, patch: {} }] });
  await assert.rejects(none.chats.follow('m1', 'c1'), /no state/);
  const odd = rig({ frames: [{ nope: 1 }] });
  await assert.rejects(odd.chats.follow('m1', 'c1'), /no state/);
});

test('a stale epoch is retried once with the epoch the Host names, and kept for the next request', async () => {
  let first = true;
  const r = rig({
    subscribe: () => {
      if (first) {
        first = false;
        throw new PhoneHostError('stale_epoch', 'stale', { current: 4 });
      }
    },
    send: (p: any) => {
      if (p.epoch !== 4) throw new PhoneHostError('stale_epoch', 'stale', { current: 4 });
      return { turnId: 't' };
    },
  });
  await r.chats.follow('m1', 'c1');
  assert.deepEqual(
    r.calls.filter((c) => c[0] === 'subscribe').map((c) => c[1].epoch),
    [0, 4],
  );
  await r.chats.send('m1', { chatId: 'c1', text: 'hi', sendId: 's1' });
  assert.equal(r.calls.at(-1)[1].epoch, 4);
  const never = rig({
    subscribe: () => {
      throw new PhoneHostError('refused', 'no');
    },
  });
  await assert.rejects(never.chats.follow('m1', 'c1'), /no/);
  const bare = rig({
    subscribe: () => {
      throw new PhoneHostError('stale_epoch', 'stale');
    },
  });
  await assert.rejects(bare.chats.follow('m1', 'c1'), /stale/);
});

test('one message is one key however many times it is sent, pictures are refused, and a stop and a start carry their own', async () => {
  const r = rig();
  await r.chats.send('m1', { chatId: 'c1', text: 'hi', sendId: 's1' });
  await r.chats.send('m1', { chatId: 'c1', text: 'hi', sendId: 's1' });
  await r.chats.send('m1', { chatId: 'c1', text: 'hi' });
  const keys = r.calls.map((c) => c[1].key);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.equal(keys[0], keyOf('send', 's1'));
  assert.match(keys[0], /^phone-[0-9a-f]{24}$/);
  assert.deepEqual(r.calls[0][1], { chatId: 'c1', epoch: 0, key: keys[0], text: 'hi', human: true });
  await assert.rejects(r.chats.send('m1', { chatId: 'c1', text: 'x', attachments: ['a'] }), /not sent to this machine/);
  await assert.rejects(r.chats.send('m1', { chatId: 'c1', text: 'x', skills: ['a'] }), /not sent to this machine/);
  await r.chats.stop('m1', 'c1');
  await r.chats.stop('m1', 'c1', 'tt');
  const stops = r.calls.filter((c) => c[0] === 'stop').map((c) => c[1]);
  assert.equal(stops[0].turnId, undefined);
  assert.equal(stops[1].turnId, 'tt');
  assert.notEqual(stops[0].key, stops[1].key);
  await r.chats.start('m1', { chatId: 'claude:1', startId: 'st1', harness: 'claude', text: 'go' });
  await r.chats.start('m1', { chatId: 'claude:1', startId: 'st1', harness: 'claude', text: 'go' });
  const starts = r.calls.filter((c) => c[0] === 'start').map((c) => c[1]);
  assert.equal(starts[0].key, starts[1].key);
  assert.equal(starts[0].startId, undefined);
});

test('a follow of a machine whose Host key is unknown scopes pictures by its id, and the default clock is used', async () => {
  const emitted: any[] = [];
  const chats = createPhoneChats({
    host: async () =>
      ({
        subscribe: async (p: any) => {
          chats.onEvent('m9', frame(p.chatId, hello()));
          return {};
        },
      }) as any,
    hostKeyOf: () => null,
    emit: (_c: string, e: any) => emitted.push(e),
  });
  assert.equal((await chats.follow('m9', 'c')).history.length, 2);
  await assert.rejects(
    createPhoneChats({ host: async () => ({}) as any, hostKeyOf: () => null, emit: () => undefined }).send('m', { chatId: 'c', text: 'a' }),
    TypeError,
  );
});

test('a hello that resumes with no snapshot is an empty log, and a stop while a turn runs names that turn', async () => {
  const r = rig({ frames: [hello({ snapshot: null, rev: 0 })] });
  assert.deepEqual((await r.chats.follow('m1', 'c1')).history, []);
  const running = rig({ frames: [hello({ snapshot: { rev: 1, items: [start('t5', 'go')] }, rev: 1 })] });
  const snap = await running.chats.follow('m1', 'c1');
  assert.equal(snap.liveTurn.id, 't5');
  await running.chats.stop('m1', 'c1');
  assert.notEqual(running.calls.at(-1)[1].key, keyOf('stop', 'c1\n\n'));
});

test('a machine whose session ended makes the chats followed through it out of date, once, and leaves other machines and chats alone (#4858)', async () => {
  const r = rig();
  await r.chats.follow('m1', 'c1');
  await r.chats.follow('m1', 'c2');
  r.chats.unfollow('c2');
  r.emitted.length = 0;
  r.chats.sessionEnded('m2');
  assert.deepEqual(r.emitted, [], 'another machine’s session says nothing of this chat');
  r.chats.sessionEnded('m1');
  assert.deepEqual(
    r.emitted.map((e: any) => [e.chatId, e.ev, e.status]),
    [['c1', 'turn.state', null]],
    'the followed chat is told its picture is out of date; the one no longer followed is not',
  );
  assert.deepEqual(r.chats.followed(), []);
  r.chats.sessionEnded('m1');
  assert.equal(r.emitted.length, 1, 'a second end has nothing left to tell');
});

test('a card raised, withdrawn or closed by its turn ending on an open chat tells the kit the machine’s cards moved; other items do not (#4857)', async () => {
  const r = rig();
  await r.chats.follow('m1', 'c1');
  r.moved.length = 0;
  const push = (rev: number, item: object) => r.chats.onEvent('m1', frame('c1', durable(rev, item)));
  push(4, start('t2', 'write it'));
  push(5, said('t2', 'writing'));
  assert.deepEqual(r.moved, [], 'nothing about a card yet');
  push(6, ev('t2', { kind: 'permission', requestId: 'r1', toolCall: { title: 'Write cell.txt', kind: 'edit' }, options: [] }));
  assert.deepEqual(r.moved, ['m1'], 'a permission asks the Host which cards wait');
  push(7, ev('t2', { kind: 'question', question: { id: 'q1' } }));
  push(8, ev('t2', { kind: 'permissionCancelled', requestId: 'r1' }));
  push(9, done('t2'));
  assert.deepEqual(r.moved, ['m1', 'm1', 'm1', 'm1'], 'a question, a cancellation and the turn ending each do too');
  // an item that is not an event (the Host's own summary items) is not a card
  push(10, { t: 'summary', text: 'x' });
  assert.equal(r.moved.length, 4);
});
