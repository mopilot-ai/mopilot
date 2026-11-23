// Unsupported automatic package execution is rejected before offers, idle queues and every managed spawn, with manual commands retained.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup } from './support/harness-updates-kit.ts';
const require = createRequire(import.meta.url);
const { HarnessRuns } = require('../electron/harness/harnessRuns.cjs');
const { spawnQuiet } = require('../electron/harness/quietRun.cjs');
const { packageOutput } = require('../electron/harness/packageOutput.cjs');
const { retireGroup } = require('../electron/platform/winbin.cjs');

test('every Windows harness and foreground or no-window package run refuses before invoking an adapter', () => {
  const runs = new HarnessRuns({
    platform: 'win32',
    pty: { spawn: () => assert.fail('no terminal process') },
    spawnQuiet: () => assert.fail('no quiet process'),
    home: () => '',
    broadcast() {},
  });
  for (const kind of ['codex', 'claude', 'acp:kimi'])
    for (const quiet of [false, true]) {
      const result = runs.launch({ kind, purpose: 'update', via: 'npm', command: 'npm update', argv: ['npm', 'update'], quiet });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'spawn');
      assert.match(result.message, /Run this command in your terminal.*unavailable on Windows/);
    }
  assert.deepEqual(runs.list(), []);
});

test('Windows automatic update offers and idle queues are blocked before any success is reported', async () => {
  const s = setup();
  s.runs.o.platform = 'win32';
  await s.updates.check();
  s.setBusy({ codex: [{ id: 'busy', title: 'working' }] });
  for (const info of s.updates.state().harnesses) {
    assert.equal(info.updatable, false);
    assert.equal(info.blockedReason, 'manual-terminal');
    assert.ok(info.command, 'the official command remains available for manual use');
    assert.equal((await s.updates.update(info.harness, { when: 'idle' })).ok, false);
    assert.equal((await s.updates.update(info.harness, { when: 'now', quiet: true })).ok, false);
  }
  assert.equal(s.updates.waits.size, 0);
  assert.equal(s.updates.pending.size, 0);
  await s.updates.updateAll();
  assert.deepEqual(s.ptys, []);
  assert.deepEqual(s.quiet, []);
});

test('manual update recommendations still require a newer compatible target', async () => {
  const s = setup({ knownBad: true });
  s.runs.o.platform = 'win32';
  await s.updates.check();
  assert.equal(s.info('codex').latestStatus, 'knownBad');
  assert.equal(s.info('codex').updatable, false);
  assert.equal(s.info('codex').blockedReason, null);
  s.latestOf['@openai/codex'] = '0.162.0';
  await s.updates.check();
  assert.equal(s.info('codex').blockedReason, null, 'an up-to-date harness needs no manual update recommendation');
});

test('the actual quiet and foreground-output boundaries refuse Windows before executing a command', async (t) => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', original));
  assert.throws(
    () =>
      spawnQuiet(['not-a-real-command'], { cwd: '.', env: {} }, { onData() {}, onExit() {} }, { spawn: () => assert.fail('no OS spawn') }),
    /unavailable on Windows/,
  );
  const foreground = packageOutput(spawnQuiet);
  assert.throws(
    () => foreground.spawn('windows-package', { command: ['not-a-real-command'], cwd: '.', env: {} }, {}),
    /unavailable on Windows/,
  );
  await assert.rejects(retireGroup({}), /manual execution.*unavailable/);
});
