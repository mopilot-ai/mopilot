// Verifies a real packaged registry install keeps ownership until its TERM-resistant package script and writer retire.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Creates a first-install script that stays alive; the verified retry can install the same pinned package normally. */
export function installerStopFixture({ scratch, packageDir, write }) {
  const stateFile = path.join(scratch, 'installer-processes.json');
  const writes = path.join(scratch, 'installer-writes');
  const allow = path.join(scratch, 'allow-install');
  const identitySource = `const identity = (pid) => {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/);
    return { pid, birth: fields[19] };
  };`;
  write(
    path.join(packageDir, 'postinstall.cjs'),
    `const fs = require('node:fs');
if (!fs.existsSync(${JSON.stringify(allow)})) {
  process.on('SIGTERM', () => {});
  require('node:child_process').spawn(process.execPath, [require('node:path').join(__dirname, 'writer.cjs')], { stdio: 'inherit' });
}
`,
  );
  write(
    path.join(packageDir, 'writer.cjs'),
    `const fs = require('node:fs');
process.on('SIGTERM', () => {});
${identitySource}
fs.appendFileSync(${JSON.stringify(writes)}, '.');
fs.writeFileSync(${JSON.stringify(`${stateFile}.tmp`)}, JSON.stringify([identity(process.ppid), identity(process.pid)]));
fs.renameSync(${JSON.stringify(`${stateFile}.tmp`)}, ${JSON.stringify(stateFile)});
setInterval(() => fs.appendFileSync(${JSON.stringify(writes)}, '.'), 10);
`,
  );
  const manifest = path.join(packageDir, 'package.json');
  write(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), scripts: { postinstall: 'node postinstall.cjs' } }));

  const alive = ({ pid, birth }) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return (
        stat
          .slice(stat.lastIndexOf(')') + 1)
          .trim()
          .split(/\s+/)[19] === birth
      );
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
      throw error;
    }
  };

  return async (page, userData, output) => {
    let identities = [];
    const row = page.locator('[data-registry-agent="linux-check"]');
    try {
      await row.getByRole('button', { name: 'Install', exact: true }).click();
      await expect.poll(() => fs.existsSync(stateFile), { timeout: 30_000 }).toBe(true);
      identities = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(identities.length, 2);
      assert.ok(identities.every(alive), 'Both real package descendants must be alive before Stop.');
      const registryDir = path.join(userData, 'registry-agents');
      const stages = fs.readdirSync(registryDir).filter((name) => name.startsWith('.install-'));
      assert.equal(stages.length, 1);
      const stage = path.join(registryDir, stages[0]);
      const running = await page.evaluate(async () =>
        (await window.native.harnessRuns.list()).find((run) => run.kind === 'acp:registry-linux-check' && run.state === 'running'),
      );
      assert.ok(running);
      const runOf = () => page.evaluate(async (id) => (await window.native.harnessRuns.list()).find((run) => run.id === id), running.id);
      const before = fs.statSync(writes).size;
      const started = Date.now();
      await row.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(row.getByRole('status')).toHaveText('Stopping…');
      await expect(row.getByRole('button', { name: 'Installing…', exact: true })).toBeDisabled();
      await expect.poll(() => fs.statSync(writes).size).toBeGreaterThan(before);
      assert.equal((await runOf()).state, 'running', 'Stop cannot publish completion while the writer remains active.');
      assert.equal(fs.existsSync(stage), true, 'The staging owner must remain while the script retires.');
      assert.ok(identities.every(alive), 'TERM-resistant descendants must remain owned during escalation.');
      await expect.poll(async () => (await runOf()).checked, { timeout: 30_000 }).toBe(true);
      const finished = await runOf();
      assert.equal(finished.state, 'exited');
      assert.equal(finished.stopped, true);
      assert.equal(finished.code, null);
      assert.ok(
        identities.every((identity) => !alive(identity)),
        'Completion requires actual descendant disappearance.',
      );
      await expect.poll(() => fs.existsSync(stage)).toBe(false);
      await expect(row.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
      const completedWrites = fs.statSync(writes).size;
      await pause(150);
      assert.equal(fs.statSync(writes).size, completedWrites, 'No package writes may occur after completion.');
      write(
        path.join(output, 'installer-stop.json'),
        JSON.stringify({ ok: true, durationMs: Date.now() - started, before, completedWrites }, null, 2),
      );
      write(allow, 'verified retirement; allow the ordinary install retry');
    } finally {
      // Only this fixture's exact kernel-born PIDs may be cleaned up after a failed assertion.
      for (const identity of identities) if (alive(identity)) process.kill(identity.pid, 'SIGKILL');
    }
  };
}
