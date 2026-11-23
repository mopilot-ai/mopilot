// Real Run now IPC rejects ambiguous persisted IDs before any runner effect, while preserving explicit ad-hoc inputs.
import { test, assert, fs, path, setup, base, writeTask, fakeDesktop } from './support/automation-store/fixture.ts';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

function entrypoint(t: any, store: any, controller?: any) {
  const file = fileURLToPath(new URL('../electron/app/automations.cjs', import.meta.url));
  const runs: any[] = [];
  const { Registry } = require('../electron/capabilities/contract/registry.cjs');
  const registry = new Registry();
  let scheduler: any;
  const noop = class {};
  const dependencies: Record<string, any> = {
    '../platform/scheduler.cjs': {
      Scheduler: class {
        constructor(o: any) {
          scheduler = o;
        }
      },
      // every rule is due at once, as said
      nextRun: () => new Date(0),
      rules: { describe: (rule: string) => rule },
    },
    '../platform/automationRun.cjs': {
      AutomationRunner: class {
        async run(...args: any[]) {
          runs.push(args);
          return 'run-chat';
        }
      },
    },
    '../platform/automationStore.cjs': {
      AutomationStore: class {
        constructor() {
          return store;
        }
      },
    },
    '../platform/runLedger.cjs': { RunLedger: noop },
    '../platform/nativeSchedulers.cjs': { codexApp: () => ({}), claudeDesktop: () => ({}) },
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
  const handlers = new Map<string, any>();
  store.migrate = async () => [];
  loaded.exports
    .createAutomations({
      ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) },
      shellEnv: { childEnv: () => ({}) },
      uiPrefs: () => ({}),
      broadcastAll: () => {},
      live: {
        capabilities: registry,
        controller,
        chats: { records: new Map([['caller', { segments: [{ kind: 'codex', nativeId: 'seg' }] }]]) },
      },
    })
    .registerScheduler();
  return {
    runs,
    scheduler,
    toolRun: (id: string) => registry.invoke('caller', 'seg', 'run_scheduled_task', { id }),
    create: (args: any) => registry.invoke('caller', 'seg', 'create_scheduled_task', args),
    run: (task: any) => handlers.get('automation:run')({ sender: { id: 7 } }, task),
  };
}

for (const harness of ['claude', 'acp:x']) {
  test(`Run now rejects shared Codex/${harness} ID and still runs each healthy harness`, async (t) => {
    const s = setup(t, fakeDesktop({ installed: false }));
    await writeTask(s.store.o.codexDir(), { ...base, id: 'shared', prompt: 'wrong', updated_at: 20 });
    await writeTask(s.store.o.mopilotDir(), { ...base, id: 'shared', harness, prompt: 'intended', updated_at: 10 });
    const h = entrypoint(t, s.store);
    const selected = (await s.store.list()).tasks.find((a: any) => a.id === 'shared');
    await assert.rejects(h.run(selected), /ambiguous/);
    assert.deepEqual(h.runs, []);
    assert.equal((await h.toolRun('shared')).ok, false);
    assert.deepEqual(h.runs, []);
    for (const kind of ['codex', 'claude', 'acp:x']) {
      const task = { ...base, id: `healthy-${kind.replace(':', '-')}`, harness: kind };
      await writeTask(kind === 'codex' ? s.store.o.codexDir() : s.store.o.mopilotDir(), task);
      assert.equal(await h.run(task), 'run-chat');
      assert.deepEqual(h.runs.at(-1), [task, { unattended: false, origin: 7 }]);
      assert.equal((await h.toolRun(task.id)).ok, true);
      assert.equal((h.runs.at(-1) as any)[0].id, task.id);
    }
  });
}

test('Run now blocks a known target with an unreadable sibling, without poisoning a later explicit run', async (t) => {
  const s = setup(t, fakeDesktop({ installed: false }));
  await writeTask(s.store.o.codexDir(), { ...base, id: 'broken' });
  await writeTask(s.store.o.mopilotDir(), { ...base, id: 'broken', harness: 'acp:x' });
  fs.writeFileSync(path.join(s.root, 'mopilot', 'broken', 'automation.toml'), '[');
  const h = entrypoint(t, s.store);
  await assert.rejects(h.run({ ...base, id: 'broken' }));
  const result = await h.toolRun('broken');
  assert.equal(result.ok, false);
  assert.deepEqual(h.runs, []);
  const explicit = { ...base, id: 'not-saved', prompt: 'unsaved draft' };
  assert.equal(await h.run(explicit), 'run-chat');
  assert.equal(h.runs[0][0], explicit);
});

test('Run now keeps idless, empty-ID, invalid-input and unsaved fields behavior', async (t) => {
  const s = setup(t, fakeDesktop({ installed: false }));
  const h = entrypoint(t, s.store);
  for (const task of [{ ...base }, { ...base, id: '' }, null, 'invalid']) {
    await h.run(task);
    assert.deepEqual(h.runs.at(-1)![0], task && typeof task === 'object' ? task : {});
  }
  const persisted = { ...base, id: 'single', prompt: 'stored' };
  await writeTask(s.store.o.codexDir(), persisted);
  const edited = { ...persisted, prompt: 'explicit unsaved edit', computer_control: true };
  await h.run(edited);
  assert.equal(h.runs.at(-1)![0], edited, 'identity validation must not replace explicit run fields');
});

test('native mirror and explicit transfer remain single canonical identities at Run now boundary', async (t) => {
  const s = setup(t);
  const mirror = await s.store.save({ ...base, id: 'mirror', harness: 'claude' });
  await writeTask(s.store.o.codexDir(), { ...base, id: 'moving' });
  await writeTask(s.store.o.mopilotDir(), { ...base, id: 'moving', harness: 'acp:x', transfer_from: 'codex', transfer_status: 'ACTIVE' });
  const h = entrypoint(t, s.store);
  await h.run(mirror);
  await h.run(await s.store.get('moving'));
  assert.equal(h.runs.length, 2, 'runner retains responsibility for blocking the still-pending transfer');
});

for (const harness of ['codex', 'claude', 'acp:x']) {
  test(`explicit unsaved ${harness} ID runs with unavailable Desktop state`, async (t) => {
    const s = setup(t);
    const appData = path.join(s.root, 'desktop');
    fs.mkdirSync(path.join(appData, 'claude-code-sessions'), { recursive: true });
    const { claudeDesktop } = require('../electron/platform/nativeSchedulers.cjs');
    s.store.o.desktop = claudeDesktop({ appData: () => appData, tasksDir: () => path.join(s.root, 'skills'), processes: async () => '' });
    const h = entrypoint(t, s.store);
    const explicit = { ...base, id: 'not-yet-saved', harness };
    assert.equal(await h.run(explicit), 'run-chat');
    assert.equal(h.runs[0][0], explicit);
  });
}

test('idless run performs no lookup and actual lookup rejection prevents runner effects', async (t) => {
  const s = setup(t);
  const lookups: unknown[] = [];
  s.store.get = async (id: unknown) => {
    lookups.push(id);
    throw new Error('lookup failed');
  };
  const h = entrypoint(t, s.store);
  await h.run(base);
  assert.deepEqual(lookups, []);
  await assert.rejects(h.run({ ...base, id: 'lookup-failure' }), /lookup failed/);
  assert.equal(h.runs.length, 1);
});

for (const failure of ['corrupt-sibling', 'disappeared', 'paused', 'transfer', 'rescheduled', 'invalid-rule']) {
  test(`scheduler production validation blocks ${failure} before native/ledger effects and keeps healthy tasks running`, async (t) => {
    const s = setup(t, fakeDesktop({ installed: false }));
    const task = { ...base, id: 'shared', created_at: 1, rrule: 'FREQ=MINUTELY' };
    const healthy = { ...task, id: 'healthy', harness: 'acp:x' };
    await writeTask(s.store.o.codexDir(), task);
    await writeTask(s.store.o.mopilotDir(), healthy);
    const listed = (await s.store.list()).tasks;
    if (failure === 'corrupt-sibling') {
      await writeTask(s.store.o.mopilotDir(), { ...task, harness: 'acp:x' });
      fs.writeFileSync(path.join(s.root, 'mopilot', 'shared', 'automation.toml'), '[');
    } else if (failure === 'disappeared') await fs.promises.rm(path.join(s.root, 'codex', 'shared'), { recursive: true });
    else {
      const changes: Record<string, any> = {
        paused: { status: 'PAUSED' },
        transfer: { transfer_from: 'mopilot', transfer_status: 'ACTIVE' },
        rescheduled: { schedule_from: Date.UTC(2030, 0, 1, 9, 0, 30) },
        'invalid-rule': { rrule: 42 },
      };
      await writeTask(s.store.o.codexDir(), { ...task, ...changes[failure] });
    }
    const h = entrypoint(t, s.store);
    const { Scheduler } = require('../electron/platform/scheduler.cjs');
    const effects: any[] = [];
    const scheduler = new Scheduler({
      ...h.scheduler,
      enabled: () => true,
      before: async () => {},
      list: async () => listed,
      sessions: { all: () => [] },
      now: () => Date.UTC(2030, 0, 1, 9, 0, 30),
      tickMs: 0,
      run: async (a: any) => {
        effects.push(['run', a.id]);
        return 'chat';
      },
      ledger: {
        baseline: async () => 1,
        latest: async () => 0,
        lastRun: async () => null,
        claim: async (id: string) => {
          effects.push(['claim', id]);
          return true;
        },
        update: async () => {},
      },
      natives: {
        'codex-app': {
          installed: () => true,
          running: async () => false,
          read: () => ({ ok: true, tasks: new Map([['shared', { through: 0 }]]) }),
          markHandled: (id: string) => {
            effects.push(['mark', id]);
            return true;
          },
        },
      },
      log: () => {},
      notify: () => {},
    });
    await scheduler.tick();
    assert.deepEqual(effects, [
      ['claim', 'healthy'],
      ['run', 'healthy'],
    ]);
  });
}

test('known run target disappearing during strict revalidation cannot start an old snapshot', async (t) => {
  const s = setup(t);
  s.store.get = async (_id: string, strict: boolean) => (strict ? null : { id: 'gone' });
  const h = entrypoint(t, s.store);
  await assert.rejects(h.run({ ...base, id: 'gone' }), /no longer exists/);
  assert.deepEqual(h.runs, []);
});

test('scheduler recomputes native ownership and prompt from the validated canonical task', async (t) => {
  const s = setup(t, fakeDesktop({ installed: false }));
  const old = { ...base, id: 'moved', created_at: 1, rrule: 'FREQ=MINUTELY', prompt: 'old codex' };
  await writeTask(s.store.o.codexDir(), old);
  const listed = (await s.store.list()).tasks;
  await fs.promises.rm(path.join(s.root, 'codex', 'moved'), { recursive: true });
  await writeTask(s.store.o.mopilotDir(), { ...old, harness: 'acp:x', prompt: 'current ACP' });
  const h = entrypoint(t, s.store);
  const { Scheduler } = require('../electron/platform/scheduler.cjs');
  const effects: any[] = [];
  const scheduler = new Scheduler({
    ...h.scheduler,
    enabled: () => true,
    before: async () => {},
    list: async () => listed,
    sessions: { all: () => [] },
    now: () => Date.UTC(2030, 0, 1, 9, 0, 30),
    tickMs: 0,
    run: async (a: any) => {
      effects.push(['run', a.harness, a.prompt]);
      return 'chat';
    },
    ledger: { baseline: async () => 1, latest: async () => 0, lastRun: async () => null, claim: async () => true, update: async () => {} },
    natives: {
      'codex-app': {
        installed: () => {
          effects.push('stale-native');
          return false;
        },
        running: async () => false,
        read: () => ({ ok: true, tasks: new Map() }),
      },
    },
    log: () => {},
    notify: () => {},
  });
  await scheduler.tick();
  assert.deepEqual(effects, [['run', 'acp:x', 'current ACP']]);
});

test('a scheduled task a chat makes takes another harness only from the user words main recorded for its turn (#2084)', async (t) => {
  const { userWordsOf } = require('../electron/session/userWords.cjs');
  const s = setup(t, fakeDesktop({ installed: false }));
  const rt = { inputToken: 'pending-1', token: 'pending-1' };
  const controller: any = { rt: () => rt };
  // linked sessions install the recorder at startup (app/orchestration.cjs), before any turn
  const words = userWordsOf(controller);
  const h = entrypoint(t, s.store, controller);
  await controller.beforeDispatch({ chatId: 'caller', kind: 'turn', item: { text: 'set up a nightly check', opts: { human: true } } });
  const first = await h.create({ prompt: 'check', schedule: 'FREQ=DAILY', harness: 'claude', cwd: '/proj' });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const aside = JSON.parse(first.content[0].text);
  assert.equal(aside.harness, 'codex');
  assert.match(aside.ignored[0], /harness "claude" was set aside/);
  await controller.beforeDispatch({ chatId: 'caller', kind: 'steer', item: { text: 'run it on Claude', opts: { human: true } } });
  assert.equal(words.said('caller'), 'set up a nightly check\nrun it on Claude');
  const named = JSON.parse((await h.create({ prompt: 'check', schedule: 'FREQ=DAILY', harness: 'claude', cwd: '/proj' })).content[0].text);
  assert.equal(named.harness, 'claude');
  assert.equal(named.ignored, undefined);
});
