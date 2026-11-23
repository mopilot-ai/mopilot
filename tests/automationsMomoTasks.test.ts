// electron/app/automations.cjs (#2139): the one scheduler lists MoMo's routines (live.momoRoutines) beside the user's scheduled tasks; MoMo's runs, notices go to MoMo's service, and a skipped time says nothing, the user's to the scheduled-task runner and the app's notifications as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const coding = { id: 'brief-1', name: 'Morning brief', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=9' };
const momo = { id: 'momo.r1', kind: 'momo-routine', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=8' };

function load(t: any) {
  const file = fileURLToPath(new URL('../electron/app/automations.cjs', import.meta.url));
  const seen: any = { runs: [], ledgers: [] };
  let stored: any = coding;
  class Scheduler {
    constructor(o: any) {
      seen.scheduler = o;
    }
  }
  class AutomationRunner {
    run(task: any, o: any) {
      seen.runs.push([task.id, o]);
      return Promise.resolve(`chat-${task.id}`);
    }
  }
  class Store {
    migrate() {
      return Promise.resolve();
    }
    async list() {
      return { tasks: [coding] };
    }
    async get() {
      return stored;
    }
  }
  class RunLedger {
    constructor() {
      seen.ledgers.push(this);
    }
  }
  const dependencies: Record<string, any> = {
    '../platform/scheduler.cjs': { Scheduler, nextRun: () => null, rules: {} },
    '../platform/automationRun.cjs': { AutomationRunner },
    '../platform/automationStore.cjs': { AutomationStore: Store },
    '../platform/runLedger.cjs': { RunLedger },
    '../platform/nativeSchedulers.cjs': { codexApp: () => ({}), claudeDesktop: () => ({}) },
  };
  const loader = (Module as any)._load;
  t.mock.method(Module as any, '_load', (request: string, parent: any, ...rest: any[]) => {
    if (parent?.filename === file && Object.hasOwn(dependencies, request)) return dependencies[request];
    return loader(request, parent, ...rest);
  });
  const loaded = new (Module as any)(file);
  loaded.filename = file;
  loaded.paths = (Module as any)._nodeModulePaths(fileURLToPath(new URL('../electron/app', import.meta.url)));
  loaded._compile(fs.readFileSync(file, 'utf8'), file);
  const told: any[] = [];
  const source = {
    list: async () => [momo],
    validate: async (task: any) => task,
    run: async (task: any) => (told.push(['run', task.id]), `momo-${task.id}`),
    notify: (...a: any[]) => told.push(['notify', ...a]),
  };
  const notices: any[] = [];
  const live: any = {
    momoRoutines: source,
    notifier: { notify: (...a: any[]) => notices.push(a) },
    codex: { chatName: (id: string) => (id === 'named' ? 'A named chat' : '') },
  };
  const app = loaded.exports.createAutomations({
    ipcMain: { handle: () => {} },
    shellEnv: { childEnv: () => ({}) },
    readState: () => ({ prefs: {} }),
    broadcastAll: () => {},
    live,
  });
  app.registerScheduler();
  return { o: seen.scheduler, seen, told, notices, live, setStored: (v: any) => (stored = v) };
}

test('the scheduler lists both, runs each on its own side, and the ledger is there for MoMo to forget a routine', async (t) => {
  const w = load(t);
  assert.deepEqual(
    (await w.o.list()).map((x: any) => x.id),
    ['brief-1', 'momo.r1'],
  );
  assert.equal(await w.o.run(coding), 'chat-brief-1');
  assert.deepEqual(w.seen.runs, [['brief-1', { unattended: true }]]);
  assert.equal(await w.o.run(momo), 'momo-momo.r1');
  assert.deepEqual(w.told, [['run', 'momo.r1']]);
  assert.deepEqual(await w.o.validate(coding), coding);
  assert.deepEqual(await w.o.validate(momo), momo);
  w.setStored(null);
  await assert.rejects(w.o.validate(coding), /Scheduled task "brief-1" no longer exists/);
  assert.equal(w.live.runLedger, w.seen.ledgers[0]);
});

test('notices: the user’s tasks as before; MoMo’s routines never through the app’s scheduled-task notification', async (t) => {
  const w = load(t);
  await w.o.list();
  w.o.notify('named', coding, { catchUp: false });
  w.o.notify('plain', coding, { catchUp: true });
  w.o.notify(null, coding, { catchUp: true, error: 'Codex isn’t available' });
  w.o.notify('named', coding, { catchUp: false, error: 'refused' });
  w.o.notify('plain', coding, undefined);
  assert.deepEqual(w.notices, [
    ['scheduled', 'named', { title: 'Scheduled task started', body: 'Morning brief', chatTitle: 'A named chat' }],
    ['scheduled', 'plain', { title: 'Catch-up run started', body: 'Morning brief', chatTitle: undefined }],
    [
      'scheduled',
      'automation:brief-1',
      { title: "Catch-up run didn't start", body: 'Morning brief: Codex isn’t available', group: 'failed', chatTitle: 'Morning brief' },
    ],
    [
      'scheduled',
      'named',
      { title: "Scheduled task didn't start", body: 'Morning brief: refused', group: 'failed', chatTitle: 'A named chat' },
    ],
    ['scheduled', 'plain', { title: 'Scheduled task started', body: 'Morning brief', chatTitle: undefined }],
  ]);
  w.o.notify('momo-chat', momo, { catchUp: false });
  w.o.skipped(momo, 5, 'quiet-hours');
  assert.equal(w.notices.length, 5, 'no app notification for a MoMo routine');
  assert.deepEqual(w.told, [], 'nor through MoMo’s service: a skipped time says nothing');
  assert.equal(w.o.independent(momo), true, '“run schedules” off doesn’t stop MoMo’s routines');
  assert.equal(w.o.independent(coding), false);
});
