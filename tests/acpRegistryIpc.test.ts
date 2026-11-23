// ACP registry IPC accepts identifiers only, distinguishes repair from update, and uses the same main-owned install runner as every window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/registryHarnesses.cjs');
const { register: registerRuns } = require('../electron/app/ipc/harnessRuns.cjs');

function fixture() {
  const handlers = new Map<string, Function>();
  const calls: any[] = [];
  const ipcMain = { handle: (name: string, fn: Function) => handlers.set(name, fn), on: () => undefined };
  const registry = {
    list: async (options: any) => (calls.push(['list', options]), { agents: [] }),
    install: async (...args: any[]) => {
      calls.push(['install', ...args]);
      return 'installed';
    },
  };
  const live: any = { acpAdmission: { registry, refresh: async () => undefined } };
  register(ipcMain, { live });
  const invoke = (name: string, ...args: any[]) => handlers.get(`acp:registry${name}`)!({}, ...args);
  return { handlers, calls, ipcMain, live, registry, invoke };
}

test('discovery forces refresh only for a literal true and installation metadata stays in main', async () => {
  const f = fixture();
  for (const force of [undefined, false, 'true', true]) await f.invoke('List', force);
  assert.deepEqual(
    f.calls,
    [false, false, false, true].map((force) => ['list', { force }]),
  );
  assert.equal(await f.invoke('Install', 'example'), 'installed');
  assert.equal(await f.invoke('Repair', 'example'), 'installed');
  assert.equal(f.calls[4][1], 'example');
  assert.equal(f.calls[4][3], undefined);
  assert.deepEqual(f.calls[5][3], { repair: true });
  for (const action of ['Install', 'Repair'])
    for (const bad of [null, {}, ['example'], 12]) assert.throws(() => f.invoke(action, bad), /Choose an/);
  f.live.acpAdmission.registry = null;
  for (const action of ['List', 'Install', 'Repair']) assert.throws(() => f.invoke(action, 'example'), /not ready/);
});

test('registry package work connects to the shared runner and rejects when it has not been registered', async () => {
  const f = fixture();
  await f.invoke('Install', 'example');
  const spec = { via: 'npm', argv: ['/bin/npm', 'exec', 'example'], cwd: '/staging', signal: new AbortController().signal };
  await assert.rejects(f.calls.at(-1)[2](spec), /not ready/);
  const spawn: any[] = [];
  const runs = registerRuns(
    f.ipcMain,
    { live: f.live, server: {}, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      registerUpdates: () => undefined,
      spawnQuiet: (argv: any, options: any, events: any) => {
        spawn.push([argv, options]);
        queueMicrotask(() => events.onExit({ exitCode: 0 }));
        return { kill: () => undefined };
      },
    },
  );
  await f.calls.at(-1)[2](spec);
  assert.deepEqual(spawn[0][0], spec.argv);
  assert.equal(spawn[0][1].cwd, '/staging');
  assert.equal(runs.list()[0].kind, 'acp:registry-example');
  await f.invoke('Repair', 'example');
  assert.deepEqual(f.calls.at(-1)[3], { repair: true });
  await f.calls.at(-1)[2](spec);
  assert.deepEqual(spawn[1][0], spec.argv);
  assert.equal(spawn[1][1].cwd, '/staging');
  assert.equal(runs.list().length, 1, 'repair updates the same agent output instead of creating a duplicate');
  assert.equal(runs.list()[0].kind, 'acp:registry-example');
});
