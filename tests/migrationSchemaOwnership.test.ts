// Migration and rollback preserve chat files whose schema does not establish ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { NOW, profile, v2Files } from './support/migration-profile.ts';
const require = createRequire(import.meta.url);
const { runMigrations, migrationReport } = require('../electron/migrations/migrate.cjs');
const v2 = require('../electron/migrations/2026-10-threads-v2.cjs');
const chatRecord = require('../electron/platform/chatRecord.cjs');

for (const version of [undefined, null, 0, -1, 1.5, 2.5, '2', 'future', true, {}, []]) {
  test(`rollback preserves a chat with unowned schema ${JSON.stringify(version)}`, (t) => {
    const dir = profile();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'threads', 'cx-switched.v2');
    const original = JSON.stringify({ id: 'cx-switched', schemaVersion: version, private: 'foreign data' });
    fs.writeFileSync(file, original);
    v2.rollback({ userData: dir });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
  test(`migration preserves a chat with unowned schema ${JSON.stringify(version)}`, (t) => {
    const dir = profile();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'threads', 'cx-switched.v2');
    const original = JSON.stringify({ id: 'cx-switched', schemaVersion: version, private: 'foreign data' });
    fs.writeFileSync(file, original);
    const result = runMigrations(dir, { now: NOW })[0];
    assert.equal(result.result, 'failed');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.ok(migrationReport(dir).report.failed.includes('cx-switched'));
  });
}
for (const original of ['null', 'false', '0', '""', '{ torn']) {
  test(`migration preserves a present non-record chat ${original}`, (t) => {
    const dir = profile();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'threads', 'cx-switched.v2');
    fs.writeFileSync(file, original);
    assert.equal(runMigrations(dir, { now: NOW })[0].result, 'failed');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
}

test('rollback owns valid older/current records and leaves future records intact', (t) => {
  const dir = profile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const version of [1, 2, 3]) {
    const id = `version-${version}`;
    fs.writeFileSync(path.join(dir, 'threads', `${id}.v2`), JSON.stringify({ id, schemaVersion: version }));
  }
  v2.rollback({ userData: dir });
  assert.deepEqual(Object.keys(v2Files(dir)), ['version-3.v2']);
});

test('schema ownership rejects unsafe integers instead of coercing them', () => {
  assert.equal(chatRecord.schemaVersionOf({ schemaVersion: Number.MAX_SAFE_INTEGER }), Number.MAX_SAFE_INTEGER);
  for (const value of [Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity])
    assert.equal(chatRecord.schemaVersionOf({ schemaVersion: value }), null);
});

test('migration preserves a present dangling chat link as unowned data', (t) => {
  const dir = profile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'threads', 'cx-switched.v2');
  const target = path.join(dir, 'missing-foreign');
  fs.symlinkSync(target, file);
  assert.equal(runMigrations(dir, { now: NOW })[0].result, 'failed');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(file), target);
  assert.equal(fs.existsSync(target), false);
});
