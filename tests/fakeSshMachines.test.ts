// The fake SSH machine's seeded data and uninstall stub follow the platform supplied by its test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDirOf, fakeSshMachines } from './support/fakeSshMachines.ts';

for (const platform of ['darwin', 'linux'] as const) {
  test(`a ${platform} fake seeds and uninstalls its own socket regardless of the runner platform`, (t) => {
    const fx = fakeSshMachines(platform);
    t.after(fx.dispose);
    const home = fx.add('me@box', { running: true });
    const data = path.join(home, ...(platform === 'darwin' ? ['Library', 'Application Support'] : ['.local', 'share']), 'mopilot-host');
    assert.equal(dataDirOf(home, platform), data);
    assert.ok(fs.existsSync(path.join(data, 'host.sock')));
    const uninstall = path.join(home, '.mopilot-host', 'current', 'host', 'bin', 'mopilot-host.mjs');
    const output = execFileSync(process.execPath, [uninstall, 'uninstall'], { env: { HOME: home }, encoding: 'utf8' });
    assert.match(output, /No unit at /);
    assert.equal(fs.existsSync(path.join(data, 'host.sock')), false);
    assert.ok(fs.existsSync(path.join(data, 'threads', 'a.jsonl')));
    // A stopped machine's uninstall is still successful when there is no socket to remove.
    assert.match(execFileSync(process.execPath, [uninstall, 'uninstall'], { env: { HOME: home }, encoding: 'utf8' }), /No unit at /);
    assert.ok(fs.existsSync(path.join(home, 'Documents', 'notes.txt')));
  });
}
