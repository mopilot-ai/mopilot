// The Host acceptance run's clean-up (scripts/host-accept/steps.mjs): what it removes from a machine and what it must leave alone, run for real against scratch folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup, removeTestAgent } from '../scripts/host-accept/steps.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-accept-cleanup-test-')));

test('W: cleanup leaves a data folder alone unless it is plainly the Host’s', async () => {
  const commands: string[] = [];
  const m = { run: async (c: string) => (commands.push(c), { code: 0, stdout: '', stderr: '' }) };
  await cleanup({ m, state: { dataDir: '/home/me/Documents' } });
  await cleanup({ m, state: {} });
  assert.ok(commands.every((c) => !c.includes('rm -rf "/home/me/Documents"')));
  assert.ok(commands.filter((c) => c.includes('uninstall')).every((c) => c.endsWith('$HOME/.mopilot-accept ')));
});

test('W: the run’s test agent goes from a machine, also from a Host that stays: its files and only its own entry', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'agent-'));
  fs.mkdirSync(path.join(dir, 'accept-agent', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'harnesses.json'), JSON.stringify({ fake: { bin: 'node' }, mine: { bin: '/usr/local/bin/mine' } }));
  // run for real on this machine: the shell and node the step gives the machine
  const local = {
    run: async (c: string) => {
      const r = spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8' });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
  };
  await removeTestAgent({ m: local, state: { dataDir: dir, nodePath: process.execPath } });
  assert.equal(fs.existsSync(path.join(dir, 'accept-agent')), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, 'harnesses.json'), 'utf8')),
    { mine: { bin: '/usr/local/bin/mine' } },
    'the person’s own entry stays',
  );
  // a file that only held the test agent goes; no file, or one that is not JSON, is left as it is
  fs.writeFileSync(path.join(dir, 'harnesses.json'), JSON.stringify({ fake: {} }));
  await removeTestAgent({ m: local, state: { dataDir: dir, nodePath: process.execPath } });
  assert.equal(fs.existsSync(path.join(dir, 'harnesses.json')), false);
  await removeTestAgent({ m: local, state: { dataDir: dir, nodePath: process.execPath } });
  fs.writeFileSync(path.join(dir, 'harnesses.json'), 'not json');
  await removeTestAgent({ m: local, state: { dataDir: dir } });
  assert.equal(fs.readFileSync(path.join(dir, 'harnesses.json'), 'utf8'), 'not json');
  // a run that never learned its data folder touches nothing
  const none: string[] = [];
  await removeTestAgent({ m: { run: async (c: string) => (none.push(c), { code: 0, stdout: '', stderr: '' }) }, state: {} });
  assert.deepEqual(none, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
