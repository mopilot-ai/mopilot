// The video module removes only files inside the picker's cache folder (#5638): compiled with swiftc and run against a real folder where one is installed (a Mac), skipped where none is. A skip is not a pass: on a machine without swiftc nothing here ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
/** How swiftc is run here: itself, or through xcrun when only that finds it; null where there is none. */
const compiler: string[] | null =
  spawnSync('swiftc', ['--version']).status === 0
    ? ['swiftc']
    : spawnSync('xcrun', ['--find', 'swiftc']).status === 0
      ? ['xcrun', 'swiftc']
      : null;

test('a path from outside the picker folder, a .. path, a link out, a sibling folder and a non-file URL are not the module’s to remove; the launch sweep takes only old videos that are regular files, by when they arrived, and what an earlier launch tracked or half wrote goes whatever its age', {
  skip: !compiler && 'no swiftc here: this test did not run',
}, () => {
  const out = mkdtempSync(join(tmpdir(), 'pickerpaths-'));
  try {
    const exe = join(out, 'check');
    const [command, ...front] = compiler as string[];
    execFileSync(
      command,
      [
        ...front,
        '-parse-as-library',
        here('mobile/modules/mopilot-video/ios/PickerPaths.swift'),
        here('tests/swift/pickerPaths/driver.swift'),
        '-o',
        exe,
      ],
      {
        stdio: 'pipe',
      },
    );
    assert.equal(execFileSync(exe, { encoding: 'utf8' }).trim(), 'OK');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
