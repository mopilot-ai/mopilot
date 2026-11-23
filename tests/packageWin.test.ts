// Windows installer configuration, signing and failure paths, independent of the app folder's platform packaging.
import edition from '../shared/edition.json' with { type: 'json' };
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { recorder, runScript } from './support/scripts-shared-cli.ts';
import { checkBuilderConfig } from './support/builder-schema.ts';
const win = await import('../scripts/package-win.mjs');
const { desktop } = edition;
const pkg = { productName: 'MoPilot', version: '1.2.0' };

test('installer: the NSIS options name the product and never publish', () => {
  const o = win.builderOptions('x64', 'out/dir');
  assert.equal(o.prepackaged, 'out/dir');
  assert.equal(o.publish, 'never');
  assert.equal(o.config.nsis.shortcutName, desktop.name);
  assert.equal(o.config.nsis.perMachine, false);
  assert.equal(win.builderOptions('arm64', 'd').config.productName, desktop.name);
  // electron-builder checks the configuration before it builds: one it refuses stops the release
  for (const arch of ['x64', 'arm64']) assert.doesNotThrow(() => checkBuilderConfig(win.builderOptions(arch, 'd').config));
});

test('installer: signs the app and the installer with MOPILOT_WIN_SIGN around the build', async () => {
  const exec = recorder();
  const builder = recorder(async () => {});
  const log = recorder();
  const setup = await win.packageWin(['--arch', 'arm64'], {
    env: { MOPILOT_WIN_SIGN: '/sign' },
    pkg,
    builder: builder as any,
    exec,
    exists: () => true,
    stat: () => ({ size: 3 * 1048576 }) as any,
    log,
    warn: () => assert.fail('signed'),
  });
  assert.equal(setup, path.join('out', `${desktop.artifactPrefix}-Setup-1.2.0-arm64.exe`));
  assert.deepEqual(
    exec.calls.map((c) => c.slice(0, 2)),
    [
      ['/sign', [path.join('out', `${desktop.name}-win32-arm64`, `${desktop.name}.exe`)]],
      ['/sign', [setup]],
    ],
  );
  assert.equal(builder.calls[0][0].prepackaged, path.join('out', `${desktop.name}-win32-arm64`));
  assert.deepEqual(log.calls.at(-1), [`Installer: ${setup} (3.0 MB)`]);
});

test('installer: unsigned without MOPILOT_WIN_SIGN; a missing app or installer is an error', async () => {
  const warn = recorder();
  await win.packageWin([], {
    env: {},
    pkg,
    builder: (async () => {}) as any,
    exec: () => assert.fail('no signing'),
    exists: () => true,
    stat: () => ({ size: 0 }) as any,
    log: () => {},
    warn,
  });
  assert.deepEqual(warn.calls, [['MOPILOT_WIN_SIGN not set: the app and installer are unsigned.']]);
  const error = recorder();
  assert.equal(await win.main([], { env: {}, pkg, builder: async () => {}, exists: (f: string) => !f.includes('Setup'), error } as any), 1);
  assert.equal(error.calls[0][0], `electron-builder finished without ${path.join('out', `${desktop.artifactPrefix}-Setup-1.2.0-x64.exe`)}`);
  assert.equal(
    await win.main([], {
      env: {},
      pkg,
      builder: async () => {},
      exists: () => true,
      stat: () => ({ size: 0 }),
      log: () => {},
      warn: () => {},
    } as any),
    0,
  );
  const r = runScript('scripts/package-win.mjs', ['--arch', 'nonexistent']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`${path.join('out', `${desktop.name}-win32-nonexistent`, `${desktop.name}.exe`)} not found`));
});
