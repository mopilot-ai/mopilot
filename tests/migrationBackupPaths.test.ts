// Migration backup paths cannot escape owned profile files through malformed names or links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOW, twoSegments, profile, v2Files, uiOf } from './support/migration-profile.ts';
const require = createRequire(import.meta.url);
const { runMigrations, readRegistry, migrationReport, restoreMigration } = require('../electron/migrations/migrate.cjs');
const chatRecord = require('../electron/platform/chatRecord.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-backup-paths-'));

function backupFixture(t: any) {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'profile');
  fs.renameSync(profile(), dir);
  runMigrations(dir, { now: NOW });
  const saved = readRegistry(dir).at(-1);
  const manifestFile = path.join(saved.backup, 'manifest.json');
  const row = (file: string, name: string) => ({
    path: name,
    size: fs.statSync(file).size,
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  });
  const setRows = (rows: any[]) => fs.writeFileSync(manifestFile, JSON.stringify({ createdAt: NOW, files: rows }));
  return { root, dir, saved, row, setRows };
}

for (const name of ['../outside.txt', 'threads/../../outside.txt', '/ui-state.json', 'config.json']) {
  for (const action of ['verify', 'restore']) {
    test(`migration backup ${action} rejects out-of-scope manifest path ${name}`, (t) => {
      const m = backupFixture(t);
      const source = path.join(m.saved.backup, name);
      const target = path.join(m.dir, name);
      if (name !== '/ui-state.json') {
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, 'backup payload');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'keep target');
      }
      m.setRows([m.row(source, name)]);
      const before = fs.readFileSync(target, 'utf8');
      const chats = v2Files(m.dir);
      const registry = readRegistry(m.dir);
      if (action === 'verify') {
        assert.equal(require('../electron/migrations/migrate.cjs').verifyBackup(m.saved.backup), false);
        assert.equal(migrationReport(m.dir).backupOk, false);
      } else {
        assert.equal(restoreMigration(m.dir), null);
        assert.equal(fs.readFileSync(target, 'utf8'), before);
        assert.deepEqual(v2Files(m.dir), chats);
        assert.deepEqual(readRegistry(m.dir), registry);
      }
    });
  }
}

test('migration backup rejects a canonical source path redirected by a symlink', (t) => {
  const m = backupFixture(t);
  const outside = path.join(m.root, 'outside.json');
  fs.writeFileSync(outside, 'outside payload');
  const relative = 'threads/linked.json';
  fs.symlinkSync(outside, path.join(m.saved.backup, relative));
  m.setRows([m.row(outside, relative)]);
  assert.equal(require('../electron/migrations/migrate.cjs').verifyBackup(m.saved.backup), false);
  const chats = v2Files(m.dir);
  assert.equal(restoreMigration(m.dir), null);
  assert.deepEqual(v2Files(m.dir), chats);
});

test('migration restore replaces a destination leaf link without overwriting its outside target', (t) => {
  const m = backupFixture(t);
  const outside = path.join(m.root, 'outside.json');
  fs.writeFileSync(outside, 'keep outside');
  const target = path.join(m.dir, 'threads', 'cx-switched.json');
  fs.unlinkSync(target);
  fs.symlinkSync(outside, target);
  assert.equal(restoreMigration(m.dir).result, 'restored');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep outside');
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).segments, twoSegments);
});

for (const name of [
  null,
  7,
  [],
  {},
  '',
  'threads',
  'threads/',
  'threads//file.json',
  'threads/./file.json',
  'threads/a/../file.json',
  'threads\\..\\outside.json',
]) {
  test(`migration backup rejects malformed path ${JSON.stringify(name)}`, (t) => {
    const m = backupFixture(t);
    const source = path.join(m.saved.backup, 'ui-state.json');
    m.setRows([{ ...m.row(source, 'ui-state.json'), path: name }]);
    const chats = v2Files(m.dir);
    assert.equal(require('../electron/migrations/migrate.cjs').verifyBackup(m.saved.backup), false);
    assert.equal(restoreMigration(m.dir), null);
    assert.deepEqual(v2Files(m.dir), chats);
  });
}

test('migration restore checks redirected ancestor directories and dangling links before rollback', (t) => {
  const m = backupFixture(t);
  const source = path.join(m.saved.backup, 'threads', 'nested', 'note.txt');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'nested backup');
  m.setRows([m.row(source, 'threads/nested/note.txt')]);
  const outside = path.join(m.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'note.txt'), 'keep outside');
  const redirect = path.join(m.dir, 'threads', 'nested');
  fs.symlinkSync(outside, redirect, 'junction');
  const chats = v2Files(m.dir);
  assert.throws(() => restoreMigration(m.dir), /restore.*path/i);
  assert.equal(fs.readFileSync(path.join(outside, 'note.txt'), 'utf8'), 'keep outside');
  assert.deepEqual(v2Files(m.dir), chats);
  fs.unlinkSync(redirect);
  fs.symlinkSync(path.join(m.root, 'missing'), redirect, 'junction');
  assert.throws(() => restoreMigration(m.dir), /restore.*path/i);
  assert.deepEqual(v2Files(m.dir), chats);
});

test('migration backup rejects a linked source ancestor', (t) => {
  const m = backupFixture(t);
  const outside = path.join(m.root, 'outside');
  fs.mkdirSync(outside);
  const source = path.join(outside, 'note.txt');
  fs.writeFileSync(source, 'outside backup');
  fs.symlinkSync(outside, path.join(m.saved.backup, 'threads', 'nested'), 'junction');
  m.setRows([m.row(source, 'threads/nested/note.txt')]);
  assert.equal(require('../electron/migrations/migrate.cjs').verifyBackup(m.saved.backup), false);
  assert.equal(restoreMigration(m.dir), null);
});

test('migration restore accepts missing nested destinations under a linked profile root', (t) => {
  const m = backupFixture(t);
  const source = path.join(m.saved.backup, 'threads', 'nested', 'note.txt');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'nested backup');
  const manifest = JSON.parse(fs.readFileSync(path.join(m.saved.backup, 'manifest.json'), 'utf8'));
  m.setRows([...manifest.files, m.row(source, 'threads/nested/note.txt')]);
  const alias = path.join(m.root, 'profile-alias');
  fs.symlinkSync(m.dir, alias, 'junction');
  assert.equal(require('../electron/migrations/migrate.cjs').verifyBackup(m.saved.backup), true);
  assert.equal(restoreMigration(alias).result, 'restored');
  assert.equal(fs.readFileSync(path.join(m.dir, 'threads', 'nested', 'note.txt'), 'utf8'), 'nested backup');
  assert.deepEqual(v2Files(m.dir), {});
  assert.equal(migrationReport(alias).result, 'restored');
});

test('migration restore replaces an owned hard link without overwriting its outside alias', (t) => {
  const m = backupFixture(t);
  const outside = path.join(m.root, 'outside.json');
  fs.writeFileSync(outside, 'keep outside');
  const target = path.join(m.dir, 'threads', 'cx-switched.json');
  fs.unlinkSync(target);
  fs.linkSync(outside, target);
  assert.equal(restoreMigration(m.dir).result, 'restored');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep outside');
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).segments, twoSegments);
});

test('atomic thread restore keeps existing permissions and restores private permissions for missing files', (t) => {
  const m = backupFixture(t);
  const existing = path.join(m.dir, 'threads', 'cx-switched.json');
  fs.chmodSync(existing, 0o640);
  const source = path.join(m.saved.backup, 'threads', 'nested', 'private.json');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'private backup');
  fs.chmodSync(source, 0o600);
  const manifest = JSON.parse(fs.readFileSync(path.join(m.saved.backup, 'manifest.json'), 'utf8'));
  m.setRows([...manifest.files, m.row(source, 'threads/nested/private.json')]);
  assert.equal(restoreMigration(m.dir).result, 'restored');
  assert.equal(fs.statSync(existing).mode & 0o777, 0o640);
  const restored = path.join(m.dir, 'threads', 'nested', 'private.json');
  assert.equal(fs.statSync(restored).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(restored, 'utf8'), 'private backup');
});

for (const uiOnly of [true, false]) {
  test(`migration restore checks rollback's threads root with ${uiOnly ? 'UI-only' : 'empty'} manifests`, (t) => {
    const m = backupFixture(t);
    const manifest = JSON.parse(fs.readFileSync(path.join(m.saved.backup, 'manifest.json'), 'utf8'));
    m.setRows(uiOnly ? manifest.files.filter((f: any) => f.path === 'ui-state.json') : []);
    const outside = path.join(m.root, 'outside-chats');
    fs.mkdirSync(outside);
    const file = path.join(outside, 'outside' + chatRecord.V2_EXT);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: chatRecord.SCHEMA_VERSION, id: 'outside', segments: [] }));
    const before = fs.readFileSync(file, 'utf8');
    fs.rmSync(path.join(m.dir, 'threads'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(m.dir, 'threads'), 'junction');
    const registry = readRegistry(m.dir);
    assert.throws(() => restoreMigration(m.dir), /restore.*path/i);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(readRegistry(m.dir), registry);
  });
}

test('UI-only restore rejects a non-directory threads root before recording success', (t) => {
  const m = backupFixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(m.saved.backup, 'manifest.json'), 'utf8'));
  m.setRows(manifest.files.filter((f: any) => f.path === 'ui-state.json'));
  fs.rmSync(path.join(m.dir, 'threads'), { recursive: true, force: true });
  fs.writeFileSync(path.join(m.dir, 'threads'), 'keep placeholder');
  const registry = readRegistry(m.dir);
  assert.throws(() => restoreMigration(m.dir), /restore.*threads path/i);
  assert.equal(fs.readFileSync(path.join(m.dir, 'threads'), 'utf8'), 'keep placeholder');
  assert.deepEqual(readRegistry(m.dir), registry);
});

test('UI-only restore allows a missing threads root', (t) => {
  const m = backupFixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(m.saved.backup, 'manifest.json'), 'utf8'));
  m.setRows(manifest.files.filter((f: any) => f.path === 'ui-state.json'));
  fs.rmSync(path.join(m.dir, 'threads'), { recursive: true, force: true });
  assert.equal(restoreMigration(m.dir).result, 'restored');
  assert.equal(migrationReport(m.dir).result, 'restored');
});

for (const action of ['verify', 'restore']) {
  test(`migration ${action} refuses a regular backup file named bare threads`, (t) => {
    const m = backupFixture(t);
    const source = path.join(m.saved.backup, 'threads');
    fs.rmSync(source, { recursive: true, force: true });
    fs.writeFileSync(source, 'invalid root payload');
    m.setRows([m.row(source, 'threads')]);
    const chats = v2Files(m.dir);
    if (action === 'verify') assert.equal(require('../electron/migrations/migrate.cjs').verifyBackup(m.saved.backup), false);
    else assert.equal(restoreMigration(m.dir), null);
    assert.deepEqual(v2Files(m.dir), chats);
  });
}

for (const name of ['ui-state.json', 'threads/cx-switched.json']) {
  test(`migration restore refuses directory destination ${name} before rollback`, (t) => {
    const m = backupFixture(t);
    const target = path.join(m.dir, name);
    fs.unlinkSync(target);
    fs.mkdirSync(target);
    const chats = v2Files(m.dir);
    const registry = readRegistry(m.dir);
    assert.throws(() => restoreMigration(m.dir), /restore.*file path/i);
    assert.deepEqual(v2Files(m.dir), chats);
    assert.deepEqual(readRegistry(m.dir), registry);
    assert.equal(fs.statSync(target).isDirectory(), true);
  });
}

test('migration backup refuses a directory masquerading as a thread file', (t) => {
  const m = backupFixture(t);
  const dir = path.join(m.saved.backup, 'threads', 'nested');
  fs.mkdirSync(dir);
  m.setRows([{ path: 'threads/nested', size: fs.statSync(dir).size, sha256: createHash('sha256').update('').digest('hex') }]);
  assert.equal(require('../electron/migrations/migrate.cjs').verifyBackup(m.saved.backup), false);
  assert.equal(restoreMigration(m.dir), null);
});

test('restore safely replaces a UI leaf link while preserving its outside preferences', (t) => {
  const m = backupFixture(t);
  const outside = path.join(m.root, 'shared-ui.json');
  fs.writeFileSync(outside, JSON.stringify({ prefs: { theme: 'light' }, stateVersion: chatRecord.STATE_VERSION }));
  const before = fs.readFileSync(outside, 'utf8');
  const target = path.join(m.dir, 'ui-state.json');
  fs.unlinkSync(target);
  fs.symlinkSync(outside, target);
  assert.equal(restoreMigration(m.dir).result, 'restored');
  assert.equal(fs.readFileSync(outside, 'utf8'), before);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  assert.equal(uiOf(m.dir).prefs.theme, 'light');
});

test('restore replaces a dangling leaf link and preserves private UI permissions for a missing file', (t) => {
  const m = backupFixture(t);
  const target = path.join(m.dir, 'threads', 'cx-switched.json');
  const missing = path.join(m.root, 'missing.json');
  fs.unlinkSync(target);
  fs.symlinkSync(missing, target);
  fs.unlinkSync(path.join(m.dir, 'ui-state.json'));
  fs.chmodSync(path.join(m.saved.backup, 'ui-state.json'), 0o600);
  assert.equal(restoreMigration(m.dir).result, 'restored');
  assert.equal(fs.existsSync(missing), false);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  assert.equal(fs.statSync(path.join(m.dir, 'ui-state.json')).mode & 0o777, 0o600);
});
