// Real unit workers inherit the WASM lifetime guard before constructing and retiring PGlite fixtures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { coveragePlan } from '../scripts/unit-coverage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrapper = path.join(root, 'scripts/test-slots.mjs');
// A standalone child reports its own assertions and selects its one file on every parent shard; keep the shared slot.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_') && key !== 'UNIT_TEST_SHARD'));

/** A real test file, so node:test must forward the startup flag into the worker that owns the database. */
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'unit-wasm-lifetime-'));
  const file = path.join(dir, 'database.test.mjs');
  const pglite = new URL('../node_modules/@electric-sql/pglite/dist/index.js', import.meta.url).href;
  writeFileSync(
    file,
    `import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from ${JSON.stringify(pglite)};
test('the worker can construct and retire actual database fixtures', async () => {
  assert.equal(process.execArgv.includes('--no-wasm-code-gc'), true, 'worker is missing the WASM lifetime guard');
  for (let i = 0; i < 3; i++) {
    const db = new PGlite();
    try { assert.equal((await db.query('SELECT 1 AS value')).rows[0].value, 1); }
    finally { await db.close(); }
  }
  process.stdout.write('wasm-fixture-lifetimes-verified\\n');
});
`,
  );
  return { file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Check the child result and assertion marker: selecting no tests must not establish worker inheritance. */
function run(args: string[]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /wasm-fixture-lifetimes-verified/);
}

test('ordinary unit workers receive the WASM code lifetime guard before running real PGlite work', () => {
  const probe = fixture();
  try {
    run([wrapper, '--no-maglev', '--test', probe.file]);
  } finally {
    probe.dispose();
  }
});

test('coverage workers receive the same guard through the real coverage command prefix', () => {
  const probe = fixture();
  try {
    const args = coveragePlan(['tests/relayDurableGaps.test.ts'], root, { CI: 'true' }).test;
    run([...args.slice(0, args.indexOf('--test') + 1), probe.file]);
  } finally {
    probe.dispose();
  }
});

test('the wrapper leaves non-test commands outside the WASM lifetime policy', () => {
  const result = spawnSync(process.execPath, [wrapper, '-p', 'JSON.stringify(process.execArgv)'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).includes('--no-wasm-code-gc'), false);
});
