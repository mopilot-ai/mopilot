// External writes (electron/session/contract/reconcile.cjs, WP5-19): whether another app is running a turn on
// a chat, from its rollout (Codex) or its transcript's tail (Claude), and the silence rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ExternalWrites, codexUnfinished, claudeTailRunning } = require('../electron/session/contract/reconcile.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');

const line = (o: object) => JSON.stringify(o);
const assistant = (stop: string | null) => line({ type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: [] } });
const user = (content: unknown, extra: object = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra });

test('local turn ownership immediately clears external busy and refuses a late external claim on every harness', () => {
  for (const turn of ['running', 'awaitingUser']) {
    const patches: any[] = [];
    const state = new SessionStore({ publish: (patch: any) => patches.push(patch) });
    state.patch('chat', { runningElsewhere: true });
    state.patch('chat', { turn });
    assert.equal(state.get('chat').runningElsewhere, false);
    assert.equal(patches.at(-1).patch.runningElsewhere, false);
    assert.equal(state.patch('chat', { runningElsewhere: true }), false);
    assert.equal(state.get('chat').runningElsewhere, false);
    state.patch('chat', { turn: 'idle', runningElsewhere: true });
    assert.equal(state.get('chat').runningElsewhere, true, 'a real external writer can take over after the local turn');
    state.patch('chat', { turn, runningElsewhere: true });
    assert.equal(state.get('chat').runningElsewhere, false);
  }
});

test('a local turn that starts and finishes during an external read retires that read; a fresh read still works', async () => {
  for (const turn of ['running', 'awaitingUser']) {
    const state = new SessionStore();
    const ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000 });
    let finish!: (value: boolean) => void;
    const old = ext.reconcile('chat', '/file', () => new Promise<boolean>((resolve) => (finish = resolve)));
    state.patch('chat', { turn });
    state.patch('chat', { turn: 'idle' });
    finish(true);
    assert.equal(await old, false);
    assert.equal(state.get('chat').runningElsewhere, false);
    assert.equal(ext.timers.size, 0);
    assert.equal(await ext.reconcile('chat', '/file', () => true), true);
    ext.forget('chat');
  }
});

test('a Codex lease acquired and released during an external read retires its pending native answer', async () => {
  const state = new SessionStore();
  const server = { listeners: new Set(), proc: {}, start() {}, send() {} };
  const adapter = new CodexAdapter({ server, state, nativeOf: (id: string) => ({ kind: 'codex', id }) });
  const ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000 });
  let finish!: (value: any) => void;
  adapter.request = () => new Promise((resolve) => (finish = resolve));
  const old = ext.reconcile('chat', '/file', () => adapter.runningElsewhere('chat'));
  adapter.hold('chat');
  adapter.drop('chat', 'released');
  finish({ data: [{ status: 'inProgress' }] });
  assert.equal(await old, false);
  assert.equal(state.get('chat').runningElsewhere, false);
  assert.equal(ext.timers.size, 0);
});

test('a standalone Codex adapter without session state still reads real external work', async () => {
  const server = { listeners: new Set(), proc: {}, start() {}, send() {} };
  const adapter = new CodexAdapter({ server });
  adapter.request = async () => ({ data: [{ status: 'inProgress' }] });
  assert.equal(await adapter.runningElsewhere('thread'), true);
  adapter.request = async () => ({ data: [{ status: 'completed' }] });
  assert.equal(await adapter.runningElsewhere('thread'), false);
  for (const reply of [undefined, {}, { data: [] }]) {
    adapter.request = async () => reply;
    assert.equal(await adapter.runningElsewhere('thread'), false);
  }
});

test('a silence callback from before a complete local turn cannot infer an external writer from its fresh writes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = new SessionStore();
  let probes = 0;
  const ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000, silentMs: 1000 });
  await ext.reconcile('chat', '/file', () => (probes++, true));
  state.patch('chat', { turn: 'running' });
  state.patch('chat', { turn: 'idle' });
  t.mock.timers.tick(1100);
  await Promise.resolve();
  assert.equal(probes, 1);
  assert.equal(state.get('chat').runningElsewhere, false);
  assert.equal(ext.timers.size, 0);
});

test("a Claude transcript's tail is mid-turn after a prompt, a tool result or a tool call; done after end_turn", () => {
  assert.equal(claudeTailRunning([user('hi')]), true);
  assert.equal(claudeTailRunning([user('hi'), assistant('tool_use')]), true);
  assert.equal(claudeTailRunning([user('hi'), assistant('tool_use'), user([{ type: 'tool_result' }])]), true);
  assert.equal(claudeTailRunning([user('hi'), assistant('end_turn')]), false);
  // records that aren't the conversation, a meta line and a sub-agent's lines don't count
  assert.equal(
    claudeTailRunning([
      user('hi'),
      assistant('end_turn'),
      line({ type: 'custom-title', customTitle: 'x' }),
      user('<local-command-stdout>', { isMeta: true }),
    ]),
    false,
  );
  assert.equal(
    claudeTailRunning([user('hi'), assistant('end_turn'), line({ type: 'assistant', isSidechain: true, message: { stop_reason: null } })]),
    false,
  );
  assert.equal(claudeTailRunning(['not json', '']), false);
});

test("a turn the user stopped ends with the CLI's interrupt record, which is not another app's turn running", () => {
  const stopped = [user('hi'), assistant('tool_use'), user([{ type: 'tool_result', is_error: true }])];
  // Stop during a tool call: the interrupt marker closes the turn (text block or plain string)
  assert.equal(claudeTailRunning([...stopped, user([{ type: 'text', text: '[Request interrupted by user for tool use]' }])]), false);
  assert.equal(claudeTailRunning([user('hi'), assistant(null), user('[Request interrupted by user]')]), false);
  // before the marker is written the tail still reads as mid-turn, and a prompt after it starts a turn again
  assert.equal(claudeTailRunning(stopped), true);
  assert.equal(claudeTailRunning([...stopped, user('[Request interrupted by user for tool use]'), user('try again')]), true);
  // text that only mentions an interruption is a prompt
  assert.equal(claudeTailRunning([user('the user said [Request interrupted by user] earlier')]), true);
});

test("the CLI's own task notification is not a prompt, so the moment before it answers is not another app's turn", () => {
  const note = '<task-notification>\n<task-id>b1</task-id>\n</task-notification>';
  // a finished turn followed by only the notification (string or text-block content): nobody is running a turn
  assert.equal(claudeTailRunning([user('hi'), assistant('end_turn'), user(note)]), false);
  assert.equal(claudeTailRunning([user('hi'), assistant('end_turn'), user([{ type: 'text', text: `  ${note}` }])]), false);
  // once the answer starts without ending, it is mid-turn again; a person's prompt after it still counts
  assert.equal(claudeTailRunning([user(note), assistant('tool_use')]), true);
  assert.equal(claudeTailRunning([user('hi'), assistant('end_turn'), user(note), user('and then?')]), true);
  // content with no text at all is an ordinary user record
  assert.equal(claudeTailRunning([user([{ type: 'image' }])]), true);
  assert.equal(claudeTailRunning([line({ type: 'user', message: { role: 'user' } })]), true);
});

test('a Codex turn on disk is unfinished while in progress, or interrupted with no end', () => {
  assert.equal(codexUnfinished({ status: 'inProgress' }), true);
  assert.equal(codexUnfinished({ status: 'interrupted', completedAt: null, durationMs: null }), true);
  assert.equal(codexUnfinished({ status: 'interrupted', completedAt: 5, durationMs: 3 }), false);
  assert.equal(codexUnfinished({ status: 'completed', completedAt: 5 }), false);
});

test('reconcile: running while the file is fresh, not once it went quiet; forgetting clears it', async () => {
  const state = new SessionStore();
  let now = 100_000;
  let mtime = 99_000;
  const ext = new ExternalWrites({ state, now: () => now, mtime: () => mtime, silentMs: 60_000 });
  assert.equal(await ext.reconcile('c1', '/f', async () => true), true);
  assert.equal(state.get('c1').runningElsewhere, true);
  // the writer finished
  assert.equal(await ext.reconcile('c1', '/f', async () => false), false);
  assert.equal(state.get('c1').runningElsewhere, false);
  // an open turn whose writer has been silent for a minute isn't running
  now = 200_000;
  assert.equal(await ext.reconcile('c1', '/f', async () => true), false);
  mtime = 199_000;
  await ext.reconcile('c1', '/f', async () => true);
  ext.forget('c1');
  assert.equal(state.get('c1').runningElsewhere, false);
  // a failed read is not "running"
  assert.equal(await ext.reconcile('c2', '/f', async () => Promise.reject(new Error('x'))), false);
});

test("the Codex adapter: a thread it holds or runs is never another app's; one with an open turn on disk is", async () => {
  const turns: Record<string, any[]> = { t1: [{ id: 'a', status: 'inProgress' }], t2: [{ id: 'b', status: 'completed', completedAt: 1 }] };
  const server = {
    listeners: new Set<(e: any) => void>(),
    proc: {},
    start() {},
    send(m: any) {
      if (m.id == null) return;
      const result =
        m.method === 'initialize'
          ? {}
          : m.method === 'thread/turns/list'
            ? { data: turns[m.params.threadId] ?? [] }
            : m.method === 'thread/resume'
              ? { thread: { id: m.params.threadId } }
              : {};
      setImmediate(() => [...server.listeners].forEach((l) => l({ kind: 'message', msg: { id: m.id, result } })));
    },
  };
  const state = new SessionStore();
  const a = new CodexAdapter({ server, state, nativeOf: (c: string) => ({ kind: 'codex', id: c }) });
  assert.equal(await a.runningElsewhere('t1'), true);
  assert.equal(await a.runningElsewhere('t2'), false);
  state.patch('t1', { runningElsewhere: true });
  // Sage loads it to write: then it is Sage's, and the flag goes
  await a.ensureResumed('t1');
  assert.equal(state.get('t1').runningElsewhere, false);
  assert.equal(await a.runningElsewhere('t1'), false);
});

test('malformed text fields cannot break external-writer reconciliation', () => {
  const content = [
    { type: 'text', text: 42 },
    { type: 'text', text: '<task-notification>done</task-notification>' },
  ];
  assert.equal(claudeTailRunning([user('hi'), assistant('end_turn'), user(content)]), false);
  const prompt = [
    { type: 'text', text: {} },
    { type: 'text', text: 'A real prompt' },
  ];
  assert.equal(claudeTailRunning([user(prompt)]), true);
});

test('forgetting a followed chat invalidates its pending external-writer read', async () => {
  const state = new SessionStore();
  state.get('chat');
  const ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000 });
  let finish!: (on: boolean) => void;
  const pending = ext.reconcile('chat', '/f', () => new Promise<boolean>((r) => (finish = r)));
  ext.forget('chat');
  finish(true);
  assert.equal(await pending, false);
  assert.equal(state.get('chat').runningElsewhere, false);
  assert.equal(ext.timers.has('chat'), false);
});

test('an older external-writer read cannot replace a newer check for the same chat', async () => {
  const state = new SessionStore();
  state.get('chat');
  const ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000 });
  let finish!: (on: boolean) => void;
  const pending = ext.reconcile('chat', '/old', () => new Promise<boolean>((r) => (finish = r)));
  await ext.reconcile('chat', '/new', async () => false);
  finish(true);
  assert.equal(await pending, false);
  assert.equal(state.get('chat').runningElsewhere, false);
  assert.equal(ext.timers.has('chat'), false);
});

test('the Codex external-writer read rechecks whether MoPilot took over while the native reply was pending', async () => {
  for (const owner of ['lease', 'native-turn', 'running', 'awaitingUser']) {
    const state = new SessionStore();
    const server = { listeners: new Set(), proc: {}, start() {}, send() {} };
    const a = new CodexAdapter({ server, state, nativeOf: (c: string) => ({ kind: 'codex', id: c }), chatOf: () => 'chat' });
    let finish!: (r: any) => void;
    a.request = () => new Promise((r) => (finish = r));
    const pending = a.runningElsewhere('native');
    if (owner === 'lease') a.leases.set('native', {});
    else if (owner === 'native-turn') a.running.add('native');
    else state.patch('chat', { turn: owner });
    finish({ data: [{ status: 'inProgress' }] });
    assert.equal(await pending, false);
  }
});

test('an obsolete failed read cannot turn off a newer live read or replace its silence timer', async (t) => {
  const state = new SessionStore();
  const ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000 });
  t.after(() => ext.forget('chat'));
  let fail!: (e: Error) => void;
  const pending = ext.reconcile('chat', '/old', () => new Promise<boolean>((_, r) => (fail = r)));
  await ext.reconcile('chat', '/new', async () => true);
  const timer = ext.timers.get('chat');
  fail(new Error('old file disappeared'));
  assert.equal(await pending, false);
  assert.equal(state.get('chat').runningElsewhere, true);
  assert.equal(ext.timers.get('chat'), timer);
});

test('a writer that goes silent while its native state is being read cannot publish as running', async () => {
  const state = new SessionStore();
  let now = 1000;
  const ext = new ExternalWrites({ state, now: () => now, mtime: () => 1000, silentMs: 100 });
  let finish!: (on: boolean) => void;
  const pending = ext.reconcile('chat', '/f', () => new Promise<boolean>((r) => (finish = r)));
  now = 1100;
  finish(true);
  assert.equal(await pending, false);
  assert.equal(state.get('chat').runningElsewhere, false);
  assert.equal(ext.timers.size, 0);
  assert.equal(ext.checks.size, 0);
});

test('a silence timer rechecks current state and releases its check when the writer finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = new SessionStore();
  let now = 1000;
  let on = true;
  const ext = new ExternalWrites({ state, now: () => now, mtime: () => now, silentMs: 1000 });
  await ext.reconcile('chat', '/f', async () => on);
  assert.equal(ext.checks.size, 1);
  on = false;
  now = 2100;
  t.mock.timers.tick(1100);
  await Promise.resolve();
  assert.equal(state.get('chat').runningElsewhere, false);
  assert.equal(ext.timers.size, 0);
  assert.equal(ext.checks.size, 0);
});

test('forgetting during state publication cannot install a new silence timer', async () => {
  let ext: any;
  const state = new SessionStore({
    publish: (p: any) => {
      if (p.patch.runningElsewhere === true) ext.forget(p.chatId);
    },
  });
  ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000 });
  assert.equal(await ext.reconcile('chat', '/f', async () => true), false);
  assert.equal(state.get('chat').runningElsewhere, false);
  assert.equal(ext.timers.size, 0);
  assert.equal(ext.checks.size, 0);
});

test('a local turn starting after a synchronous Claude-style tail read cannot be published as another writer', async () => {
  for (const turn of ['running', 'awaitingUser']) {
    const state = new SessionStore();
    const ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000 });
    const pending = ext.reconcile('chat', '/f', () => true);
    state.patch('chat', { turn });
    assert.equal(await pending, false);
    assert.equal(state.get('chat').runningElsewhere, false);
    assert.equal(ext.timers.size, 0);
  }
});

test('a chat already running locally clears external activity without reading another writer', async () => {
  const state = new SessionStore();
  state.patch('chat', { turn: 'running', runningElsewhere: true });
  const ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000 });
  let reads = 0;
  assert.equal(await ext.reconcile('chat', '/f', () => (++reads, true)), false);
  assert.equal(reads, 0);
  assert.equal(state.get('chat').runningElsewhere, false);
  assert.equal(ext.checks.size, 0);
});

test('fresh file writes during a pending native read keep the writer live with the new silence deadline', async (t) => {
  const state = new SessionStore();
  let now = 1000;
  let mtime = 1000;
  const ext = new ExternalWrites({ state, now: () => now, mtime: () => mtime, silentMs: 100 });
  t.after(() => ext.forget('chat'));
  let finish!: (on: boolean) => void;
  const pending = ext.reconcile('chat', '/f', () => new Promise<boolean>((r) => (finish = r)));
  now = 1200;
  mtime = 1200;
  finish(true);
  assert.equal(await pending, true);
  assert.equal(state.get('chat').runningElsewhere, true);
  assert.equal(ext.timers.size, 1);
});

test('source ownership rejects an old native read after a real chat switches harness', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new SessionStore();
  const chats = new ChatsStore(path.join(dir, 'threads'));
  const controller = new ChatController({ state, chats, codex: {}, claudeTurns: {} });
  chats.ensure('root');
  state.get('root');
  const ext = new ExternalWrites({
    state,
    now: () => 1000,
    mtime: () => 1000,
    isCurrent: (id: string, source: any) => controller.isCurrentSource(id, source),
  });
  t.after(() => ext.forget('root'));
  let finish!: (on: boolean) => void;
  const pending = ext.reconcile('root', '/old', () => new Promise<boolean>((r) => (finish = r)), { kind: 'codex', key: 'root' });
  chats.setSegments('root', [
    { harness: 'codex', nativeId: 'root', start: 0, count: 1 },
    { harness: 'claude', nativeId: 'claude:new', start: 1, count: null },
  ]);
  controller.invalidate();
  finish(true);
  assert.equal(await pending, false);
  assert.equal(state.get('root').runningElsewhere, false);
  assert.equal(ext.timers.size, 0);
});

test('old-source reads and forgetting cannot replace the selected source flag or timer', async (t) => {
  const state = new SessionStore();
  const old = { kind: 'codex', key: 'old' };
  const current = { kind: 'claude', key: 'new' };
  const ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000, isCurrent: (_id: string, s: any) => s.key === current.key });
  t.after(() => ext.forget('chat'));
  await ext.reconcile('chat', '/new', async () => true, current);
  const timer = ext.timers.get('chat');
  let reads = 0;
  assert.equal(await ext.reconcile('chat', '/old', () => (++reads, true), old), false);
  ext.forget('chat', old);
  assert.equal(reads, 0);
  assert.equal(state.get('chat').runningElsewhere, true);
  assert.equal(ext.timers.get('chat'), timer);
});

test('silence timers retain native ownership and drop old activity after a session switch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = new SessionStore();
  const source = { kind: 'claude', key: 'old' };
  let selected = true;
  let reads = 0;
  const ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000, silentMs: 1000, isCurrent: () => selected });
  await ext.reconcile('chat', '/old', () => (++reads, true), source);
  selected = false;
  t.mock.timers.tick(1100);
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(state.get('chat').runningElsewhere, false);
  assert.equal(ext.timers.size, 0);
  assert.equal(ext.checks.size, 0);
});

test('fileless readers and optional source callbacks retain unscoped compatibility', async (t) => {
  const state = new SessionStore();
  let now = 1000;
  const ext = new ExternalWrites({ state, now: () => now, silentMs: 100 });
  t.after(() => ext.forget('chat'));
  let finish!: (on: boolean) => void;
  const pending = ext.reconcile('chat', null, () => new Promise<boolean>((r) => (finish = r)), { kind: 'codex', key: 'native' });
  now = 1200;
  finish(true);
  assert.equal(await pending, true);
  ext.forget('chat', { kind: 'codex', key: 'native' });
  assert.equal(state.get('chat').runningElsewhere, false);
  await ext.reconcile('chat', null, () => true);
  ext.forget('chat', { kind: 'codex', key: 'native' });
  assert.equal(ext.checks.size, 0);
});

test('a source switch during publication cancels the old-source silence timer', async () => {
  let selected = true;
  const state = new SessionStore({
    publish: (p: any) => {
      if (p.patch.runningElsewhere === true) selected = false;
    },
  });
  const ext = new ExternalWrites({ state, now: () => 1000, mtime: () => 1000, isCurrent: () => selected });
  assert.equal(await ext.reconcile('chat', '/old', () => true, { kind: 'codex', key: 'old' }), false);
  assert.equal(state.get('chat').runningElsewhere, false);
  assert.equal(ext.timers.size, 0);
});

test('transcript watchers retain late-bound services through startup and replacement', (t) => {
  const { createTranscriptWatchers } = require('../electron/app/transcriptWatchers.cjs');
  let external: any = null;
  let controller: any = null;
  let codex: any = null;
  const calls: any[] = [];
  const live = {
    get external() {
      return external;
    },
    get controller() {
      assert.ok(controller, 'controller is not read before startup');
      return controller;
    },
    get codex() {
      assert.ok(codex, 'adapter is not read before startup');
      return codex;
    },
  };
  const api = createTranscriptWatchers({ broadcast: () => {}, claude: { ownWrites: () => true }, live });
  assert.equal(api.reconcileClaude('claude:thread', '/not-read'), undefined);
  assert.equal(api.forgetClaude('claude:thread'), undefined);
  api.unwatchRollout('unknown');
  assert.equal(api.rolloutWatchers.size, 0);
  const watcher = { on: () => watcher, close: t.mock.fn() };
  t.mock.method(fs, 'watch', () => watcher);
  external = {
    reconcile: (...args: any[]) => calls.push(['initial', ...args]),
    forget: (...args: any[]) => calls.push(['initial-forget', ...args]),
  };
  controller = { chatOf: (id: string) => `initial:${id}` };
  codex = { runningElsewhere: () => false };
  assert.equal(api.watchRollout('thread', path.join('/tmp', 'sessions', 'thread.jsonl')), true);
  const running = calls[0][3];
  assert.equal(running(), false);
  controller = { chatOf: (id: string) => `replacement:${id}` };
  codex = { runningElsewhere: () => true };
  external = {
    reconcile: (...args: any[]) => calls.push(['replacement', ...args]),
    forget: (...args: any[]) => calls.push(['replacement-forget', ...args]),
  };
  assert.equal(running(), true, 'a retained probe uses the current adapter');
  api.reconcileClaude('claude:thread', '/not-read');
  assert.equal(calls.at(-1)[1], 'replacement:claude:thread');
  assert.equal(calls.at(-1)[3](), false, 'local Claude activity excludes an external writer');
  api.forgetClaude('claude:thread');
  assert.deepEqual(calls.at(-1), ['replacement-forget', 'replacement:claude:thread', { kind: 'claude', key: 'claude:thread' }]);
  api.unwatchRollout('thread');
  assert.equal(watcher.close.mock.callCount(), 1);
  assert.equal(api.rolloutWatchers.size, 0);
  assert.deepEqual(calls.at(-1), ['replacement-forget', 'replacement:thread', { kind: 'codex', key: 'thread' }]);
});
