// A chat's automatic title, /goal and background tasks on the Host's stream (host/src/chatState.mjs, the state lane of host/src/stream.mjs) and in the app (electron/host/remoteChats.cjs). A: what the Host tells; W: replay after a reconnect changes nothing; B: the gate; I: a title the person gave is kept.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { chatStateOf } from '../host/src/chatState.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
import { createStreamHub } from '../host/src/stream.mjs';
import { FEATURES, helloParams } from '../shared/host/schema.mjs';
import { parseFrame } from '../shared/host/stream.mjs';
import { STREAM2_FEATURE, withoutStream2 } from '../shared/host/stream2.mjs';
import { hostWorld, onlineRemote, tick as wireTick } from './support/host-wire-kit.ts';
import { CHAT, FakeItems, createRemoteChats, end, fakeHost, start, text, tick, world } from './support/host/remoteChatsKit.ts';

const quiet = { report: () => undefined };
const META = { claudeCode: { parentToolUseId: 'tu-agent' } };
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-chatstate-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

test('the mode a chat is in and whether it plans make a state patch; a mode the Host does not take, or a plan that is not a boolean, makes none', () => {
  const of = (patch: object) => chatStateOf({ kind: 'state', chatId: 'c', patch });
  assert.deepEqual(of({ permission: 'plan', plan: true }), { chatId: 'c', patch: { permission: 'plan', plan: true } });
  assert.deepEqual(of({ permission: 'read-only', plan: false }), { chatId: 'c', patch: { permission: 'read-only', plan: false } });
  assert.deepEqual(of({ plan: false }), { chatId: 'c', patch: { plan: false } });
  assert.equal(of({ permission: 'bogus' }), null);
  assert.equal(of({ plan: null, permission: 7 }), null);
});

test('A: a title, a goal and the tasks make a state patch; anything else, or a chat with no id, makes none', () => {
  assert.deepEqual(chatStateOf({ kind: 'threadName', chatId: 'c', name: 'Fix login', provisional: 'fix the lo' }), {
    chatId: 'c',
    patch: { title: { name: 'Fix login', provisional: 'fix the lo' } },
  });
  assert.deepEqual(chatStateOf({ kind: 'threadName', key: 'k', name: 'x' }), {
    chatId: 'k',
    patch: { title: { name: 'x', provisional: null } },
  });
  // a name the person gave says so (and only exactly `true` does), so a client keeps it as theirs
  assert.deepEqual(chatStateOf({ kind: 'threadName', chatId: 'c', name: 'Mine', named: true }), {
    chatId: 'c',
    patch: { title: { name: 'Mine', provisional: null, named: true } },
  });
  assert.deepEqual(chatStateOf({ kind: 'threadName', chatId: 'c', name: 'Auto', named: 'yes' }), {
    chatId: 'c',
    patch: { title: { name: 'Auto', provisional: null } },
  });
  assert.equal(chatStateOf({ kind: 'threadName', chatId: 'c', name: '  ' }), null);
  assert.equal(chatStateOf({ kind: 'threadName', name: 'x' }), null);
  assert.equal(chatStateOf({ kind: 'turnEnd', chatId: 'c' }), null);
  assert.equal(chatStateOf(null), null);
  assert.equal(chatStateOf({ kind: 'state', chatId: 'c' }), null);
  assert.equal(chatStateOf({ kind: 'state', chatId: 'c', patch: { rev: 3 } }), null);
  assert.deepEqual(chatStateOf({ kind: 'state', chatId: 'c', patch: { goal: null } }), { chatId: 'c', patch: { goal: null } });
  const long = 'x'.repeat(900);
  const tasks = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, summary: long }));
  const out = chatStateOf({ kind: 'state', chatId: 'c', patch: { goal: { objective: long, status: 'active' }, tasks } })!;
  assert.equal((out.patch.goal as any).objective.length, 500);
  assert.deepEqual(
    [(out.patch.tasks as any[]).length, (out.patch.tasks as any[])[0].id, (out.patch.tasks as any[])[0].summary.length],
    [50, 't10', 500],
  );
  assert.equal((chatStateOf({ kind: 'state', chatId: 'c', patch: { tasks: ['plain', null] } })!.patch.tasks as unknown[]).length, 2);
});

test('W: the hub keeps the newest state per chat for a Hello, tells it live without a revision, and a resume gets it too', () => {
  const hub = createStreamHub({ snapshot: () => ({ rev: 1 }), epoch: () => 1 });
  const got: any[] = [];
  const open = (fromRev?: number) => hub.subscribe('c', { fromRev, send: (f) => (got.push(f), true), close: () => undefined });
  hub.state('c', { title: { name: 'A' } });
  hub.state('c', { goal: { status: 'active' } });
  hub.state('c', { title: { name: 'B' } });
  open();
  assert.deepEqual(got[0].chatState, { title: { name: 'B' }, goal: { status: 'active' } });
  assert.equal(got[0].rev, 1);
  hub.state('c', { tasks: [] });
  assert.deepEqual(got.at(-1), { t: 'state', seq: got.at(-1).seq, patch: { tasks: [] } });
  // a reconnect from the same revision is not told the changes again as events: its Hello has the state whole
  got.length = 0;
  open(1);
  assert.deepEqual(got[0].chatState, { title: { name: 'B' }, goal: { status: 'active' }, tasks: [] });
  assert.equal(got.length, 1);
  hub.close('c', 'gone');
});

test('B: the state frame and a Hello’s state parse; one that is not an object is refused; an end without stream2 is told neither', () => {
  assert.deepEqual(parseFrame({ t: 'state', seq: 3, patch: { title: { name: 'x' } } }), {
    t: 'state',
    seq: 3,
    patch: { title: { name: 'x' } },
  });
  // the mode and the plan flag are only more keys of the patch: an end that never reads them parses the frame as before
  assert.deepEqual(parseFrame({ t: 'state', seq: 4, patch: { permission: 'plan', plan: true } }), {
    t: 'state',
    seq: 4,
    patch: { permission: 'plan', plan: true },
  });
  assert.throws(() => parseFrame({ t: 'state', seq: 3, patch: 'x' }), /no patch/);
  const hello = { t: 'hello', seq: 0, rev: 0, epoch: 1, snapshot: null, inFlightEphemeral: [] };
  assert.deepEqual((parseFrame({ ...hello, chatState: { goal: null } }) as any).chatState, { goal: null });
  assert.equal('chatState' in (parseFrame({ ...hello, chatState: 'x' }) as object), false);
  assert.equal('chatState' in (parseFrame(hello) as object), false);
  assert.equal(withoutStream2({ t: 'state', patch: {} }), null);
  const old = withoutStream2({ ...hello, chatState: { goal: null } });
  assert.equal('chatState' in old, false);
});

/** A protocol over a runtime whose bus the test drives; one connection with the given features. */
function protocolWith(features: string[]) {
  const dir = fs.mkdtempSync(path.join(base, 'p-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = {
    host,
    send: async () => ({ turnId: 't' }),
    prepare: async () => undefined,
    permit: () => true,
    familyOf: () => 'claude',
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }) });
  const out: any[] = [];
  const conn = protocol.connection((m: object) => out.push(m));
  let n = 0;
  const ready = conn.call('host.hello', { ...helloParams(), features });
  const call = async (method: string, chatId: string) => (
    await ready, conn.call(method, { chatId, epoch: 1, key: `key-cs-${++n}-00`.padEnd(16, '0') })
  );
  return { host, call, frames: (chatId: string) => out.filter((m) => m.chatId === chatId && m.frame).map((m) => m.frame) };
}

test('A: a title and a state change on the bus are told live and in the next Hello, to an end with stream2 only', async () => {
  const modern = protocolWith([...FEATURES]);
  const older = protocolWith(FEATURES.filter((f: string) => f !== STREAM2_FEATURE));
  for (const p of [modern, older]) {
    await p.call('chat.subscribe', 'claude:c1');
    p.host.emit('event', { kind: 'threadName', chatId: 'claude:c1', name: 'Fix login', provisional: 'fix' });
    p.host.emit('event', { kind: 'state', chatId: 'claude:c1', patch: { goal: { status: 'active', objective: 'ship' } } });
  }
  assert.deepEqual(
    modern
      .frames('claude:c1')
      .filter((f) => f.t === 'state')
      .map((f) => Object.keys(f.patch)),
    [['title'], ['goal']],
  );
  assert.equal(older.frames('claude:c1').filter((f) => f.t === 'state').length, 0);
  // a later subscribe reads the whole state in its Hello (and the older end's has none)
  await modern.call('chat.subscribe', 'claude:c1');
  await older.call('chat.subscribe', 'claude:c1');
  const hello = (p: ReturnType<typeof protocolWith>) =>
    p
      .frames('claude:c1')
      .filter((f) => f.t === 'hello')
      .at(-1);
  assert.deepEqual(Object.keys(hello(modern).chatState).sort(), ['goal', 'title']);
  assert.equal('chatState' in hello(older), false);
});

test('A: the Host’s store changes reach the stream: a goal and background tasks, and nothing for other keys', async () => {
  const dir = fs.mkdtempSync(path.join(base, 's-'));
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: {} });
  const sessions = createHostSessions({ paths, env: {}, runtime });
  try {
    const events: any[] = [];
    const forwarded: any[] = [];
    sessions.events.on('event', (e: any) => (e.kind === 'state' ? events.push(e) : forwarded.push(e)));
    const chatId = 'acp:fake:g1';
    const goal = { status: 'active', objective: 'ship it', createdAt: 1 };
    sessions.state.patch(chatId, { goal });
    sessions.state.patch(chatId, { tasks: [{ id: 'b1', status: 'running' }] });
    sessions.state.patch(chatId, { plan: null });
    // whether the agent plans is a boolean the Host tells (Plan entered by a client or by the agent, and left); a store's null says nothing
    sessions.state.patch(chatId, { plan: true });
    sessions.state.patch(chatId, { plan: false });
    sessions.state.patch(chatId, { promptSuggestion: 'Run the focused test.' });
    runtime.host.emit('event', { kind: 'promptSuggestion', key: chatId, turnId: null, text: 'Raw, unowned prediction' });
    runtime.host.emit('event', { kind: 'update', key: chatId, update: { sessionUpdate: 'agent_message_chunk' } });
    assert.deepEqual(
      forwarded.map((e) => e.kind),
      ['update'],
    );
    sessions.state.step(chatId, 'start', { turnId: 'new', human: true });
    sessions.state.patch(chatId, { pendingSwitch: { harness: 'claude', model: 'opus' } });
    assert.deepEqual(
      events.map((e) => [e.chatId, e.patch]),
      [
        [chatId, { goal }],
        [chatId, { tasks: [{ id: 'b1', status: 'running' }] }],
        [chatId, { plan: true }],
        [chatId, { plan: false }],
        [chatId, { promptSuggestion: 'Run the focused test.' }],
        [chatId, { promptSuggestion: null }],
        [chatId, { pendingSwitch: { harness: 'claude', model: 'opus' } }],
      ],
    );
  } finally {
    sessions.close();
    runtime.close();
  }
});

test('A: the mirror keeps the Host’s title in the transcript and shows its goal and tasks from the session store; telling it again changes nothing', async () => {
  const patched: any[] = [];
  const items = new FakeItems();
  const emitted: any[] = [];
  const host = fakeHost();
  const chats = createRemoteChats({
    items,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: (e: object) => emitted.push(e),
    state: () => ({ patch: (id: string, p: object) => patched.push([id, p]) }),
    now: () => 1000,
    report: () => undefined,
  });
  host.reply = {
    snapshot: { rev: 0, items: [] },
    patches: null,
    generation: 'g1',
    inflight: [],
    chatState: { title: { name: 'Fix login' }, goal: { status: 'active' } },
  };
  chats.follow(CHAT);
  await chats.settled(CHAT);
  assert.deepEqual(
    items.records.filter((r) => r.t === 'title'),
    [{ t: 'title', name: 'Fix login', auto: true, at: 1000 }],
  );
  assert.deepEqual(
    emitted.filter((e) => e.kind === 'threadName').map((e) => [e.chatId, e.name]),
    [[CHAT, 'Fix login']],
  );
  assert.deepEqual(patched, [[CHAT, { goal: { status: 'active' } }]]);
  // a live change, then a reconnect that hands back the same title: the title is written once, the rest is last-write-wins
  host.fire.frame(CHAT, { t: 'state', patch: { tasks: [{ id: 'b1' }], title: { name: 'Fix login' } } });
  await tick();
  await chats.settled(CHAT);
  assert.equal(items.records.filter((r) => r.t === 'title').length, 1);
  assert.deepEqual(patched.at(-1), [CHAT, { tasks: [{ id: 'b1' }] }]);
  // a new title replaces the Host's earlier one; a name the person gave is never replaced
  host.fire.frame(CHAT, { t: 'state', patch: { title: { name: 'Fix the login page' } } });
  await tick();
  await chats.settled(CHAT);
  assert.equal(items.records.filter((r) => r.t === 'title').at(-1).name, 'Fix the login page');
  items.records.push({ t: 'title', name: 'My own name', at: 2000 });
  host.fire.frame(CHAT, { t: 'state', patch: { title: { name: 'Another auto title' } } });
  await tick();
  await chats.settled(CHAT);
  assert.equal(items.records.filter((r) => r.t === 'title').at(-1).name, 'My own name');
  // a name the person gave from another client is theirs here, and replaces the automatic one
  host.fire.frame(CHAT, { t: 'state', patch: { title: { name: 'Their name', provisional: null, named: true } } });
  await tick();
  await chats.settled(CHAT);
  assert.deepEqual(items.records.filter((r) => r.t === 'title').at(-1), { t: 'title', name: 'Their name', at: 1000 });
  // junk is ignored, a chat the store does not hold shows nothing, and a goal cleared on the Host is cleared here
  host.fire.frame(CHAT, { t: 'state', patch: 'junk' });
  host.fire.frame(CHAT, { t: 'state', patch: { goal: null } });
  await tick();
  await chats.settled(CHAT);
  assert.deepEqual(patched.at(-1), [CHAT, { goal: null }]);
  // the mode the Host holds is the chat's here: Plan another client set (or one the agent left), and the mode a send without a pick carries; Plan is never the mode a pick falls back to
  host.fire.frame(CHAT, { t: 'state', patch: { permission: 'plan', plan: true } });
  await tick();
  await chats.settled(CHAT);
  assert.deepEqual(patched.at(-1), [CHAT, { plan: true }]);
  host.fire.frame(CHAT, { t: 'state', patch: { permission: 'read-only', plan: false } });
  await tick();
  await chats.settled(CHAT);
  assert.deepEqual(patched.at(-1), [CHAT, { plan: false, permission: 'read-only' }]);
  // a mode this app does not know, and a plan that is not a boolean, change nothing
  const before = patched.length;
  host.fire.frame(CHAT, { t: 'state', patch: { permission: 'bogus', plan: 'yes' } });
  await tick();
  await chats.settled(CHAT);
  assert.equal(patched.length, before);
  // the Host saying again what it already said (a reconnect's Hello, a resumed thread) is not a change: a Plan the person switched on and has not sent yet is not undone by it
  const replayed = patched.length;
  host.fire.frame(CHAT, { t: 'state', patch: { plan: false } });
  await tick();
  await chats.settled(CHAT);
  assert.equal(patched.length, replayed, 'plan:false said twice shows once');
  host.fire.frame(CHAT, { t: 'state', patch: { plan: true } });
  await tick();
  await chats.settled(CHAT);
  assert.deepEqual(patched.at(-1), [CHAT, { plan: true }], 'a real change is shown');
});

test('W: a subscribe hands back the chat’s state from the Hello, and a catch-up tells it once as a frame before the live ones', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 2 }, patches: null, chatState: { goal: { status: 'active' } } });
  const first = await host.subscribe('a');
  assert.deepEqual(first.chatState, { goal: { status: 'active' } });
  // a Host that names no state gives the subscribe none
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 2 }, patches: null });
  assert.equal('chatState' in (await host.subscribe('b')), false);
  // a durable that skips a revision makes the app subscribe again: the state it brings is told as a frame
  const told: any[] = [];
  host.events.onFrame(({ chatId, frame }: any) => told.push([chatId, frame]));
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 5 }, patches: [], chatState: { title: { name: 'N' } } });
  w.net.last.feed({ event: 'frame', chatId: 'a', frame: { t: 'durable', seq: 9, rev: 9, item: { n: 9 } } });
  await wireTick();
  await wireTick();
  assert.deepEqual(
    told.filter(([, f]) => f.t === 'state'),
    [['a', { t: 'state', patch: { title: { name: 'N' } } }]],
  );
});

test('W: the app restarts with the Host’s Hello and shows the goal at once, whether or not the session store has met the chat yet; with no store the goal waits for the next report', async () => {
  const patched: any[] = [];
  const items = new FakeItems();
  const host = fakeHost();
  host.reply = {
    snapshot: { rev: 0, items: [] },
    patches: null,
    generation: 'g1',
    inflight: [],
    chatState: { goal: { status: 'active' } },
  };
  const chats = createRemoteChats({
    items,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: () => undefined,
    state: () => ({ patch: (id: string, p: object) => patched.push([id, p]) }),
    now: () => 1000,
    report: () => undefined,
  });
  chats.follow(CHAT);
  await chats.settled(CHAT);
  assert.deepEqual(patched, [[CHAT, { goal: { status: 'active' } }]]);
  // no session store yet (the sessions are not up): the goal waits for the next report
  const bare = createRemoteChats({
    items: new FakeItems(),
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: null }),
    emit: () => undefined,
    now: () => 1000,
    report: () => undefined,
  });
  bare.follow(CHAT);
  await bare.settled(CHAT);
});

test('A: a sub-agent’s words are not the handoff’s reply, and a title is read with the transcript’s kind filter when it has one', async () => {
  const w = world();
  w.host.reply = {
    snapshot: {
      rev: 5,
      items: [
        start('t1'),
        text('sub words', 't1', { messageId: 's1', _meta: META }),
        text('the reply', 't1', { messageId: 'm1' }),
        end('t1'),
      ],
    },
    patches: null,
    generation: 'g1',
    inflight: [],
  };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(w.chats.mirror(CHAT)!.items.at(-1), {
    t: 'assistant',
    turnId: 't1',
    text: 'the reply',
    stopReason: 'end_turn',
    error: null,
  });
  // a store that reads the title records alone is asked for those
  const asked: string[][] = [];
  class Kinds extends FakeItems {
    async readKindsAsync(_id: string, kinds: string[]) {
      asked.push(kinds);
      return this.records.filter((r) => kinds.includes(r.t));
    }
  }
  const items = new Kinds();
  const host = fakeHost();
  const emitted: any[] = [];
  const chats = createRemoteChats({
    items,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: null }),
    emit: (e: object) => emitted.push(e),
    now: () => 1000,
    report: () => undefined,
  });
  host.reply = { snapshot: { rev: 0, items: [] }, patches: null, generation: 'g1', inflight: [], chatState: { title: { name: 'Named' } } };
  chats.follow(CHAT);
  await chats.settled(CHAT);
  assert.deepEqual(asked, [['title', 'user']]);
  assert.equal(items.records.filter((r) => r.t === 'title').length, 1);
});

test('W: a live command view that is retracted is let go: a later view of the same key starts over', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const key = 't1:out:c1';
  const head = { turnId: 't1', sessionUpdate: 'tool_output_delta', toolCallId: 'c1' };
  w.host.fire.delta(CHAT, key, { ...head, text: 'a' });
  w.host.fire.frame(CHAT, { t: 'retract', key });
  w.host.fire.delta(CHAT, key, { ...head, text: 'b' });
  await tick();
  assert.deepEqual(
    w.emitted.filter((e) => e.kind === 'update').map((e) => e.update.rawOutput.output),
    ['a', 'b'],
  );
});

test('A: the title event names what the window may replace: the Host’s own provisional title, else the first words cut short', async () => {
  const items = new FakeItems();
  items.records = [
    { t: 'user', turnId: 't0', user: { id: 'u', content: [{ type: 'text', text: 'fix the login page' }, { type: 'image' }] } },
    { t: 'end', turnId: 't0', stopReason: 'end_turn' },
  ];
  const host = fakeHost();
  const emitted: any[] = [];
  const chats = createRemoteChats({
    items,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: null }),
    emit: (e: object) => emitted.push(e),
    now: () => 1000,
    report: () => undefined,
  });
  host.reply = {
    snapshot: { rev: 0, items: [] },
    patches: null,
    generation: 'g1',
    inflight: [],
    chatState: { title: { name: 'Login fix' } },
  };
  chats.follow(CHAT);
  await chats.settled(CHAT);
  host.fire.frame(CHAT, { t: 'state', patch: { title: { name: 'Login page fix', provisional: 'Login fix' } } });
  await tick();
  await chats.settled(CHAT);
  assert.deepEqual(
    emitted.filter((e) => e.kind === 'threadName').map((e) => [e.name, e.provisional]),
    [
      ['Login fix', 'fix the login page'],
      ['Login page fix', 'Login fix'],
    ],
  );
});
