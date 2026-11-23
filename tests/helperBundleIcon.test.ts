// Verifies the permission-owning helper bundles MoPilot's canonical icon before signing or publishing.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { buildHelper } from '../scripts/build-helper.mjs';
import { tempDir } from './support/scripts-shared-cli.ts';

const source = fileURLToPath(new URL('../build/icon.icns', import.meta.url));

function assertBundleIcon(app: string) {
  const info = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
  const name = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(info)?.[1];
  assert.equal(name, 'icon.icns', 'the permission-owning bundle declares its branded icon');
  const icon = fs.readFileSync(path.join(app, 'Contents/Resources', name));
  assert.deepEqual(icon, fs.readFileSync(source), 'the helper uses the same complete icon as the main app');
  assert.equal(icon.toString('ascii', 0, 4), 'icns');
  assert.equal(icon.readUInt32BE(4), icon.length, 'the copied ICNS container is complete');
}

for (const mode of [
  { name: 'unsigned package', sign: false, identity: '' },
  { name: 'ad-hoc development', sign: true, identity: '-' },
  { name: 'certificate development', sign: true, identity: 'Apple Development: Test (AB12CD34EF)' },
  { name: 'Developer ID release', sign: true, identity: 'Developer ID Application: Test (AB12CD34EF)' },
]) {
  test(`helper icon: ${mode.name} contains the main app icon before signing`, (t) => {
    const dir = tempDir('helper icon 🙂 ');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'ComputerUseHelper'), '#!/bin/sh\n');
    let signatures = 0;
    const exec = ((cmd: string, args: string[]) => {
      if (cmd === 'codesign') {
        assertBundleIcon(args.at(-1)!);
        signatures++;
      }
      return args.includes('--show-bin-path') ? dir : '';
    }) as any;
    const app = buildHelper({
      out: dir,
      env: { MOPILOT_HELPER_SIGN_IDENTITY: mode.identity },
      sign: mode.sign,
      log: () => {},
      exec,
      platform: 'darwin',
    });
    assertBundleIcon(app);
    assert.equal(signatures, mode.sign ? 2 : 0);
  });
}

test('helper icon: a missing required icon fails before signing or unsigned publication', (t) => {
  const dir = tempDir('helper-icon-missing-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ComputerUseHelper'), '#!/bin/sh\n');
  const copy = fs.copyFileSync;
  const mocked = mock.method(fs, 'copyFileSync', (from: fs.PathLike, to: fs.PathLike, flags?: number) => {
    if (String(from) === source) throw Object.assign(new Error('MoPilot icon is missing'), { code: 'ENOENT' });
    return copy(from, to, flags);
  });
  syncBuiltinESMExports();
  try {
    for (const sign of [true, false]) {
      assert.throws(
        () =>
          buildHelper({
            out: dir,
            env: {},
            sign,
            log: () => {},
            platform: 'darwin',
            exec: ((cmd: string, args: string[]) => {
              assert.equal(cmd, 'swift', 'no signing starts without its required icon');
              return args.includes('--show-bin-path') ? dir : '';
            }) as any,
          }),
        /MoPilot icon is missing/,
      );
    }
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
