// Type-check actual controller callers so awaited receipts cannot widen the existing synchronous intent API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('controller send keeps synchronous intents and Promise delivery receipts distinct', () => {
  const require = createRequire(import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
      '--ignoreConfig',
      '--noEmit',
      '--allowJs',
      '--skipLibCheck',
      '--module',
      'preserve',
      '--moduleResolution',
      'bundler',
      '--target',
      'ES2022',
      '--strictNullChecks',
      fileURLToPath(new URL('./support/send-receipt-api.mts', import.meta.url)),
      fileURLToPath(new URL('../electron/session/controller.cjs', import.meta.url)),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
