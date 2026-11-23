// MoMo's Codex app-server (#2308, electron/harness/codexIsolatedServer.cjs): Codex reads the user's AGENTS.md, skills,
// hooks and memories from CODEX_HOME for the whole process, so MoMo's threads run on a second app-server with MoMo's
// own home. Two real AppServers over fake processes: an isolated chat's threads go to MoMo's, initialized and signed in
// as the main one; everything else stays on the main one; its server requests, sign-ins and exit are handled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeCodexSpawn } from './support/codex-harness/fakeCodexProcess.ts';
import { deferred, tick } from './support/async-scenarios.ts';
import { useFakeClock } from './support/ports/clock.ts';
import { createCodexChatStart } from '../host/src/codexChatStart.mjs';

const require = createRequire(import.meta.url);
const { AppServer, CodexAdapter } = require('../electron/harness/codex.cjs');
const { IsolatedServer, PREFIX } = require('../electron/harness/codexIsolatedServer.cjs');
const { ISOLATED_THREAD } = require('../electron/harness/codexIsolation.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await tick();
};
const HOME = '/userData/momo/codex-home';

function rig(o: { login?: () => Promise<any>; prepare?: () => void; owns?: (t: string) => boolean; momo?: any } = {}) {
  let n = 0;
  const main = fakeCodexSpawn('main', {
    initialize: () => ({ userAgent: 'codex_cli_rs/0.162.1' }),
    'thread/start': () => ({ thread: { id: `main-th-${++n}`, cwd: '/w', ephemeral: false } }),
  });
  const momo = fakeCodexSpawn('momo', {
    initialize: () => ({ userAgent: 'codex_cli_rs/0.162.1' }),
    'thread/start': () => ({ thread: { id: `momo-th-${++n}`, cwd: '/momo', ephemeral: false } }),
    'thread/fork': () => ({ thread: { id: `momo-fork-${++n}`, cwd: '/momo', ephemeral: false } }),
    // a run on its threads first confirms the home keeps Codex's shell off (CodexIsolation.shellOff)
    'config/read': () => ({ config: { features: { shell_tool: false, unified_exec: false, view_image: false } } }),
    ...o.momo,
  });
  const server = new AppServer({ spawn: main.spawn, findBin: () => '/bin/codex', env: () => ({ CODEX_HOME: '/Users/me/.codex' }) });
  const prepared: number[] = [];
  const iso = new IsolatedServer({
    main: server,
    server: new AppServer({ spawn: momo.spawn, findBin: () => '/bin/codex', env: () => ({ CODEX_HOME: HOME }) }),
    owns: o.owns ?? (() => false),
    prepare: o.prepare ?? (() => prepared.push(1)),
    login: o.login ?? (async () => ({ type: 'chatgptAuthTokens', accessToken: 'tok', chatgptAccountId: 'acct' })),
  });
  const events: any[] = [];
  server.listeners.add((e: any) => events.push(e));
  const messages = () => events.filter((e) => e.kind === 'message').map((e) => e.msg);
  return { server, iso, main, momo, events, messages, prepared };
}

test('#2308 repro: an isolated chat’s thread runs on an app-server whose CODEX_HOME is MoMo’s, through the real adapter', async () => {
  const r = rig();
  const state = new SessionStore();
  const a = new CodexAdapter({ server: r.server, state, isolated: (chat: string) => chat.startsWith('momo'), probe: null, now: () => 1 });
  r.iso.owns = (threadId: string) => a.isolation.applies({ threadId });
  // a coding chat's thread: the main app-server, the user's own home
  const coding = await a.startThread({ cwd: '/w' });
  assert.match(coding.thread.id, /^main-th-/);
  // MoMo's: the second one, MoMo's home, initialized like the main one and signed in before its first request
  const momo = await a.startThread({ [ISOLATED_THREAD]: true, cwd: '/momo' });
  assert.match(momo.thread.id, /^momo-th-/);
  assert.equal(r.main.calls.length, 1);
  assert.equal(r.main.calls[0].opts.env.CODEX_HOME, '/Users/me/.codex');
  assert.equal(r.momo.calls.length, 1);
  assert.equal(r.momo.calls[0].opts.env.CODEX_HOME, HOME);
  assert.deepEqual(
    r.momo.sent().map((m: any) => m.method),
    ['initialize', 'initialized', 'account/login/start', 'thread/start'],
  );
  assert.deepEqual(r.momo.sent('initialize')[0].params, r.main.sent('initialize')[0].params);
  assert.equal(r.momo.sent('account/login/start')[0].params.accessToken, 'tok');
  assert.equal(r.prepared.length, 1);
  // its turns follow it there; the coding chat's stay on the main one
  const momoChat = 'momo-main';
  a.chatOf = (id: string) => (id === momo.thread.id ? momoChat : id);
  await a.request('turn/start', { threadId: momo.thread.id, input: [] }).catch(() => undefined);
  await a.request('turn/start', { threadId: coding.thread.id, input: [] });
  assert.equal(r.momo.sent('turn/start').length, 1);
  // the check that its shell is off reads MoMo's app-server's config, by the mark, never the main one's (#2139)
  assert.equal(r.momo.sent('config/read').length, 1);
  assert.equal(r.momo.sent('config/read')[0].params.includeLayers, false);
  assert.equal(r.main.sent('turn/start').length, 1);
  assert.equal(r.main.sent('turn/start')[0].params.threadId, coding.thread.id);
  // both processes may use the relay and the tool channels
  assert.deepEqual(r.server.pids(), [r.main.procs[0].pid, r.momo.procs[0].pid]);
  r.server.stop();
});

test('its server requests come back under their own ids, its thread-less notifications stay its own, and sign-ins follow the main one', async () => {
  const r = rig();
  r.server.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'x' } } });
  r.server.send({ id: 2, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  const threadId = r.messages().find((m: any) => m.id === 2).result.thread.id;
  const proc = r.momo.procs[0];
  // a server request from it: its id carries the prefix, and the answer goes back to it with its own id
  proc.say({ id: 7, method: 'item/tool/call', params: { threadId, tool: 't' } });
  proc.say({ id: 'a', method: 'account/chatgptAuthTokens/refresh', params: {} });
  // a notification naming its thread reaches the adapter; one naming none (usage, account) does not
  proc.say({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } });
  proc.say({ method: 'account/rateLimits/updated', params: { rateLimits: {} } });
  await settle();
  const seen = r.messages();
  assert.ok(seen.some((m: any) => m.id === `${PREFIX}1:7` && m.method === 'item/tool/call'));
  assert.ok(seen.some((m: any) => m.id === `${PREFIX}1:"a"`));
  assert.ok(seen.some((m: any) => m.method === 'thread/status/changed'));
  assert.ok(!seen.some((m: any) => m.method === 'account/rateLimits/updated'));
  r.server.send({ id: `${PREFIX}1:7`, result: { ok: true } });
  r.server.send({ id: `${PREFIX}1:"a"`, result: { accessToken: 'new' } });
  // the notification that it was answered names it as the main connection does, so it can't clear a main card 7
  proc.say({ method: 'serverRequest/resolved', params: { threadId, requestId: 7 } });
  await settle();
  assert.deepEqual(r.messages().at(-1).params, { threadId, requestId: `${PREFIX}1:7` });
  assert.deepEqual(
    proc.lines.filter((m: any) => !m.method).map((m: any) => m.id),
    [7, 'a'],
  );
  // an answer to the main one's own server request stays there
  r.server.send({ id: 3, result: {} });
  r.server.send({ id: 'other', result: {} });
  assert.equal(proc.lines.filter((m: any) => !m.method).length, 2);
  // the main one signs in to another account's tokens: so does this one, its answer kept to itself; a browser
  // sign-in or an API key stays the main one's (Codex would keep them in MoMo's home)
  r.server.send({ id: 4, method: 'account/login/start', params: { type: 'chatgptAuthTokens', accessToken: 'tok2' } });
  r.server.send({ id: 6, method: 'account/login/start', params: { type: 'chatgpt' } });
  r.server.send({ id: 8, method: 'account/login/start', params: { type: 'apiKey', apiKey: 'sk' } });
  r.server.send({ id: 5, method: 'account/logout', params: {} });
  await settle();
  assert.deepEqual(
    r.momo.sent('account/login/start').map((m: any) => m.params.accessToken),
    ['tok', 'tok2'],
  );
  assert.equal(r.momo.sent('account/logout').length, 1);
  assert.equal(r.main.sent('account/login/start').length, 3);
  assert.ok(!r.messages().some((m: any) => typeof m.id === 'string' && m.id.startsWith('momo-own:')));
  // notifications from the main connection stay there
  r.server.send({ method: 'initialized' });
  assert.equal(r.main.sent('initialized').length, 1);
  r.server.stop();
});

test('a thread an isolated chat already had (after a restart) resumes there, and a fork of it stays there', async () => {
  const r = rig({ owns: (t) => t === 'old-momo' });
  r.server.send({ id: 1, method: 'initialize', params: {} });
  // no sign-in before the accounts open, or none chosen: it starts signed out
  r.iso.login = async () => null;
  r.server.send({ id: 2, method: 'thread/resume', params: { threadId: 'old-momo' } });
  await settle();
  assert.deepEqual(
    r.momo.sent().map((m: any) => m.method),
    ['initialize', 'initialized', 'thread/resume'],
  );
  assert.equal(r.iso.holds('old-momo'), true);
  r.server.send({ id: 3, method: 'thread/fork', params: { threadId: 'old-momo' } });
  await settle();
  const fork = r.messages().find((m: any) => m.id === 3).result.thread.id;
  assert.equal(r.iso.holds(fork), true);
  // a thread it started that Codex says it opened (thread/started) is its too; one it closed is not
  r.momo.procs[0].say({ method: 'thread/started', params: { thread: { id: 'seen-th' } } });
  r.momo.procs[0].say({ method: 'thread/closed', params: { threadId: fork } });
  await settle();
  assert.equal(r.iso.holds('seen-th'), true);
  assert.equal(r.iso.holds(fork), false);
  assert.equal(r.iso.holds(undefined), false);
  // a request it refuses passes its error on, and tracks nothing
  r.momo.procs[0].lines.length = 0;
  r.server.send({ id: 4, method: 'thread/resume', params: { threadId: 'old-momo', bad: true } });
  assert.equal(r.server.isolated.pidFor({ threadId: 'old-momo' }), r.momo.procs[0].pid);
  assert.equal(r.server.isolated.pidFor({ threadId: 'coding' }), r.main.procs[0].pid);
  r.server.stop();
});

test('a failed start: its sign-in failing still opens it; its home failing fails what waited, and the next request tries again', async () => {
  clearIgnored();
  const r = rig({ login: async () => Promise.reject(new Error('keychain locked')) });
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  assert.ok(r.messages().some((m: any) => m.id === 2 && m.result));
  assert.ok(recentIgnored().some((x: any) => /start MoMo's Codex/.test(x.context)));
  r.server.stop();

  let fail = true;
  const b = rig({
    prepare: () => {
      if (fail) throw new Error('disk full');
    },
  });
  b.server.send({ id: 1, method: 'initialize', params: {} });
  b.server.send({ id: 2, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  b.server.send({ id: `${PREFIX}0:9`, result: {} });
  await settle();
  const failed = b.messages().find((m: any) => m.id === 2);
  assert.equal(failed.error.message, "Couldn't start MoMo's Codex: disk full");
  assert.equal(b.momo.procs.length, 0);
  fail = false;
  b.server.send({ id: 3, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  assert.ok(b.messages().some((m: any) => m.id === 3 && m.result));
  b.server.stop();

  // an initialize it refuses: noted, and what waited still goes
  const c = rig({
    momo: {
      initialize: () => {
        throw new Error('Already initialized');
      },
    },
  });
  c.server.send({ id: 1, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  // the main one never initialized here: the default params
  assert.deepEqual(c.momo.sent('initialize')[0].params, {});
  assert.ok(c.messages().some((m: any) => m.id === 1 && m.result));
  c.server.stop();
});

test('it exits alone: its open requests fail, its running turns end failed, its threads close, and the next request starts it again', async () => {
  const r = rig({ momo: { 'turn/start': () => undefined } });
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  const threadId = r.messages().find((m: any) => m.id === 2).result.thread.id;
  r.server.send({ id: 3, method: 'turn/start', params: { threadId } });
  r.momo.procs[0].say({ method: 'turn/started', params: { threadId, turn: { id: 'turn-1' } } });
  await settle();
  // main's handlers (the accounts) read what it tells as they read its own messages
  const heard: any[] = [];
  const swallow = r.server.intercepts.add((m: any) => (heard.push(m.method ?? m.id), m.method === 'thread/closed'));
  r.momo.procs[0].emit('exit', 1, null);
  await settle();
  // one a handler takes is not told again
  assert.deepEqual(heard, [3, 'turn/completed', 'thread/closed']);
  assert.ok(!r.messages().some((m: any) => m.method === 'thread/closed'));
  swallow();
  const told = r.messages().slice(-2);
  assert.deepEqual(told, [
    { id: 3, error: { code: -1, message: 'Codex app-server exited' } },
    {
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-1', status: 'failed', error: { message: 'Codex app-server exited' } } },
    },
  ]);
  // the main one runs on, and never heard an exit
  assert.ok(!r.events.some((e) => e.kind === 'exit'));
  assert.equal(r.main.procs[0].kills, 0);
  // a turn that ended before the exit is not ended again
  r.server.send({ id: 4, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  assert.equal(r.momo.procs.length, 2);
  assert.equal(r.prepared.length, 2);
  const again = r.messages().find((m: any) => m.id === 4).result.thread.id;
  r.momo.procs[1].say({ method: 'turn/started', params: { threadId: again, turn: { id: 't2' } } });
  r.momo.procs[1].say({ method: 'turn/completed', params: { threadId: again, turn: { id: 't2' } } });
  await settle();
  const before = r.messages().length;
  r.momo.procs[1].emit('error', new Error('spawn failed'));
  r.momo.procs[1].pid = undefined;
  r.momo.procs[1].emit('error', new Error('spawn failed'));
  await settle();
  const after = r.messages().slice(before);
  assert.ok(!after.some((m: any) => m.method === 'turn/completed'));
  r.server.stop();
});

test('it goes with the main one: a main exit or stop ends it too, and tells nothing of its own', async () => {
  const r = rig();
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  const before = r.messages().length;
  r.main.procs[0].emit('exit', 1, null);
  await settle();
  assert.equal(r.momo.procs[0].kills > 0, true);
  assert.equal(r.messages().length, before);
  assert.ok(r.events.some((e) => e.kind === 'exit'));
  assert.equal(r.iso.holds(r.messages().find((m: any) => m.id === 2).result.thread.id), false);
  // a stop with it running: both stop
  r.server.send({ id: 3, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  r.server.stop();
  assert.equal(r.momo.procs[1].kills > 0, true);
  // nothing malformed reaches it
  assert.equal(r.iso.take(null), false);
  assert.equal(r.iso.take('x'), false);
  // a request with no params is the main one's
  assert.equal(r.iso.take({ id: 9, method: 'model/list' }), false);
});

test('an isolated handshake that stops answering ends its lane and the next request starts a fresh one', async (t) => {
  const clock = useFakeClock(t);
  let initialize = 0;
  const r = rig({ momo: { initialize: () => (++initialize === 1 ? undefined : {}) } });
  t.after(() => r.server.stop());
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  assert.equal(r.iso.busy(), true);
  clock.advance(30_000);
  await settle();
  assert.equal(r.iso.busy(), false);
  assert.equal(r.momo.procs[0].kills, 1);
  assert.ok(r.messages().some((m: any) => m.id === 2 && m.error));

  r.server.send({ id: 3, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  assert.equal(r.momo.procs.length, 2);
  assert.ok(r.messages().some((m: any) => m.id === 3 && m.result));
  assert.equal(r.main.procs[0].kills, 0);
});

test('a lane’s earlier setup deadline still leaves the Host side fork retryable', async (t) => {
  const clock = useFakeClock(t);
  let initialize = 0;
  const r = rig({ momo: { initialize: () => (++initialize === 1 ? undefined : {}) } });
  t.after(() => r.server.stop());
  const adapter = new CodexAdapter({ server: r.server, probe: null });
  await adapter.initialize();
  r.iso.ensure();
  clock.advance(1_000);
  const chats = { records: new Map(), names: () => false, record: (id: string) => ({ id, meta: {} }), commit: () => true };
  const prepare = createCodexChatStart(adapter as any, { chats, controller: () => ({ invalidate() {} }) } as any, () => ({
    [ISOLATED_THREAD]: true,
  }));
  const request = { chatId: 'side', cwd: '/w', source: { chatId: 'parent', id: 'native-parent', binding: 'source' } };
  const refused = assert.rejects(prepare(request), { code: 'side_chat_fork_timeout' });
  await settle();
  assert.equal(r.iso.busy(), true);
  clock.advance(29_000);
  await refused;
  assert.deepEqual(r.momo.sent('thread/fork', 0), []);
  assert.equal(await prepare(request), true);
  assert.equal(r.momo.sent('thread/fork', 1).length, 1);
});

test('a sign-in still being read when its lane times out cannot reach the next process', async (t) => {
  const clock = useFakeClock(t);
  const old = deferred<object>();
  const r = rig({ login: () => old.promise });
  t.after(() => r.server.stop());
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  assert.equal(r.momo.sent('initialized', 0).length, 1);
  clock.advance(30_000);
  assert.ok(r.messages().some((m: any) => m.id === 2 && m.error));
  r.iso.login = async () => null;
  r.server.send({ id: 3, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  old.resolve({ type: 'apiKey', apiKey: 'expired-key' });
  await settle();
  assert.deepEqual(r.momo.sent('account/login/start', 1), []);
  assert.ok(r.messages().some((m: any) => m.id === 3 && m.result));
});

test('a late handshake continuation cannot initialize a retired process', async (t) => {
  const r = rig({ momo: { initialize: () => undefined } });
  t.after(() => r.server.stop());
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  r.momo.procs[0].say({ id: r.momo.sent('initialize', 0)[0].id, result: {} });
  r.iso.recycle();
  await settle();
  assert.deepEqual(r.momo.sent('initialized', 0), []);
});

test('an answer meant for its earlier process reaches no one, and a sign-in that came while it started wins over the one it read', async () => {
  let release: (v: any) => void = () => undefined;
  const r = rig({ login: () => new Promise((resolve) => (release = resolve)) });
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  // the account switched while it read the old one's tokens: the switch goes out, the stale one never does
  r.server.send({ id: 3, method: 'account/login/start', params: { type: 'chatgptAuthTokens', accessToken: 'new' } });
  release({ type: 'chatgptAuthTokens', accessToken: 'old' });
  await settle();
  assert.deepEqual(
    r.momo.sent('account/login/start').map((m: any) => m.params.accessToken),
    ['new'],
  );
  assert.ok(r.messages().some((m: any) => m.id === 2 && m.result));
  // it exits and starts again: an answer to the first process's request 4 is dropped
  r.momo.procs[0].emit('exit', 1, null);
  await settle();
  r.iso.login = async () => null;
  r.server.send({ id: 5, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  await settle();
  const second = r.momo.procs[1];
  r.server.send({ id: `${PREFIX}1:4`, result: {} });
  r.server.send({ id: `${PREFIX}2:4`, result: {} });
  assert.deepEqual(
    second.lines.filter((m: any) => !m.method).map((m: any) => m.id),
    [4],
  );
  r.server.stop();
});

test('it exits before it answered initialize: what waited fails, nothing is sent to the next process for it, and pidFor is the main one’s alone', async () => {
  const r = rig({ momo: { initialize: () => undefined } });
  // the main app-server alone: its own pid for every thread
  const lone = new AppServer({ spawn: fakeCodexSpawn('main').spawn, findBin: () => '/bin/codex' });
  lone.start();
  assert.equal(lone.pidFor({ threadId: 'x' }), lone.proc.pid);
  lone.stop();
  r.server.send({ id: 1, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  assert.equal(r.server.pidFor({ [ISOLATED_THREAD]: true }), r.momo.procs[0].pid);
  await settle();
  // a notification with no params names no thread: not told
  r.momo.procs[0].say({ method: 'configWarning' });
  r.momo.procs[0].emit('exit', 1, null);
  await settle();
  assert.deepEqual(r.messages(), [{ id: 1, error: { code: -1, message: 'Codex app-server exited' } }]);
  assert.deepEqual(
    r.momo.sent().map((m: any) => m.method),
    ['initialize'],
  );
  r.server.stop();
});
