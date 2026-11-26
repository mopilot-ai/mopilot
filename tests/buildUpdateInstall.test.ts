// Builds the macOS update installer with the release builder and runs its native activation tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildUpdateInstall } from '../scripts/build-update-install.mjs';
import { tempDir } from './support/scripts-shared-cli.ts';

if (process.argv[2] === '--build-fixture') {
  const out = process.argv[3];
  assert.equal(buildUpdateInstall({ out, sign: false }), path.join(out, 'update-install'));
} else {
  test('the packaged updater builds for real and its native activation tests pass', { skip: process.platform !== 'darwin' }, (t) => {
    const out = tempDir('update-install-test-');
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const env = { ...process.env, SWIFTPM_BUILD_DIR: path.join(out, 'swift-build') };
    const buildOptions = { env, stdio: 'inherit', timeout: 90_000 } as const;
    // The release builder is synchronous, so enforce its deadline from the process that launches it.
    execFileSync(process.execPath, [import.meta.filename, '--build-fixture', out], buildOptions);
    assert.match(execFileSync('/usr/bin/file', ['-b', path.join(out, 'update-install')], { encoding: 'utf8' }), /Mach-O 64-bit executable/);
    execFileSync('swift', ['test', '--package-path', 'native/update-install'], buildOptions);
  });
}
