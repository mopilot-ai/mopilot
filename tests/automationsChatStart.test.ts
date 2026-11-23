// electron/app/automations.cjs: scheduled runs and linked sessions make chats the same way (chatStartDeps), and linked
// sessions are wired with the scheduler's harness check, run message and tool owner (registerOrchestration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { ISOLATED_THREAD, DATA_ONLY_THREAD } = Module.createRequire(import.meta.url)('../electron/harness/codexIsolation.cjs');

function load(t: any) {
  const file = fileURLToPath(new URL('../electron/app/automations.cjs', import.meta.url));
  const captured: any = {};
  const noop = class {
    constructor(..._args: any[]) {}
  };
  const dependencies: Record<string, any> = {
    '../platform/scheduler.cjs': {
      Scheduler: noop,
      // hourly comes first; a rule with no next time sorts last
      nextRun: (rule: string) => (rule === 'NEVER' ? null : new Date(rule === 'FREQ=HOURLY' ? 1000 : 2000)),
      rules: {},
    },
    '../platform/automationRun.cjs': {
      AutomationRunner: class {
        constructor(o: any) {
          captured.runner = o;
        }
      },
    },
    '../platform/automationStore.cjs': {
      AutomationStore: class {
        // the tasks Chrome's side panel lists: active ones with a time, soonest first
        async list() {
          return {
            tasks: [
              { id: 'late', name: 'Weekly', status: 'ACTIVE', rrule: 'FREQ=WEEKLY' },
              { id: 'paused', name: 'Paused', status: 'PAUSED', rrule: 'FREQ=DAILY' },
              { id: 'manual', name: 'Manual', status: 'ACTIVE' },
              { id: 'soon', status: 'ACTIVE', rrule: 'FREQ=HOURLY' },
              { id: 'never', name: 'Never', status: 'ACTIVE', rrule: 'NEVER' },
            ],
          };
        }
        migrate() {
          return Promise.resolve();
        }
      },
    },
    '../platform/runLedger.cjs': { RunLedger: noop },
    '../platform/nativeSchedulers.cjs': { codexApp: () => ({}), claudeDesktop: () => ({}) },
    '../harness/codex.cjs': { permissionParams: (p: string) => ({ approvalPolicy: `for-${p}` }) },
    '../harness/quirks/index.cjs': {},
    './orchestration.cjs': { createOrchestration: (d: any) => ((captured.orchestration = d), { wired: true }) },
    './chromePanel.cjs': {
      createChromePanel: (d: any) => ((captured.panel = d), { panel: true }),
      projectsFileOf: (u: string) => `${u}/p.json`,
    },
  };
  const loader = (Module as any)._load;
  t.mock.method(Module as any, '_load', (request: string, parent: any, ...rest: any[]) => {
    if (parent?.filename === file && Object.hasOwn(dependencies, request)) return dependencies[request];
    return loader(request, parent, ...rest);
  });
  const loaded = new (Module as any)(file);
  loaded.filename = file;
  loaded.paths = (Module as any)._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(file, 'utf8'), file);
  return { exports: loaded.exports, captured };
}

test('scheduled runs and linked sessions start Codex threads, forks and Claude/ACP sessions through the same hooks', async (t) => {
  const { exports, captured } = load(t);
  const calls: any[] = [];
  const live: any = {
    codex: {
      startThread: async (p: any) => (calls.push(['startThread', p]), { thread: { id: 'th' } }),
      fork: async (p: any, hold: boolean) => (calls.push(['fork', p, hold]), { thread: { id: 'fk' } }),
      connect: async () => {},
      accountRead: async () => ({ account: { id: 'a' } }),
    },
    chatDeletion: {},
    claudeTurns: { registerSession: (...a: any[]) => calls.push(['claude', ...a]) },
    acpTurns: { registerSession: (...a: any[]) => calls.push(['acp', ...a]) },
    chats: {
      records: new Map([['caller', { segments: [{ nativeId: 'seg', kind: 'codex' }] }]]),
      get: (id: string) => ({ view: id }),
    },
    controller: {
      state: { get: () => ({ turn: 'idle', queue: [] }) },
      startOrKeep: async (...a: any[]) => (calls.push(['startOrKeep', a[0]]), { started: true }),
      send: async (...args: any[]) => (calls.push(['panelSend', ...args]), { action: 'started', id: 'panel-input' }),
    },
  };
  const handlers = new Map<string, any>();
  const broadcasts: any[] = [];
  const broadcastAll = (...a: any[]) => void broadcasts.push(a);
  const openChat = (id: string | null) => calls.push(['openChat', id]);
  let state: any = { prefs: {} };
  const automations = exports.createAutomations({
    ipcMain: { handle: (n: string, fn: any) => handlers.set(n, fn) },
    shellEnv: { childEnv: () => ({}) },
    uiPrefs: () => ({ model: 'gpt', permission: 'ask', serviceTier: 'fast' }),
    gitPlatform: {
      worktreeAdd: async (...a: any[]) => (calls.push(['worktreeAdd', ...a]), { ok: true }),
      runScript: async (...a: any[]) => (calls.push(['runScript', ...a]), { exitCode: 0 }),
      worktreeInfo: (dir: string) => (dir === '/wt' ? { branch: 'b' } : null),
    },
    claudeEmit: (e: any) => calls.push(['claudeEmit', e.chatId]),
    readState: () => state,
    broadcastAll,
    chatProject: async () => '/repo',
    isFlagEnabled: () => false,
    live,
    openChat,
  });
  automations.registerScheduler();
  const runnerDeps = captured.runner;
  // a chat kept apart from the coding side (MoMo's): its thread starts without Codex's own tools
  await runnerDeps.codexThread({ cwd: '/m', isolated: true });
  assert.equal(calls.at(-1)[1][ISOLATED_THREAD], true);
  assert.equal(calls.at(-1)[1][DATA_ONLY_THREAD], undefined);
  // MoMo's memory pass: a thread that may use no tool at all
  await runnerDeps.codexThread({ cwd: '/m', isolated: true, meta: { momo: 'memory' } });
  assert.equal(calls.at(-1)[1][DATA_ONLY_THREAD], true);
  await runnerDeps.codexThread({ cwd: '/m', meta: { momo: 'memory' } });
  assert.equal(calls.at(-1)[1][DATA_ONLY_THREAD], undefined, 'only an isolated thread');
  assert.equal(await (await runnerDeps.codexThread({ cwd: '/a' })).id, 'th');
  assert.equal(calls.at(-1)[1][ISOLATED_THREAD], undefined);
  assert.deepEqual(calls.at(-1), [
    'startThread',
    { cwd: '/a', model: 'gpt', approvalPolicy: 'for-ask', ephemeral: false, serviceTier: 'fast' },
  ]);
  assert.equal(automations.registerOrchestration('/user-data').wired, true);
  const d = captured.orchestration;
  assert.equal(d.file, path.join('/user-data', 'orchestration.json'));
  assert.equal(d.live, live);
  assert.equal(await d.projectOf('x'), '/repo');
  assert.deepEqual(await d.starter.codexFork({ threadId: 't', cwd: '/c' }), { id: 'fk' });
  assert.deepEqual(calls.at(-1), ['fork', { threadId: 't', cwd: '/c', ephemeral: false }, true]);
  d.starter.claudeSession('claude:k', { cwd: '/c' });
  d.starter.acpSession('acp:x:k', { cwd: '/c' });
  await d.starter.worktree('/c', { root: '/r' });
  await d.starter.script('/c', 'make');
  d.starter.started({ harness: 'claude', chatId: 'claude:k', cwd: '/c', worktreeOf: null });
  assert.deepEqual(calls.slice(-5), [
    ['claude', 'claude:k', { cwd: '/c' }],
    ['acp', 'acp:x:k', { cwd: '/c' }],
    ['worktreeAdd', '/c', { root: '/r' }],
    ['runScript', '/c', 'make'],
    ['claudeEmit', 'claude:k'],
  ]);
  // meta a caller gives a new chat (MoMo's tag) reaches every window before the chat does
  d.starter.changed('claude:k');
  assert.deepEqual(broadcasts.at(-1), ['chats:changed', { id: 'claude:k', chat: { view: 'claude:k' } }]);
  assert.deepEqual(d.worktreeInfo('/wt'), { branch: 'b' });
  assert.equal(d.owner({ chatId: 'caller', segmentId: 'seg' }), 'caller');
  assert.equal(d.owner({ chatId: 'caller', segmentId: 'other' }), null);
  assert.deepEqual(await d.send('child', { id: 'b1', text: 'brief', opts: { human: false } }), { started: true });
  assert.deepEqual(calls.at(-1), ['startOrKeep', 'child']);
  // a harness is usable for a linked session as for an attended run: the kill switch, then its own check
  assert.equal(typeof (await d.usable('codex')), 'boolean');
  assert.equal(typeof d.ipcMain.handle, 'function');
  // Chrome's side panel starts chats through the same hooks, harness check and run message
  automations.registerChromePanel('/user-data');
  assert.deepEqual(live.chromePanel, { panel: true });
  const p = captured.panel;
  assert.equal(p.projectsFile, '/user-data/p.json');
  assert.equal(p.open, openChat);
  assert.deepEqual(p.prefs(), {});
  // no saved state yet: the panel's chats use the default folder
  state = null;
  assert.deepEqual(p.prefs(), {});
  assert.equal(typeof p.starter.codexThread, 'function');
  assert.equal(typeof (await p.usable('codex')), 'boolean');
  assert.deepEqual(await p.send('new', { text: 'hi', opts: { human: true } }), { action: 'started', id: 'panel-input' });
  assert.deepEqual(calls.at(-1), ['panelSend', 'new', { text: 'hi', opts: { human: true } }, null, true]);
  assert.deepEqual(Object.keys(p.sources).sort(), ['acp', 'claude', 'codex']);
  assert.equal(p.broadcast, broadcastAll);
  // a paired phone's machines come from Host's IPC once it made them (app/hostPhone.cjs), and the windows learn of their new chats as a run's
  assert.equal(p.remote.host(), null);
  live.hostPhone = { allowed: () => true };
  assert.equal(p.remote.host(), live.hostPhone);
  assert.equal(typeof live.announceRunChat, 'function');
  // a chat's folder for its / menu: the chat's project, as main reads it
  assert.equal(await p.cwdOf('th-1'), '/repo');
  assert.deepEqual(
    (await p.scheduled()).map((t: any) => [t.id, t.name, t.next === null ? null : 'time']),
    [
      ['soon', 'soon', 'time'],
      ['late', 'Weekly', 'time'],
      ['never', 'Never', null],
    ],
  );
});
