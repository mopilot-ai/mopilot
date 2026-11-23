// The scheduled-task patch IPC and preload declaration use one canonical store update and announce only success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
await import('../src/lib/native/automation.ts');

test('renderer patch IPC preserves arguments, returns saved state, and rejects missing or failed writes without announcements', async (t) => {
  const file = fileURLToPath(new URL('../electron/app/automations.cjs', import.meta.url));
  const calls: any[] = [];
  let result: any = { id: 'task', name: 'Saved' };
  let failure: unknown;
  class Store {
    migrate() {
      return Promise.resolve();
    }
    async update(...args: any[]) {
      calls.push(args);
      if (failure) throw failure;
      return result;
    }
  }
  const noop = class {
    constructor(..._args: any[]) {}
  };
  const dependencies: Record<string, any> = {
    '../platform/scheduler.cjs': { Scheduler: noop },
    '../platform/automationRun.cjs': { AutomationRunner: noop },
    '../platform/automationStore.cjs': { AutomationStore: Store },
    '../platform/runLedger.cjs': { RunLedger: noop },
    '../platform/nativeSchedulers.cjs': { codexApp: () => ({}), claudeDesktop: () => ({}) },
    '../capabilities/tools/scheduledTasks.cjs': {},
    '../platform/chats.cjs': {},
    '../session/contract/route.cjs': {},
    '../harness/codex.cjs': {},
    '../../shared/killSwitch.cjs': {},
    '../../shared/harnessKind.mjs': {},
    '../harness/quirks/index.cjs': {},
    '../ignored.cjs': {},
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
  const handlers = new Map<string, any>();
  const announcements: any[] = [];
  const app = loaded.exports.createAutomations({
    ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) },
    shellEnv: { childEnv: () => ({}) },
    broadcastAll: (...args: any[]) => announcements.push(args),
    live: {},
  });
  app.registerScheduler();
  const update = handlers.get('automation:update');
  const patch = { prompt: 'New prompt', model: undefined };
  assert.deepEqual(await update({}, 'task', patch), result);
  assert.deepEqual(calls, [['task', patch]]);
  assert.deepEqual(announcements, [['automation:changed', { id: 'task' }]]);
  result = null;
  await assert.rejects(update({}, 'gone', {}), /no longer exists.*not saved/);
  failure = new Error('task unreadable');
  await assert.rejects(update({}, 'task', patch), /task unreadable/);
  assert.equal(announcements.length, 1);
  failure = undefined;
  result = { id: 'task', prompt: 'Retry' };
  assert.deepEqual(await update({}, 'task', { prompt: 'Retry' }), result);
  assert.equal(announcements.length, 2);
});

test('the preload declares both stable task identity and named patch for the update IPC', () => {
  const bridge = require('../electron/bridge/automation.cjs');
  const { invoke } = require('../electron/bridge/spec.cjs');
  assert.deepEqual(bridge.update, invoke('automation:update', 2));
});
