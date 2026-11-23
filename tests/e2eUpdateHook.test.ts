// Exercises the update journeys' main-process hook (tests/e2e/fixtures/update-hook.cjs) against the app's real stealth
// restart scheduler and a stand-in updater: what it wraps, its clock, and the quit standing in for Squirrel's install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hookUpdates } = require('./e2e/fixtures/update-hook.cjs');
const { createStealthUpdate, IDLE_MS } = require('../electron/app/stealthUpdate.cjs');

class FakeUpdater {
  o: any;
  state: any = { status: 'unsupported', version: '1.0.0', available: null };
  channel = 'stable';
  supported = false;
  manual = true;
  ready: Promise<boolean> = Promise.resolve(false);
  stagedArtifact: any = null;
  constructor(o: any) {
    this.o = o;
  }
  set(patch: any) {
    this.state = { ...this.state, ...patch };
    this.o.broadcast(this.state);
  }
  async check() {
    throw new Error('the feed must never be read');
  }
}

function setup() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'update-hook-'));
  const quits: string[] = [];
  const electron = { autoUpdater: {} as any, app: { quit: () => quits.push('quit') } };
  const modules: Record<string, any> = {
    '../updater.cjs': { Updater: FakeUpdater, other: 1 },
    './stealthUpdate.cjs': { createStealthUpdate, IDLE_MS },
    electron,
  };
  const loads: string[] = [];
  const Module = {
    _load(request: string) {
      loads.push(request);
      return modules[request];
    },
  };
  const global: any = {};
  const hook = hookUpdates({ Module, global, env: { MOPILOT_USER_DATA: userData }, now: 1_000 });
  return { Module, modules, electron, hook, global, quits, userData, loads };
}

test('the updater main loads acts as a signed build with its update downloaded, and its restart quits the app', async () => {
  const { Module, hook, global, electron, quits, userData } = setup();
  assert.equal(global.__updateHook, hook);
  assert.equal(hook.status(), null);
  const { Updater } = Module._load('../updater.cjs');
  assert.notEqual(Updater, FakeUpdater);
  // loaded again (the module cache): wrapped once
  assert.equal(Module._load('../updater.cjs').Updater, Updater);
  const states: any[] = [];
  const u = new Updater({ broadcast: (s: any) => states.push(s) });
  assert.equal(hook.updater, u);
  assert.equal(u.supported, true);
  assert.equal(u.manual, false);
  assert.equal(await u.ready, true);
  assert.equal(hook.status(), 'idle');
  // the feed is never read
  assert.equal(await u.check(), u.state);

  assert.deepEqual(hook.ready('9.9.9'), {
    status: 'ready',
    version: '1.0.0',
    available: { version: '9.9.9', notes: '' },
    error: null,
    checkedAt: u.state.checkedAt,
  });
  assert.deepEqual(u.stagedArtifact, { channel: 'stable', available: { version: '9.9.9', notes: '' }, valid: true });
  assert.equal(states.at(-1).status, 'ready');

  electron.autoUpdater.quitAndInstall();
  assert.deepEqual(quits, ['quit']);
  assert.equal(fs.readFileSync(path.join(userData, 'update-hook.log'), 'utf8'), 'quitAndInstall\n');
});

test("the stealth restart runs on the hook's clock, and only its own checks", async () => {
  const { Module, hook } = setup();
  const create = Module._load('./stealthUpdate.cjs').createStealthUpdate;
  assert.notEqual(create, createStealthUpdate);
  assert.equal(Module._load('./stealthUpdate.cjs').createStealthUpdate, create);
  let installs = 0;
  const stealth = create({
    enabled: () => true,
    ready: () => true,
    focused: () => false,
    fullScreen: () => false,
    quiet: async () => true,
    install: async () => void installs++,
  });
  assert.equal(hook.stealth, stealth);
  await hook.tick();
  assert.equal(hook.advance(IDLE_MS - 1), 1_000 + IDLE_MS - 1);
  await hook.tick();
  assert.equal(installs, 0);
  hook.advance(1);
  await hook.tick();
  assert.equal(installs, 1);
  // its 30-second timer is the hook's: nothing runs on its own, and stopping it is harmless
  stealth.stop();
});

test('other modules, and a module still loading (a require cycle), pass through untouched', () => {
  const { Module, modules, hook, loads } = setup();
  modules['./other.cjs'] = { x: 1 };
  assert.equal(Module._load('./other.cjs'), modules['./other.cjs']);
  // updater.cjs before its exports are there: left alone, and wrapped once they are
  const partial = {};
  modules['../updater.cjs'] = partial;
  assert.equal(Module._load('../updater.cjs'), partial);
  assert.deepEqual(partial, {});
  modules['../updater.cjs'] = { Updater: FakeUpdater };
  assert.notEqual(Module._load('../updater.cjs').Updater, FakeUpdater);
  modules['./stealthUpdate.cjs'] = {};
  assert.deepEqual(Module._load('./stealthUpdate.cjs'), {});
  assert.deepEqual(
    loads.filter((l) => l === 'electron'),
    ['electron'],
  );
  assert.equal(hook.updater, null);
});

test('without a profile, the restart is not recorded', () => {
  const quits: string[] = [];
  const electron = { autoUpdater: {} as any, app: { quit: () => quits.push('quit') } };
  const Module = { _load: (r: string) => (r === 'electron' ? electron : { Updater: FakeUpdater }) };
  hookUpdates({ Module, global: {}, env: {} });
  const { Updater } = Module._load('updater.cjs') as any;
  new Updater({ broadcast: () => {} });
  electron.autoUpdater.quitAndInstall();
  assert.deepEqual(quits, ['quit']);
});
