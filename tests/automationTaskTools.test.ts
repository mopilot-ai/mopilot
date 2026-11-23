// The scheduled-task tools as electron/app/automations.cjs wires them: list_task_runs reads MoPilot's run ledger and the
// Codex app's runs (the Scheduled page's history), and delete_scheduled_task asks a card through the broker every time, then
// removes the task and its history. Same tools whichever harness the chat is on.
import { test, assert, fs, path, setup, base, writeTask, fakeDesktop } from './support/automation-store/fixture.ts';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

function entrypoint(t: any, store: any, o: { decision?: string | null; broker?: boolean } = {}) {
  const file = fileURLToPath(new URL('../electron/app/automations.cjs', import.meta.url));
  const { Registry } = require('../electron/capabilities/contract/registry.cjs');
  const registry = new Registry();
  const forgotten: string[] = [];
  const asked: any[] = [];
  const ledgerAsked: any[] = [];
  const noop = class {};
  const dependencies: Record<string, any> = {
    '../platform/scheduler.cjs': { Scheduler: noop, nextRun: () => new Date(0), rules: { describe: (rule: string) => rule } },
    '../platform/automationRun.cjs': { AutomationRunner: noop },
    '../platform/automationStore.cjs': {
      AutomationStore: class {
        constructor() {
          return store;
        }
      },
    },
    '../platform/runLedger.cjs': {
      RunLedger: class {
        async list(id: string, limit: number) {
          ledgerAsked.push([id, limit]);
          return [
            { taskId: id, scheduledFor: 3000, status: 'started', chatId: 'run-a' },
            { taskId: id, scheduledFor: 1000, status: 'skipped', reason: 'missed' },
          ];
        }
        async forget(id: string) {
          forgotten.push(id);
        }
      },
    },
    '../platform/nativeSchedulers.cjs': {
      codexApp: () => ({
        runs: (id: string) => [{ taskId: id, scheduledFor: 2000, status: 'started', chatId: 'codex-run', by: 'codex-app' }],
      }),
      claudeDesktop: () => ({}),
    },
    '../capabilities/tools/pluginSkills.cjs': { registerPluginSkillTools: () => {} },
    '../plugins/service.cjs': { pluginDelivery: () => ({}) },
    '../capabilities/tools/scheduledTasks.cjs': require('../electron/capabilities/tools/scheduledTasks.cjs'),
    '../session/contract/route.cjs': {},
    '../harness/codex.cjs': {},
    '../../shared/killSwitch.cjs': {},
    '../../shared/harnessKind.mjs': {},
    '../harness/quirks/index.cjs': {},
    '../ignored.cjs': {},
    '../session/controllerEvents.cjs': {},
    '../session/queueItem.cjs': {},
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
  store.migrate = async () => [];
  const changed: any[] = [];
  loaded.exports
    .createAutomations({
      ipcMain: { handle: () => {} },
      shellEnv: { childEnv: () => ({}) },
      uiPrefs: () => ({}),
      broadcastAll: (...a: any[]) => changed.push(a),
      live: {
        capabilities: registry,
        controller: { ref: () => ({ kind: 'claude' }) },
        ...(o.broker === false
          ? {}
          : {
              computerUse: {
                broker: { ask: async (...a: any[]) => (asked.push(a), o.decision === null ? null : { decision: o.decision ?? 'allow' }) },
              },
            }),
        chats: { records: new Map([['caller', { segments: [{ kind: 'codex', nativeId: 'seg' }] }]]) },
      },
    })
    .registerScheduler();
  return {
    asked,
    forgotten,
    ledgerAsked,
    changed,
    tool: async (name: string, args: any) => {
      const r = await registry.invoke('caller', 'seg', name, args);
      return r.ok ? JSON.parse(r.content[0].text) : { error: r.error };
    },
  };
}

test('list_task_runs merges the ledger and the Codex app’s runs, newest first, up to the limit', async (t) => {
  const s = setup(t, fakeDesktop({ installed: false }));
  await writeTask(s.store.o.mopilotDir(), { ...base, id: 'daily', harness: 'claude' });
  const h = entrypoint(t, s.store);
  const out = await h.tool('list_task_runs', { id: 'daily', limit: 2 });
  assert.deepEqual(h.ledgerAsked, [['daily', 2]]);
  assert.deepEqual(
    out.runs.map((r: any) => [r.startedAt, r.status, r.chatId ?? r.reason]),
    [
      ['1970-01-01T00:00:03.000Z', 'started', 'run-a'],
      ['1970-01-01T00:00:02.000Z', 'started', 'codex-run'],
    ],
  );
  assert.equal((await h.tool('list_task_runs', { id: 'daily' })).runs.length, 3);
});

test('delete_scheduled_task asks a computerConfirm card naming the task, then removes it and its run history', async (t) => {
  const s = setup(t, fakeDesktop({ installed: false }));
  await writeTask(s.store.o.mopilotDir(), { ...base, id: 'old', name: 'N'.repeat(100), harness: 'acp:x' });
  const h = entrypoint(t, s.store);
  const out = await h.tool('delete_scheduled_task', { id: 'old' });
  assert.equal(out.deleted, 'old');
  const [chatId, kind, card, opts] = h.asked[0];
  assert.deepEqual([chatId, kind], ['caller', 'computerConfirm']);
  assert.deepEqual(card, {
    harness: 'claude',
    app: { bundleId: 'ai.mopilot.code', name: 'MoPilot' },
    verb: `delete the scheduled task "${'N'.repeat(60)}"`,
    summary: 'It stops running and its run history is removed.',
    allowAlways: false,
    tool: 'delete_scheduled_task',
  });
  assert.ok(opts.signal instanceof AbortSignal);
  assert.deepEqual(h.forgotten, ['old']);
  assert.equal(
    (await s.store.list()).tasks.some((a: any) => a.id === 'old'),
    false,
  );
  assert.equal(h.changed.length > 0, true, 'windows are told');
});

test('delete_scheduled_task deletes nothing when the card is declined, goes away unanswered, or cannot be shown', async (t) => {
  const s = setup(t, fakeDesktop({ installed: false }));
  await writeTask(s.store.o.mopilotDir(), { ...base, id: 'keep', harness: 'claude' });
  for (const [o, code] of [
    [{ decision: 'deny' }, 'denied'],
    [{ decision: null }, 'unanswered'],
    [{ broker: false }, 'unavailable'],
  ] as const) {
    const h = entrypoint(t, s.store, o);
    assert.equal((await h.tool('delete_scheduled_task', { id: 'keep' })).error.code, code, JSON.stringify(o));
    assert.deepEqual(h.forgotten, []);
  }
  assert.equal(
    (await s.store.list()).tasks.some((a: any) => a.id === 'keep'),
    true,
  );
});
