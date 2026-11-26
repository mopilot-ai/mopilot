// Checks macOS resolves the built permission helper's MoPilot icon without launching or installing the app.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import edition from '../../shared/edition.json';

test('macOS resolves the permission helper to the MoPilot icon', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'the permission-owning macOS app bundle is macOS only');
  test.setTimeout(240_000);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-helper-icon-'));
  try {
    // Run the ESM builder natively; Playwright transforms this spec and its static imports to CommonJS.
    execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/build-helper.mjs'), '--out', out], {
      env: { ...process.env, MOPILOT_HELPER_SIGN_IDENTITY: '-' },
      stdio: 'inherit',
      timeout: 180_000,
    });
    const app = path.join(out, 'MoPilot.app');
    const rendered = testInfo.outputPath('icons');
    const result = JSON.parse(
      execFileSync(
        'swift',
        [path.join(__dirname, 'fixtures/helper-icon.swift'), app, path.resolve(__dirname, '../../build/icon.icns'), rendered],
        { encoding: 'utf8', timeout: 60_000 },
      ),
    );
    expect(result.bundleId).toBe(`${edition.desktop.appId}.computer-use`);
    expect(result.iconFile).toBe('icon.icns');
    // Allow rasterizer rounding, while requiring a match far closer than the generic permission-page icon.
    expect(result.meanAbsoluteError).toBeLessThan(8);
    expect(result.meanAbsoluteError).toBeLessThan(result.genericMeanAbsoluteError / 4);
    for (const name of ['resolved-helper-icon.png', 'canonical-mopilot-icon.png', 'generic-app-icon.png'])
      await testInfo.attach(name, { path: path.join(rendered, name), contentType: 'image/png' });
    await testInfo.attach('icon-resolution.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
