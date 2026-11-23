// Loads the real E2E setup through Playwright's transformer without invoking setup or launching the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { referencesOf } from '../scripts/source-references.mjs';

export const GUARDS = ['tests/e2e/', 'scripts/linux-pty.mjs', 'package.json', 'package-lock.json'];

test('Playwright can load its global setup with its CommonJS transform active', () => {
  const script = `
    const path = require('node:path');
    const { transform } = require(path.join(path.dirname(require.resolve('playwright/package.json')), 'lib/common/index.js'));
    transform.requireOrImport(process.argv[1]).then(
      (setup) => process.exit(typeof setup.default === 'function' ? 0 : 2),
      (error) => { console.error(error); process.exit(1); },
    );
  `;
  const result = spawnSync(process.execPath, ['--eval', script, path.join(import.meta.dirname, 'e2e/global-setup.ts')], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const references = referencesOf('tests/e2e/global-setup.ts', readFileSync(new URL('./e2e/global-setup.ts', import.meta.url), 'utf8'));
  assert.ok(references.has('scripts/linux-pty.mjs'), 'the source parser must retain the literal terminal helper path');
  assert.equal(
    [...references].some((file) => file.startsWith('tests/e2e/') && file.endsWith('.spec.ts')),
    false,
    'the compiler bootstrap must not make global setup depend on unrelated E2E specs',
  );
});
