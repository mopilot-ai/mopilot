// The mirror of chats that run on a remote Host (electron/host/remoteChats.cjs): the Host's records become the chat's transcript here and events on the ACP bus, once, in order, across reconnects, restarts of either side and a Host that restarted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHAT, FakeItems, createRemoteChats, end, ev, fakeHost, start, text, tick, world } from './support/host/remoteChatsKit.ts';

const { AcpItems } = createRequire(import.meta.url)('../electron/harness/items/acp.cjs');

test('following an online chat subscribes from nowhere, lists it with a session record and records and shows what the Host holds', async () => {
  const w = world();
  w.host.reply = {
    snapshot: { rev: 4, items: [{ t: 'user', turnId: 't1', text: 'hi' }, start(), text('hello'), end()] },
    patches: null,
    generation: 'g1',
    inflight: [],
  };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(w.host.asked, [[CHAT, undefined, undefined]]);
  assert.deepEqual(w.items.records[0], { t: 'session', harness: 'kimi', sessionId: 'host:m1', cwd: '/srv/work', at: 1000 });
  assert.deepEqual(
    w.items.records.slice(1).map((r) => [r.t, r.hostRev, r.hostGen]),
    [
      ['user', 2, 'g1'],
      ['update', 3, 'g1'],
      ['end', 4, 'g1'],
    ],
  );
  // the Host's own folder and the agent's usage stay out of what this Mac keeps and runs on
  assert.equal('cwd' in w.emitted[0], false);
  assert.deepEqual(
    w.emitted.map((e) => [e.kind, e.key]),
    [
      ['turnStart', CHAT],
      ['update', CHAT],
      ['turnEnd', CHAT],
    ],
  );
  assert.deepEqual(w.items.records[3], { t: 'end', turnId: 't1', stopReason: 'end_turn', at: 1000, hostRev: 4, hostGen: 'g1' });
});

test('live records are written and shown once and in order, however often the Host repeats them', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  w.host.fire.patch(CHAT, 1, start());
  w.host.fire.patch(CHAT, 1, start());
  w.host.fire.patch(CHAT, 2, text('x'));
  w.host.fire.patch(CHAT, 3, ev({ kind: 'permission', requestId: 'p1', turnId: 't1', options: [] }));
  w.host.fire.patch(CHAT, 4, { t: 'assistant', turnId: 't1', text: 'x' });
  await w.chats.settled(CHAT);
  assert.deepEqual(
    w.emitted.map((e) => e.kind),
    ['turnStart', 'update', 'permission'],
  );
  // a card leaves no record, but the revision counts: a replay does not show it again
  assert.deepEqual(
    w.items.records.map((r) => r.hostRev),
    [undefined, 1, 2],
  );
  w.host.fire.patch(CHAT, 3, ev({ kind: 'permission', requestId: 'p1' }));
  await w.chats.settled(CHAT);
  assert.equal(w.emitted.length, 3);
});

test('a message streams as deltas and its one record then adds only what the deltas did not show', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const key = 't1:agent_message_chunk:';
  const head = { turnId: 't1', sessionUpdate: 'agent_message_chunk' };
  w.host.fire.delta(CHAT, key, { ...head, text: 'hel' });
  w.host.fire.delta(CHAT, key, { ...head, text: 'lo' });
  // the Host records the message; the window saw 'hello' already and gets the rest
  w.host.fire.patch(CHAT, 1, text('hello, world'), key);
  // a message nothing streamed is shown whole; a retract and a delta without text are ignored
  w.host.fire.patch(CHAT, 2, text('unseen', 't1', { messageId: 'm2' }), 't1:agent_message_chunk:m2');
  w.host.fire.frame(CHAT, { t: 'retract', key });
  w.host.fire.delta(CHAT, key, { ...head });
  w.host.fire.delta(CHAT, key, 'plain');
  await w.chats.settled(CHAT);
  assert.deepEqual(
    w.emitted.map((e) => e.update.content.text),
    ['hel', 'lo', ', world', 'unseen'],
  );
  assert.equal(w.emitted[3].update.messageId, 'm2');
  assert.deepEqual(
    w.items.records.slice(1).map((r) => r.update.content.text),
    ['hello, world', 'unseen'],
  );
});

test('a recorded message that does not continue what was shown replaces it, once, instead of being left to a reload (#3525)', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const key = 't1:agent_message_chunk:';
  w.host.fire.delta(CHAT, key, { turnId: 't1', sessionUpdate: 'agent_message_chunk', text: 'abc' });
  w.host.fire.patch(CHAT, 1, text('xyz'), key);
  await w.chats.settled(CHAT);
  assert.equal(w.emitted.length, 2);
  assert.deepEqual([w.emitted[1].update.content.text, w.emitted[1].replaces], ['xyz', 'abc']);
  assert.equal(w.items.records[1].update.content.text, 'xyz');
});

test('a reconnect hands over the text of the unfinished message: only what the window lacks is shown', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const key = 't1:agent_message_chunk:';
  const head = { turnId: 't1', sessionUpdate: 'agent_message_chunk' };
  w.host.fire.delta(CHAT, key, { ...head, text: 'he' });
  w.host.fire.inflight(CHAT, [
    {
      key,
      deltas: [
        { ...head, text: 'he' },
        { ...head, text: 'llo' },
      ],
      truncated: false,
    },
  ]);
  w.host.fire.inflight(CHAT, [
    {
      key,
      deltas: [
        { ...head, text: 'he' },
        { ...head, text: 'llo' },
      ],
      truncated: false,
    },
    { key: 'k2', deltas: ['x'], truncated: false },
  ]);
  await w.chats.settled(CHAT);
  assert.deepEqual(
    w.emitted.map((e) => e.update.content.text),
    ['he', 'llo'],
  );
});

test('a chat whose transcript already follows the Host resumes from its revision in the numbering it counted in', async () => {
  const items = new FakeItems();
  items.records = [
    { t: 'session', harness: 'kimi' },
    { t: 'update', hostRev: 7, hostGen: 'g1' },
    { t: 'title', name: 'x' },
  ];
  const w = world(fakeHost(), items);
  w.host.reply = {
    snapshot: { rev: 9 },
    generation: 'g1',
    inflight: [],
    patches: [
      { chatId: CHAT, rev: 7, patch: { item: start() } },
      { chatId: CHAT, rev: 8, patch: { item: end() } },
    ],
  };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(w.host.asked, [[CHAT, 7, 'g1']]);
  // revision 7 is on record already
  assert.deepEqual(
    w.emitted.map((e) => e.kind),
    ['turnEnd'],
  );
  assert.equal(items.records.filter((r) => r.t === 'session').length, 1);
});

test('a Host that restarted numbers again from the start: its snapshot is new to this chat, whatever its revisions say', async () => {
  const items = new FakeItems();
  items.records = [
    { t: 'session', harness: 'kimi' },
    { t: 'update', hostRev: 30, hostGen: 'old' },
  ];
  const w = world(fakeHost(), items);
  w.host.reply = { snapshot: { rev: 2, items: [start(), end()] }, patches: null, generation: 'new', inflight: [] };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(
    items.records.slice(2).map((r) => [r.t, r.hostRev, r.hostGen]),
    [
      ['user', 1, 'new'],
      ['end', 2, 'new'],
    ],
  );
  // and in the same numbering a later snapshot only adds what is newer than the cursor
  w.host.fire.resync(CHAT, { rev: 3, items: [start(), end(), text('later')] }, 'new');
  await w.chats.settled(CHAT);
  assert.equal(items.records.at(-1).update.content.text, 'later');
  assert.equal(items.records.length, 5);
});

test('a chat on a machine that is away is followed when it answers, and again after every return', async () => {
  const w = world(fakeHost({ state: 'connecting' }));
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(w.host.asked, []);
  // the chat is listed meanwhile
  assert.equal(w.items.records[0].t, 'session');
  w.host.reply = { snapshot: { rev: 1, items: [start()] }, patches: null, generation: 'g1', inflight: [] };
  w.host.fire.state('online');
  await w.chats.settled(CHAT);
  assert.equal(w.host.asked.length, 1);
  w.host.reply = { snapshot: { rev: 1 }, patches: [], generation: 'g1', inflight: [] };
  w.host.fire.state('offline');
  w.host.fire.state('online');
  await w.chats.settled(CHAT);
  assert.deepEqual(w.host.asked[1], [CHAT, 1, 'g1']);
});

test('events of a chat that is not followed, and frames the Host sent wrongly, change nothing', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  w.host.fire.patch('other', 1, start());
  w.host.fire.delta('other', 'k', { text: 'x' });
  w.host.fire.resync('other', { rev: 1, items: [start()] });
  w.host.fire.inflight('other', [{ key: 'k', deltas: [{ text: 'x' }] }]);
  w.host.fire.patch(CHAT, 1, 'not an item' as any);
  w.host.fire.patch(CHAT, 2, ev('not an event' as any));
  w.host.fire.patch(CHAT, 3, { t: 'event', family: 'claude', event: { kind: 'turnStart' } });
  await w.chats.settled(CHAT);
  assert.deepEqual(w.emitted, []);
  assert.equal(w.items.records.length, 1);
});

test('a subscribe to a machine that is away waits for its return; any other failure is reported and does not hold up the chat', async () => {
  const w = world();
  let fail: Error | null = Object.assign(new Error('gone'), { code: 'host_unreachable' });
  const subscribe = w.host.subscribe;
  w.host.subscribe = async (...a: any[]) => {
    if (fail) throw fail;
    return subscribe(...a);
  };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(w.reported, []);
  fail = Object.assign(new Error('let go'), { code: 'disposed' });
  w.host.fire.state('online');
  await w.chats.settled(CHAT);
  assert.deepEqual(w.reported, []);
  fail = new Error('The Host sent a subscription this app cannot read.');
  w.host.fire.state('online');
  await w.chats.settled(CHAT);
  assert.equal(w.reported.length, 1);
  fail = null;
  w.host.fire.state('online');
  await w.chats.settled(CHAT);
  assert.equal(w.host.asked.length, 1);
});

test('a chat that is local, one whose machine cannot be had, and one already followed are not followed twice; moving or unfollowing ends it', async () => {
  const w = world();
  w.setOwner({ hostId: 'local', folder: null });
  w.chats.follow(CHAT);
  w.setOwner({ hostId: 'gone', folder: null });
  w.chats.follow(CHAT);
  assert.equal(w.host.listeners(), 0);
  w.setOwner({ hostId: 'm1', folder: '/srv/work' });
  w.chats.follow(CHAT);
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.equal(w.host.asked.length, 1);
  // the chat moved to another machine: the old connection's records no longer count
  const other = fakeHost();
  w.hosts.m2 = other;
  w.setOwner({ hostId: 'm2', folder: '/w' });
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.equal(other.asked.length, 1);
  w.host.fire.patch(CHAT, 5, start());
  other.fire.patch(CHAT, 5, start());
  await w.chats.settled(CHAT);
  assert.equal(w.emitted.length, 1);
  w.chats.unfollow(CHAT);
  other.fire.patch(CHAT, 6, end());
  await tick();
  assert.equal(w.emitted.length, 1);
  w.chats.unfollow('never-followed');
  w.chats.dispose();
  w.chats.follow(CHAT);
  assert.equal(other.listeners(), 0);
});

test('a connection that cannot be made is not a failure of the chat, but any other error from it is reported', async () => {
  const w = world(fakeHost({ state: 'offline' }));
  w.host.connect = async () => {
    throw Object.assign(new Error('x'), { code: 'host_unreachable' });
  };
  w.chats.follow(CHAT);
  await tick();
  assert.deepEqual(w.reported, []);
  w.chats.unfollow(CHAT);
  w.host.connect = async () => {
    throw new Error('boom');
  };
  w.chats.follow(CHAT);
  await tick();
  assert.equal(w.reported.length, 1);
});

test('records replayed after a restart do not bring back a card that was answered or a turn that ended', async () => {
  const w = world();
  w.host.reply = {
    snapshot: { rev: 6 },
    patches: [
      { rev: 1, item: ev({ kind: 'permission', requestId: 'p1', turnId: 't1' }) },
      { rev: 2, item: ev({ kind: 'permissionCancelled', requestId: 'p1' }) },
      { rev: 3, item: ev({ kind: 'permission', requestId: 'p2', turnId: 't1' }) },
      { rev: 4, item: end() },
      { rev: 5, item: ev({ kind: 'permission', requestId: 'p3', turnId: 't2' }) },
    ].map((p) => ({ chatId: CHAT, rev: p.rev, patch: { item: p.item } })),
    generation: 'g1',
    inflight: [],
  };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(
    w.emitted.filter((e) => e.kind === 'permission').map((e) => e.requestId),
    [`${CHAT}|p3`],
  );
});

test("a transcript record without its numbering reads as the Host's unnamed one; a chat id that names no agent lists with none", async () => {
  const items = new FakeItems();
  items.records = [
    { t: 'session', harness: 'kimi' },
    { t: 'update', hostRev: 3 },
  ];
  const w = world(fakeHost(), items);
  w.host.reply = { snapshot: { rev: 3 }, patches: [], generation: '', inflight: [] };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(w.host.asked, [[CHAT, 3, '']]);
  const bare = world();
  bare.chats.follow('plain-chat');
  await bare.chats.settled('plain-chat');
  assert.equal(bare.items.records[0].harness, '');
});

test('a Host connection that was replaced under the same machine takes the chat over, and its old listeners are let go', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const fresh = fakeHost();
  w.hosts.m1 = fresh;
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.equal(fresh.asked.length, 1);
  assert.equal(w.host.listeners(), 0);
});

test('a delta carries its message id to the window, and settled has nothing to wait for on a chat that is not followed', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  w.host.fire.delta(CHAT, 't1:agent_message_chunk:m9', { turnId: 't1', sessionUpdate: 'agent_message_chunk', messageId: 'm9', text: 'hi' });
  await w.chats.settled(CHAT);
  assert.equal(w.emitted[0].update.messageId, 'm9');
  await w.chats.settled('nobody');
});

test('without a report of its own, a failure of the mirror goes to the app-wide ignored-error log', async () => {
  const host = fakeHost();
  host.subscribe = async () => {
    throw new Error('The Host sent a subscription this app cannot read.');
  };
  const chats = createRemoteChats({
    items: new FakeItems(),
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: null }),
    emit: () => undefined,
    cards: { pending: () => undefined, timedOut: () => undefined, answered: () => undefined },
  });
  await chats.follow(CHAT);
  await chats.settled(CHAT);
  chats.dispose();
});

test('A3: work queued behind a slow subscribe is dropped when the service is disposed meanwhile', async () => {
  const w = world();
  let release!: (v: any) => void;
  w.host.subscribe = () => new Promise((r) => (release = r));
  w.chats.follow(CHAT);
  await tick();
  await tick();
  w.host.fire.patch(CHAT, 5, start());
  w.chats.dispose();
  release({ snapshot: { rev: 0, items: [] }, patches: null, generation: 'g1', inflight: [] });
  await tick();
  await tick();
  assert.deepEqual(w.emitted, []);
});

test('a turn the transcript shows as begun and not ended is announced again when the app is back, once, and a finished turn is not', async () => {
  const items = new FakeItems();
  const user = { id: 'u2', content: [] };
  items.records = [
    { t: 'session', harness: 'kimi' },
    { t: 'user', turnId: 't1', user: { id: 'u1' }, hostRev: 1, hostGen: 'g1' },
    { t: 'end', turnId: 't1', hostRev: 2, hostGen: 'g1' },
    { t: 'user', turnId: 't2', user, hostRev: 3, hostGen: 'g1' },
  ];
  const w = world(fakeHost(), items);
  w.host.reply = { snapshot: { rev: 3 }, patches: [], generation: 'g1', inflight: [] };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const partway = { file: `${CHAT}.items.jsonl`, extra: [], upTo: items.records.length };
  assert.deepEqual(w.emitted, [{ kind: 'turnStart', key: CHAT, turnId: 't2', user, partway }]);
  assert.deepEqual(items.flushed, [CHAT]);
  // main's translation of that event goes on from the transcript the machine's stream wrote
  const shown: any[] = [];
  const translation = new AcpItems({
    chatOf: () => CHAT,
    nativeOf: () => CHAT,
    cwdOf: () => '',
    emit: (_c: string, _k: string, _m: string, params: any) => params.item?.text && shown.push([params.item.id, params.item.text]),
  });
  const message = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'written before the restart' } };
  const written = [...items.records, { t: 'update', turnId: 't2', update: message }];
  translation.onEvent({ ...w.emitted[0], partway: { file: '', extra: written } });
  await translation.followed;
  translation.onEvent({
    key: CHAT,
    kind: 'update',
    turnId: 't2',
    update: { sessionUpdate: 'agent_message_chunk', messageId: 'b', content: { type: 'text', text: 'after it' } },
  });
  translation.onEvent({ key: CHAT, kind: 'turnEnd', turnId: 't2', stopReason: 'end_turn', error: null });
  assert.deepEqual(
    shown,
    [
      ['t2:m0', 'written before the restart'],
      ['t2:m1', 'after it'],
    ],
    'the message the transcript named t2:m0 is not written over',
  );
  // coming back online asks the machine again but does not announce the turn again
  w.host.fire.state('offline');
  w.host.fire.state('online');
  await w.chats.settled(CHAT);
  assert.equal(w.emitted.length, 1);
  // the machine's later records say how it went
  w.host.fire.patch(CHAT, 4, end('t2'));
  await w.chats.settled(CHAT);
  assert.equal(w.emitted.at(-1)?.kind, 'turnEnd');
  // a chat with nothing begun announces nothing
  const done = world();
  done.chats.follow(CHAT);
  await done.chats.settled(CHAT);
  assert.deepEqual(done.emitted, []);
});

test('a turn a later one followed lost its end: it is not announced as still running', async () => {
  const items = new FakeItems();
  items.records = [
    { t: 'session', harness: 'kimi' },
    { t: 'user', turnId: 't1', user: { id: 'u1' }, hostRev: 1, hostGen: 'g1' },
    { t: 'user', turnId: 't2', user: { id: 'u2' }, hostRev: 2, hostGen: 'g1' },
    { t: 'end', turnId: 't2', hostRev: 3, hostGen: 'g1' },
  ];
  const w = world(fakeHost(), items);
  w.host.reply = { snapshot: { rev: 3 }, patches: [], generation: 'g1', inflight: [] };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(w.emitted, []);
});

test('a chat let go of while its transcript is written says no turn is running', async () => {
  const items = new FakeItems();
  items.records = [
    { t: 'session', harness: 'kimi' },
    { t: 'user', turnId: 't1', user: { id: 'u' }, hostRev: 1, hostGen: 'g1' },
  ];
  const w = world(fakeHost(), items);
  items.flush = async () => void w.chats.unfollow(CHAT);
  w.chats.follow(CHAT);
  await tick();
  await tick();
  assert.deepEqual(w.emitted, []);
});
