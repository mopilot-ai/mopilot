// electron/harness/routeProcesses.cjs and electron/app/ipc/routes.cjs: each harness's processes for Restart to apply
// (only idle ones restart, only those that started before the change), the kind each adapter answers for, and the IPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  codexProcesses,
  claudeProcesses,
  acpProcesses,
  routeProcessesFor,
  codexChatsBusy,
} = require('../electron/harness/routeProcesses.cjs');

test('Codex: one app-server; it restarts only while idle and started before the change, then every window hears it is back', async () => {
  const log: string[] = [];
  const server: any = { proc: {}, startedAt: 100, stop: () => log.push('stop') };
  const codex: any = { running: new Map(), connect: async () => log.push('connect'), onStatus: (e: any) => log.push(e.kind) };
  let bg = 0;
  let accounts: any = null;
  const p = codexProcesses({ server: () => server, codex: () => codex, background: async () => bg, accounts: () => accounts });
  assert.deepEqual(await p.list(), [{ startedAt: 100, busy: false }]);
  assert.deepEqual(await p.restartIdle(50), { restarted: 0, busy: 0 });
  codex.running.set('t', 1);
  assert.deepEqual(await p.list(), [{ startedAt: 100, busy: true }]);
  assert.deepEqual(await p.restartIdle(200), { restarted: 0, busy: 1 });
  codex.running.clear();
  bg = 1;
  assert.deepEqual(await p.restartIdle(200), { restarted: 0, busy: 1 });
  // a turn that starts while the background terminals are counted keeps the process
  bg = 0;
  const racing = codexProcesses({
    server: () => server,
    codex: () => codex,
    background: async () => (codex.running.set('late', 1), 0),
  });
  assert.deepEqual(await racing.restartIdle(200), { restarted: 0, busy: 1 });
  codex.running.clear();
  assert.deepEqual(log, []);
  assert.deepEqual(await p.restartIdle(200), { restarted: 1, busy: 0 });
  assert.deepEqual(log, ['stop', 'connect', 'ready']);
  // no process yet, or no adapter
  server.proc = null;
  assert.deepEqual(await p.list(), []);
  assert.deepEqual(await p.restartIdle(200), { restarted: 0, busy: 0 });
  // a process whose adapter is gone (main is shutting down) is not busy
  const orphan = codexProcesses({ server: () => ({ proc: {}, startedAt: 2 }), codex: () => null, background: async () => 0 });
  assert.deepEqual(await orphan.list(), [{ startedAt: 2, busy: false }]);
  const bare = codexProcesses({ server: () => null, codex: () => null, background: async () => 0 });
  assert.deepEqual(await bare.list(), []);
  assert.deepEqual(bare.effects(), []);
  // pooling is off only when there are accounts to pool and the relay stayed out
  assert.deepEqual(p.effects(), []);
  accounts = { relaySkipped: true, subscriptions: () => [1] };
  assert.deepEqual(p.effects(), []);
  accounts = { relaySkipped: true, subscriptions: () => [1, 2] };
  assert.deepEqual(p.effects(), ['poolingOff']);
  // an accounts object without the list, or a flag that isn't set to true, turns nothing off
  accounts = { relaySkipped: true };
  assert.deepEqual(p.effects(), []);
  accounts = { relaySkipped: 'yes', subscriptions: () => [1, 2] };
  assert.deepEqual(p.effects(), []);
  const fixed = { proc: {}, startedAt: 1, stop: () => {} };
  const noStatus = codexProcesses({
    server: () => fixed,
    codex: () => ({ running: new Map(), connect: async () => {} }),
    background: async () => 0,
  });
  assert.deepEqual(await noStatus.restartIdle(5), { restarted: 1, busy: 0 });
  // the process went, or another took its place, while the terminals were counted: left alone
  let cur: any = { proc: {}, startedAt: 1, stop: () => assert.fail('stopped') };
  const swapped = codexProcesses({
    server: () => cur,
    codex: () => ({ running: new Map(), connect: async () => {} }),
    background: async () => ((cur = { ...cur }), 0),
  });
  assert.deepEqual(await swapped.restartIdle(5), { restarted: 0, busy: 1 });
  const gone: any = { proc: {}, startedAt: 1, stop: () => assert.fail('stopped') };
  const exited = codexProcesses({
    server: () => gone,
    codex: () => ({ running: new Map(), connect: async () => {} }),
    background: async () => ((gone.proc = null), 0),
  });
  assert.deepEqual(await exited.restartIdle(5), { restarted: 0, busy: 1 });
});

test("Codex chats that wait on the user or run an active goal keep the app-server; other harnesses' chats do not count", async () => {
  const states: Record<string, any> = { a: { turn: 'idle' }, b: { turn: 'idle', goal: { status: 'paused' } }, c: { turn: 'running' } };
  const kinds: Record<string, string> = { a: 'codex', b: 'codex', c: 'claude' };
  // the adapter's own record of b's goal: a window's report of it (states.b.goal) is not what decides (#2759)
  const own: Record<string, string | undefined> = {};
  const sessions = () => ({
    all: () => [...Object.keys(states), 'gone'],
    get: (id: string) => states[id],
    goalStatus: (id: string) => own[id] ?? states[id]?.goal?.status ?? null,
  });
  const controller = () => ({
    ref: (id: string) => {
      if (!kinds[id]) throw new Error('unknown chat');
      return { kind: kinds[id] };
    },
  });
  const busy = codexChatsBusy({ sessions, controller });
  assert.equal(busy(), false);
  states.b.goal.status = 'active';
  assert.equal(busy(), true);
  states.b.goal.status = 'paused';
  own.b = 'active';
  assert.equal(busy(), true, "the adapter's active goal keeps the app-server whatever the window last reported");
  own.b = undefined;
  states.a.turn = 'awaitingUser';
  assert.equal(busy(), true);
  states.a.turn = 'running';
  assert.equal(busy(), true);
  assert.equal(codexChatsBusy({ sessions: () => null, controller: () => null })(), false);
  // the adapter reads it: an active goal between turns keeps the process
  const server: any = { proc: {}, startedAt: 1, stop: () => assert.fail('stopped') };
  const p = codexProcesses({ server: () => server, codex: () => ({ running: new Map() }), background: async () => 0, chatsBusy: busy });
  assert.deepEqual(await p.list(), [{ startedAt: 1, busy: true }]);
  assert.deepEqual(await p.restartIdle(5), { restarted: 0, busy: 1 });
});

test('Claude Code: a CLI per chat; idle ones that started before the change end, the rest are counted', async () => {
  const keep = (extra: any = {}) => ({ keep: false, busy: false, unpersisted: false, perms: new Map(), tasks: {}, sched: {}, ...extra });
  const sessions = new Map<string, any>([
    ['a', keep()],
    ['b', keep({ busy: true })],
    ['c', keep()],
    ['d', keep({ chrome: { holdsPages: () => true } })],
    ['e', keep({ tasks: { live: true } })],
    ['f', keep({ perms: new Map([[1, 1]]) })],
    ['g', keep({ keep: true })],
    ['h', keep({ unpersisted: true })],
    ['untracked', keep()],
  ]);
  const started = new Map<string, number>([
    ['a', 100],
    ['b', 100],
    ['c', 900],
    ['d', 100],
    ['e', 100],
    ['f', 100],
    ['g', 100],
    ['h', 100],
    ['gone', 100],
  ]);
  const retired: string[] = [];
  const p = claudeProcesses({
    sessions: () => sessions,
    started,
    retire: async (key: string) => void retired.push(key),
    keepAlive: (tasks: any) => !!tasks.live,
    now: () => 1,
  });
  const list = await p.list();
  assert.equal(list.length, 8);
  // a process that ended is forgotten
  assert.equal(started.has('gone'), false);
  assert.deepEqual(
    list.map((x: any) => x.busy),
    [false, true, false, true, true, true, true, true],
  );
  assert.deepEqual(await p.restartIdle(500), { restarted: 1, busy: 6 });
  assert.deepEqual(retired, ['a']);
  const dflt = claudeProcesses({ sessions: () => new Map(), started: new Map(), retire: async () => {}, keepAlive: () => false });
  assert.deepEqual(await dflt.list(), []);
});

test('an ACP harness: its one agent restarts only while no chat on it is prompting or opening; its chats are closed first', async () => {
  const killed: string[] = [];
  const closed: string[] = [];
  const agent: any = { harness: 'gemini', startedAt: 100, kill: () => killed.push('gemini') };
  const other: any = { harness: 'qwen', startedAt: 100 };
  const entry = Promise.resolve(agent);
  const host: any = {
    agents: new Map<string, any>([['gemini', entry]]),
    chats: new Map<string, any>([
      ['acp:gemini:1', { agent, sessionId: 's1', prompting: null }],
      ['acp:qwen:1', { agent: other, sessionId: 's2', prompting: null }],
    ]),
    close: (key: string) => {
      closed.push(key);
      host.chats.delete(key);
    },
  };
  const p = acpProcesses({ host: () => host, harness: 'gemini' });
  assert.deepEqual(await p.list(), [{ startedAt: 100, busy: false }]);
  assert.deepEqual(await p.restartIdle(50), { restarted: 0, busy: 0 });
  host.chats.get('acp:gemini:1').prompting = { turnId: 't' };
  assert.deepEqual(await p.list(), [{ startedAt: 100, busy: true }]);
  assert.deepEqual(await p.restartIdle(200), { restarted: 0, busy: 1 });
  host.chats.get('acp:gemini:1').prompting = null;
  assert.deepEqual(await p.restartIdle(200), { restarted: 1, busy: 0 });
  assert.deepEqual(closed, ['acp:gemini:1']);
  assert.deepEqual(killed, ['gemini']);
  assert.equal(host.agents.has('gemini'), false);
  // the other harness's chat is left alone
  assert.ok(host.chats.has('acp:qwen:1'));
  // no agent: nothing to list or restart
  assert.deepEqual(await p.list(), []);
  assert.deepEqual(await p.restartIdle(200), { restarted: 0, busy: 0 });
  // an agent that failed to start is no process
  host.agents.set('gemini', Promise.reject(new Error('no binary')));
  assert.deepEqual(await p.list(), []);
  // one still starting is not waited for
  host.agents.set('gemini', new Promise(() => {}));
  assert.deepEqual(await p.list(), []);
  host.agents.delete('gemini');
  // a newer agent took the entry meanwhile: it stays
  const newer = Promise.resolve({ harness: 'gemini', startedAt: 300 });
  const swap: any = {
    agents: new Map([['gemini', entry]]),
    chats: new Map(),
    close: () => {},
  };
  const q = acpProcesses({ host: () => swap, harness: 'gemini' });
  const job = q.restartIdle(200);
  swap.agents.set('gemini', newer);
  assert.deepEqual(await job, { restarted: 1, busy: 0 });
  assert.equal(swap.agents.get('gemini'), newer);
  assert.deepEqual(await acpProcesses({ host: () => null, harness: 'x' }).list(), []);
  // a host that hasn't made its chat list yet: the agent has no chats, so it is idle
  const early: any = { agents: new Map([['gemini', Promise.resolve({ harness: 'gemini', startedAt: 5 })]]) };
  assert.deepEqual(await acpProcesses({ host: () => early, harness: 'gemini' }).list(), [{ startedAt: 5, busy: false }]);
});

test('each kind gets its own adapter once; an unknown kind gets none', async () => {
  const claude = { list: async () => [], restartIdle: async () => ({}) };
  const of = routeProcessesFor({
    server: () => null,
    codex: () => null,
    accounts: () => null,
    acpHost: () => null,
    claude,
    background: async () => 0,
  });
  const withChats = routeProcessesFor({
    server: () => ({ proc: {}, startedAt: 1 }),
    codex: () => ({ running: new Map() }),
    accounts: () => null,
    acpHost: () => null,
    claude,
    background: async () => 0,
    sessions: () => ({ all: () => ['x'], get: () => ({ turn: 'running' }) }),
    controller: () => ({ ref: () => ({ kind: 'codex' }) }),
  });
  assert.equal((await withChats('codex')!.list())[0].busy, true);
  // without the session store or the controller nothing counts as a busy chat
  const base = { codex: () => ({ running: new Map() }), accounts: () => null, acpHost: () => null, claude, background: async () => 0 };
  const noStore = routeProcessesFor({ ...base, server: () => ({ proc: {}, startedAt: 1 }) });
  assert.equal((await noStore('codex')!.list())[0].busy, false);
  const noController = routeProcessesFor({
    ...base,
    server: () => ({ proc: {}, startedAt: 1 }),
    sessions: () => ({ all: () => ['x'], get: () => ({ turn: 'running' }) }),
  });
  assert.equal((await noController('codex')!.list())[0].busy, false);
  assert.equal(of('claude'), claude);
  assert.equal(of('codex'), of('codex'));
  assert.ok(of('acp:gemini'));
  assert.notEqual(of('acp:gemini'), of('acp:qwen'));
  assert.equal(of('other'), null);
  assert.equal(of('acp:'), null);
});

test("the IPC: list, refresh, reveal only the route's own file, and Restart to apply", async (t) => {
  const handlers: Record<string, (...a: any[]) => any> = {};
  const shown: string[] = [];
  const broadcasts: any[] = [];
  const { register } = require('../electron/app/ipc/routes.cjs');
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'route-ipc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'codex'));
  fs.writeFileSync(path.join(home, 'codex/config.toml'), 'openai_base_url = "http://127.0.0.1:3425/backend-api/codex"\n');
  const quits: (() => void)[] = [];
  const watched: string[] = [];
  const routes = register(
    { handle: (ch: string, fn: any) => (handlers[ch] = fn) },
    {
      app: { on: (ev: string, fn: () => void) => ev === 'will-quit' && quits.push(fn) },
      live: {
        codex: { running: new Map() },
        accounts: null,
        acpHost: null,
        sessions: { all: () => ['c1'], get: () => ({ turn: 'idle' }) },
        controller: { ref: () => ({ kind: 'codex' }) },
      },
      server: { proc: {}, startedAt: 1 },
      claude: {
        routeProcesses: { list: async () => [], restartIdle: async () => ({ restarted: 0, busy: 0 }) },
        governor: { watch: (p: any) => (watched.push('claude'), p.subscribe(() => {})) },
      },
      pressure: {
        level: () => null,
        subscribe: (fn: any) => (watched.push(typeof fn), () => watched.push('unsubscribed')),
      },
      // a scratch home: never the real ~/.codex or ~/.claude
      shellEnv: {
        childEnv: () => ({
          CODEX_HOME: path.join(home, 'codex'),
          CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
          QWEN_HOME: path.join(home, 'qwen'),
          KIMI_SHARE_DIR: path.join(home, 'kimi'),
          DSH_HOME: path.join(home, 'dsh'),
        }),
      },
      broadcastAll: (ch: string, list: any) => broadcasts.push([ch, list]),
      shell: { showItemInFolder: (f: string) => shown.push(f) },
    },
  );
  t.after(() => routes.close());
  // the idle Codex recycler and Claude Code's governor follow the memory pressure; both stop when the app really quits
  // (a held quit can still be called off)
  assert.deepEqual(watched, ['function', 'claude', 'function']);
  assert.equal(quits.length, 1);
  t.after(() => {
    quits.forEach((fn) => fn());
    assert.deepEqual(watched.slice(3), ['unsubscribed', 'unsubscribed']);
  });
  const list = await handlers['routes:refresh']();
  const codex = list.find((r: any) => r.harness === 'codex');
  assert.equal(codex.label, 'magpie');
  assert.ok((await handlers['routes:list']()).some((r: any) => r.harness === 'codex'));
  assert.equal(handlers['routes:reveal']({}, 'codex'), true);
  assert.deepEqual(shown, [path.join(home, 'codex/config.toml')]);
  assert.equal(handlers['routes:reveal']({}, 'acp:copilot'), false);
  assert.deepEqual(await handlers['routes:restartIdle']({}, 'claude'), { restarted: 0, busy: 0 });
  assert.ok(broadcasts.every(([ch]) => ch === 'routes:changed'));
});

test('an ACP harness whose chats each hold a process: each is listed, and only the idle ones restart (#2311)', async () => {
  const killed: string[] = [];
  const mk = (id: string) => ({ harness: 'gemini', startedAt: 100, kill: () => killed.push(id) });
  const a: any = mk('a');
  const b: any = mk('b');
  const dead = Promise.reject(new Error('no binary'));
  dead.catch(() => {});
  const host: any = {
    agents: new Map(),
    codingAgents: new Map<string, any>([
      ['acp:gemini:a', Promise.resolve(a)],
      ['acp:gemini:b', Promise.resolve(b)],
      ['acp:qwen:c', Promise.resolve(mk('c'))],
      ['acp:gemini:dead', dead],
    ]),
    chats: new Map<string, any>([
      ['acp:gemini:a', { agent: a, sessionId: 's', prompting: null }],
      ['acp:gemini:b', { agent: b, sessionId: 's', prompting: { turnId: 't' } }],
    ]),
    close: (key: string) => void host.chats.delete(key),
  };
  const p = acpProcesses({ host: () => host, harness: 'gemini' });
  assert.deepEqual(await p.list(), [
    { startedAt: 100, busy: false },
    { startedAt: 100, busy: true },
  ]);
  assert.deepEqual(await p.restartIdle(200), { restarted: 1, busy: 1 });
  assert.deepEqual(killed, ['a']);
  assert.equal(host.codingAgents.has('acp:gemini:a'), false);
  assert.equal(host.codingAgents.has('acp:gemini:b'), true);
  assert.equal(host.codingAgents.has('acp:qwen:c'), true, 'another harness is left alone');
  // no host yet: nothing to restart
  assert.deepEqual(await acpProcesses({ host: () => null, harness: 'gemini' }).restartIdle(200), { restarted: 0, busy: 0 });
});
