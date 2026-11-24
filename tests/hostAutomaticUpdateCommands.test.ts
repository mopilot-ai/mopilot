// The SSH floor and staging commands use the active Host's updater and refuse stale or incompatible installs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { KEYS, signedFacts } from './support/hostUpdateKit.ts';

const require = createRequire(import.meta.url);
const { READ_UPDATE_FLOOR, stageAutomaticCommand } = require('../electron/host/automaticUpdateCommands.cjs');
const { createPairing } = require('../host/src/pairing.mjs');
const { createPaths } = require('../host/src/paths.mjs');
const { updatePaths, writeUpdateKey } = require('../host/src/update.mjs');
const { tryLock } = require('../host/src/pidLock.mjs');
const ACTIVE_SHA = 'a'.repeat(64);
const UPDATE_SHA = 'b'.repeat(64);
const skip = process.platform === 'win32' && 'The remote updater runs in a Unix shell';

function install(dir: string, build: string, appVersion: string, legacy = false) {
  const sources = path.join(dir, 'host', 'src');
  fs.mkdirSync(sources, { recursive: true });
  for (const name of ['paths', 'pairing', 'server']) {
    fs.writeFileSync(
      path.join(sources, `${name}.mjs`),
      `export * from ${JSON.stringify(new URL(`../host/src/${name}.mjs`, import.meta.url).href)};\n`,
    );
  }
  const api = legacy ? '{ updatePaths }' : '*';
  fs.writeFileSync(
    path.join(sources, 'update.mjs'),
    `export ${api} from ${JSON.stringify(new URL('../host/src/update.mjs', import.meta.url).href)};\n`,
  );
  fs.writeFileSync(path.join(dir, 'host', 'BUILD_ID'), build);
  fs.writeFileSync(path.join(dir, 'host', 'APP_VERSION'), appVersion);
}

function machine(t: TestContext, legacy = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-automatic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const { dataDir, configDir } = createPaths({ dataDir: path.join(dir, 'data') });
  const updates = updatePaths(dataDir);
  fs.mkdirSync(configDir, { recursive: true });
  writeUpdateKey(configDir, KEYS.pub);
  const hostId = createPairing({ configDir }).hostId();
  install(path.join(home, '.mopilot-host', 'current'), 'bootstrap', legacy ? '0.4.10' : '0.4.44', legacy);
  const run = (command: string, input?: string) =>
    spawnSync('/bin/sh', ['-c', command], {
      input,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, MOPILOT_HOST_DATA: dataDir },
      timeout: 10_000,
    });
  const activate = (build: string, appVersion: string, seq: number, tries = 0) => {
    const active = updates.version(ACTIVE_SHA);
    install(active, build, appVersion);
    fs.mkdirSync(path.join(active, 'src'));
    fs.writeFileSync(path.join(active, 'src', 'cli.mjs'), '');
    fs.writeFileSync(updates.active, JSON.stringify({ sha256: ACTIVE_SHA, version: appVersion, tries }));
    fs.writeFileSync(updates.floor, JSON.stringify({ seq, sha256: ACTIVE_SHA }));
  };
  const stage = (expected: { seq: number; build: string; appVersion: string }) => {
    // Reuse a verified cached version. The real updater still checks trust and writes the next pointer.
    fs.mkdirSync(updates.version(UPDATE_SHA), { recursive: true });
    const facts = signedFacts({ sha256: UPDATE_SHA, version: '0.4.62', url: 'archive.tgz' }, { hostId, seq: expected.seq + 1 });
    return run(stageAutomaticCommand(Buffer.from(JSON.stringify(facts)), expected), 'archive');
  };
  return { run, activate, stage, updates, configDir };
}

test('a locked bootstrap uses the active bundle and reports a missing restart acknowledgment', { skip }, (t) => {
  const host = machine(t);
  host.activate('running', '0.4.61', 42);
  const floor = host.run(`printf 'Welcome to the Host\n'\n${READ_UPDATE_FLOOR}`);
  assert.equal(floor.status, 0, floor.stderr);
  const expected = { seq: 42, build: 'running', appVersion: '0.4.61' };
  assert.equal(floor.stdout.trim(), `Welcome to the Host\nMOPILOT_UPDATE_FLOOR ${JSON.stringify(expected)}`);
  const staged = host.stage(expected);
  assert.equal(staged.status, 77, staged.stderr);
  assert.match(staged.stderr, /did not acknowledge the restart/);
  assert.equal(JSON.parse(fs.readFileSync(host.updates.next, 'utf8')).sha256, UPDATE_SHA);
});

test('an old status cannot authorize overwriting a just-activated Host at the observed floor', { skip }, (t) => {
  const host = machine(t);
  host.activate('newer', '0.4.63', 42);
  const staged = host.stage({ seq: 42, build: 'bootstrap', appVersion: '0.4.44' });
  assert.equal(staged.status, 75, staged.stderr);
  assert.equal(fs.existsSync(host.updates.next), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(host.updates.floor, 'utf8')), { seq: 42, sha256: ACTIVE_SHA });
});

test('an unlocked bootstrap or exhausted activation leaves the Host available for manual recovery', { skip }, (t) => {
  const legacy = machine(t, true);
  assert.equal(legacy.run(READ_UPDATE_FLOOR).status, 76);
  legacy.activate('running', '0.4.61', 42);
  assert.equal(legacy.run(READ_UPDATE_FLOOR).status, 76, 'the bootstrap can still write without the active bundle’s lock');
  const failed = machine(t);
  failed.activate('failed-to-serve', '0.4.63', 42, 3);
  assert.equal(failed.run(READ_UPDATE_FLOOR).status, 76, 'the bootstrap is the fallback after failed starts');
  assert.equal(fs.existsSync(failed.updates.next), false);
});

test('a competing archive accepted during transfer defers without replacing the winner', { skip }, (t) => {
  const host = machine(t);
  host.activate('running', '0.4.61', 42);
  const sha256 = 'c'.repeat(64);
  const api = JSON.stringify(new URL('../host/src/update.mjs', import.meta.url).href);
  fs.appendFileSync(
    path.join(host.updates.version(ACTIVE_SHA), 'host', 'src', 'update.mjs'),
    `import { stageUpdate as stage } from ${api};
     import fs from 'node:fs';
     export function stageUpdate(options) {
       fs.writeFileSync(${JSON.stringify(host.updates.next)}, ${JSON.stringify(JSON.stringify({ sha256, version: '0.4.63' }))});
       fs.writeFileSync(${JSON.stringify(host.updates.floor)}, ${JSON.stringify(JSON.stringify({ sha256, seq: 43 }))});
       return stage(options);
     }`,
  );
  const staged = host.stage({ seq: 42, build: 'running', appVersion: '0.4.61' });
  assert.equal(staged.status, 75, staged.stderr);
  assert.equal(JSON.parse(fs.readFileSync(host.updates.next, 'utf8')).sha256, sha256);
});

test('an in-flight trust writer defers staging even before it advances the floor', { skip }, (t) => {
  const host = machine(t);
  host.activate('running', '0.4.61', 42);
  const lock = tryLock(path.join(host.configDir, 'trust-write.lock'));
  assert.equal(lock.owned, true);
  try {
    assert.equal(host.stage({ seq: 42, build: 'running', appVersion: '0.4.61' }).status, 75);
    assert.equal(fs.existsSync(host.updates.next), false);
  } finally {
    lock.release();
  }
});
