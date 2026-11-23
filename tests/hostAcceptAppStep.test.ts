// Step S11b of the acceptance run's M5 milestone (scripts/host-accept/milestones/m5.mjs): the real-app spec runs where the machine says, and only two passes count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSteps } from '../scripts/host-accept.mjs';
import { MILESTONES } from '../scripts/host-accept/milestones/index.mjs';

const step = MILESTONES.M5.find((s: any) => s.id === 'S11b')!;

/** A machine that answers the spec's command with `stdout` and `code`, and records every command and its options. */
function run(stdout: string, code = 0, opts: object = { appRepo: '~/mopilot', awayMin: 5 }) {
  const commands: any[] = [];
  const m = {
    run: async (command: string, _input?: Buffer, o?: object) => {
      commands.push([command, o]);
      return command.includes('host-local-quit.spec.ts') ? { code, stdout, stderr: '' } : { code: 0, stdout: '', stderr: '' };
    },
  };
  return runSteps({ steps: [step as any], ctx: { m, opts } }).then((rows) => ({ row: rows[0], commands }));
}

test('I: M5/S11b: a real app’s spec runs where the machine says, and only two passes count', async () => {
  const ok = await run('  2 passed (3.1m)\n');
  assert.equal(ok.row.status, 'PASS', ok.row.detail);
  assert.match(ok.row.detail, /2 passed.*5 min away/);
  const [uninstall, spec] = ok.commands;
  assert.match(uninstall[0], / uninstall$/, 'this run’s own Host goes before the app installs its own');
  assert.match(spec[0], /^cd ~\/mopilot && MOPILOT_ACCEPT_VM=1 S11_AWAY_MS=300000 .*host-local-quit\.spec\.ts/);
  assert.equal(spec[1].timeoutMs, 30 * 60_000);
  assert.doesNotMatch((await run('  2 passed\n', 0, { appRepo: '~/mopilot', awayMin: 0 })).commands[1][0], /S11_AWAY_MS/);
  for (const stdout of ['  1 failed\n  1 passed\n', '  2 skipped\n', '  1 passed\n', '']) {
    const bad = await run(stdout);
    assert.equal(bad.row.status, 'FAIL', stdout);
    assert.match(bad.row.detail, /did not pass both tests/);
  }
  assert.equal((await run('  2 passed\n', -1)).row.status, 'FAIL', 'a run cut off by the limit is not a pass');
  const skipped = (await run('', 0, { appRepo: '', awayMin: 0 })).row;
  assert.equal(skipped.status, 'SKIP');
  assert.match(skipped.detail, /No --app-repo/);
});
