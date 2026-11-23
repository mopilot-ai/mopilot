// electron/migrations/migrate.cjs and electron/migrations/2026-10-threads-v2.cjs: the failure paths — a legacy
// profile that can't be moved, backups that don't verify, a full or unreadable disk, damaged registry,
// report and ui-state files, and v2 records that are partial, newer or can't be written.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import edition from '../shared/edition.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const mig = require('../electron/migrations/migrate.cjs');
const v2 = require('../electron/migrations/2026-10-threads-v2.cjs');
const chatRecord = require('../electron/platform/chatRecord.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'migcov-'));
const write = (file: string, data: any) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
};
const NOW = Date.UTC(2026, 9, 10);
afterEach(() => mock.restoreAll());

/* migrateUserData */

test('legacy profile: none to move, rename falls back to a copy, a copy that fails moves nothing, the marker is best effort', () => {
  const appData = tmp();
  const target = path.join(appData, edition.desktop.profile);
  const legacy = path.join(appData, 'Sage Codex');
  assert.equal(mig.migrateUserData(appData, target), null);

  write(path.join(legacy, 'ui-state.json'), {});
  const rename = mock.method(fs, 'renameSync', () => {
    throw new Error('EXDEV');
  });
  const migrated = mig.migrateUserData(appData, target);
  if (!edition.desktop.legacyProfiles.length) {
    assert.equal(migrated, null);
    assert.equal(rename.mock.callCount(), 0);
    assert.ok(fs.existsSync(legacy));
    assert.ok(!fs.existsSync(target));
    return;
  }
  assert.equal(migrated, legacy);
  assert.equal(rename.mock.callCount(), 1);
  assert.ok(fs.existsSync(path.join(target, 'ui-state.json')));
  assert.ok(fs.existsSync(legacy)); // copied, not moved
  assert.equal(fs.readFileSync(path.join(target, '.migrated-from'), 'utf8'), legacy);

  const t2 = path.join(appData, 'Other');
  mock.method(fs, 'cpSync', () => {
    throw new Error('ENOSPC');
  });
  assert.equal(mig.migrateUserData(appData, t2), null);
  mock.restoreAll();

  const t3 = path.join(appData, 'Third');
  mock.method(fs, 'writeFileSync', () => {
    throw new Error('EROFS');
  });
  assert.equal(mig.migrateUserData(appData, t3), legacy);
  mock.restoreAll();
  assert.equal(fs.existsSync(path.join(t3, '.migrated-from')), false);
});

/* backups */

test('backup: a copy that does not verify throws; verify fails on a missing file; prune tolerates no folder and no manifest', () => {
  const ud = tmp();
  write(path.join(ud, 'ui-state.json'), { a: 1 });
  write(path.join(ud, 'threads', 't.json'), { id: 't' });
  // the size read back after copying differs from what verify sees
  const realStat = fs.statSync;
  let n = 0;
  mock.method(fs, 'statSync', (p: string, ...rest: any[]) => {
    const s: any = realStat(p, ...rest);
    return s && String(p).includes(`${path.sep}backups${path.sep}`) ? { ...s, size: s.size + n++ } : s;
  });
  assert.throws(() => mig.backup(ud, 'pre-v2', NOW), /backup did not verify/);
  mock.restoreAll();

  const dir = mig.backup(ud, 'pre-v2', NOW + 1000);
  assert.equal(mig.verifyBackup(dir), true);
  fs.rmSync(path.join(dir, 'threads', 't.json'));
  assert.equal(mig.verifyBackup(dir), false);
  assert.equal(mig.verifyBackup(path.join(ud, 'nowhere')), false);

  mig.pruneBackups(tmp(), 'pre-v2', NOW); // no backups folder: nothing to do
  const root = path.join(ud, 'backups');
  for (const name of ['pre-v2-1', 'pre-v2-2', 'pre-v2-3', 'pre-v2-4']) fs.mkdirSync(path.join(root, name), { recursive: true });
  mig.pruneBackups(ud, 'pre-v2', NOW);
  // without a manifest a backup counts as created at 0, so all but the newest are past 90 days
  assert.deepEqual(
    fs.readdirSync(root).filter((n) => /^pre-v2-\d$/.test(n)),
    ['pre-v2-4'],
  );
});

test('registry: a non-array file reads as empty', () => {
  const ud = tmp();
  write(path.join(ud, 'migrations.json'), { not: 'a list' });
  assert.deepEqual(mig.readRegistry(ud), []);
  assert.equal(mig.lastEntry(ud, 'x'), null);
});

test('backup of a profile folder that does not exist yet is an empty, verified backup', () => {
  const ud = path.join(tmp(), 'not-yet');
  const dir = mig.backup(ud, 'pre-v2', NOW);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), { createdAt: NOW, files: [] });
});

/* runMigration with a fake migration */

const fake = (r: any, extra: any = {}) => ({
  id: 'fake-1',
  STATE_VERSION: 2,
  runs: 0,
  rolledBack: 0,
  run() {
    this.runs++;
    return r;
  },
  rollback() {
    this.rolledBack++;
  },
  ...extra,
});

test('runMigration: a recorded result without a report, a null ui-state, the clock and statfs defaults', () => {
  const ud = tmp();
  mig.record(ud, { id: 'fake-1', result: 'failed' });
  assert.deepEqual(mig.runMigration(fake({ ok: true }), ud), { id: 'fake-1', result: 'failed', report: null });

  const ud2 = tmp();
  write(path.join(ud2, 'ui-state.json'), 'null');
  const realStatfs = fs.statfsSync;
  let asked = 0;
  mock.method(fs, 'statfsSync', (p: string) => (asked++, realStatfs(p)));
  const m = fake({ ok: true, before: { chats: 'x' }, written: 'n/a' });
  const before = Date.now();
  const r = mig.runMigration(m, ud2);
  assert.equal(asked, 1);
  assert.equal(r.result, 'ok');
  assert.deepEqual(r.counts, { migrated: 0, skipped: 0, failed: 0 });
  // the ui-state that read as null is not rewritten; there is no migratePrefs step
  assert.equal(fs.readFileSync(path.join(ud2, 'ui-state.json'), 'utf8'), 'null');
  const e = mig.lastEntry(ud2, 'fake-1');
  assert.ok(e.at >= before);
  assert.equal(e.appVersion, null);
});

test('runMigration: an unreadable disk counts as free space; a failed run rolls back and counts its failures', () => {
  const ud = tmp();
  write(path.join(ud, 'ui-state.json'), { stateVersion: 1 });
  mock.method(fs, 'statfsSync', () => {
    throw new Error('ENOSYS');
  });
  const m = fake({ ok: false, before: { chats: 5 }, after: {}, failed: ['a', 'b'], written: 1 });
  const r = mig.runMigration(m, ud, { now: NOW, freeBytes: undefined });
  assert.equal(r.result, 'failed');
  assert.equal(m.rolledBack, 1);
  assert.deepEqual(r.counts, { migrated: 1, skipped: 2, failed: 2 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(ud, 'ui-state.json'), 'utf8')).stateVersion, 1);
});

/* reports, restore and retry */

test('migrationReport: entries without a report, version or backup', () => {
  const ud = tmp();
  assert.equal(mig.migrationReport(ud), null);
  mig.record(ud, { id: v2.ID, result: 'failed' });
  assert.deepEqual(mig.migrationReport(ud), {
    id: v2.ID,
    result: 'failed',
    at: null,
    appVersion: null,
    report: null,
    backup: null,
    backupOk: false,
  });
});

test('restoreMigration: unknown ids and missing backups return null; a null ui-state on either side still restores', () => {
  const ud = tmp();
  assert.equal(mig.restoreMigration(ud, 'nope'), null);
  assert.equal(mig.restoreMigration(ud), null);
  mig.record(ud, { id: v2.ID, result: 'failed', backup: 42 });
  assert.equal(mig.restoreMigration(ud), null);

  write(path.join(ud, 'ui-state.json'), 'null');
  const dir = mig.backup(ud, 'pre-v2', NOW);
  mig.record(ud, { id: v2.ID, result: 'ok', backup: dir });
  write(path.join(ud, 'ui-state.json'), 'null');
  const before = Date.now();
  const e = mig.restoreMigration(ud);
  assert.equal(e.result, 'restored');
  assert.equal(e.report, null);
  assert.ok(e.at >= before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ud, 'ui-state.json'), 'utf8')), {});
});

test('retryMigration: an unknown id does nothing', () => {
  const ud = tmp();
  mig.record(ud, { id: v2.ID, result: 'failed' });
  assert.equal(mig.retryMigration(ud, 'nope'), null);
  assert.equal(mig.readRegistry(ud).length, 1);
});

/* threads-v2 */

test('threads-v2: a null ui-state and no threads folder mean no chats; rollback without a folder is a no-op', () => {
  const ud = tmp();
  write(path.join(ud, 'ui-state.json'), 'null');
  const r = v2.run({ userData: ud, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.before.chats, 0);
  v2.rollback({ userData: ud });
  assert.equal(fs.existsSync(path.join(ud, 'threads')), false);
});

test('threads-v2: a partial existing record is filled from the legacy data; a newer record is counted but kept', () => {
  const ud = tmp();
  write(path.join(ud, 'ui-state.json'), { pinned: { 'cx-a': true, 'cx-new': true } });
  const threads = path.join(ud, 'threads');
  write(path.join(threads, 'cx-a.v2'), { schemaVersion: 2, id: 'cx-a', segments: [] });
  write(path.join(threads, 'cx-new.v2'), { schemaVersion: 3, id: 'cx-new' });
  const r = v2.run({ userData: ud, now: NOW });
  const a = JSON.parse(fs.readFileSync(path.join(threads, 'cx-a.v2'), 'utf8'));
  assert.deepEqual(a.segments, [chatRecord.legacyFirstSegment('cx-a')]);
  assert.equal(a.meta.pinned, true);
  assert.equal(a.updatedAt, NOW);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(threads, 'cx-new.v2'), 'utf8')), { schemaVersion: 3, id: 'cx-new' });
  // the newer record has no meta, so its pin isn't counted: before and after differ
  assert.equal(r.before.pinned, 2);
  assert.equal(r.after.pinned, 1);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, []);
});

test('threads-v2: a chat whose v2 file cannot be written is reported as failed', () => {
  const ud = tmp();
  write(path.join(ud, 'ui-state.json'), { pinned: { 'cx-b': true } });
  fs.mkdirSync(path.join(ud, 'threads', 'cx-b.v2'), { recursive: true });
  const r = v2.run({ userData: ud, now: NOW });
  assert.deepEqual(r.failed, ['cx-b']);
  assert.equal(r.written, 0);
  assert.equal(r.ok, false);
});

test('threads-v2 prefs: malformed preferences and saved recordings cannot establish cloud consent', () => {
  const ud = tmp();
  write(path.join(ud, 'ui-state.json'), { prefs: ['bad'] });
  assert.deepEqual(v2.migratePrefs(ud), { dictationEngine: null });
  write(path.join(ud, 'recordings', 'r1.wav'), 'x');
  assert.deepEqual(v2.migratePrefs(ud), { dictationEngine: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ud, 'ui-state.json'), 'utf8')).prefs, ['bad']);
  write(path.join(ud, 'ui-state.json'), 'null');
  assert.deepEqual(v2.migratePrefs(ud), { dictationEngine: null });
});

test('threads-v2 reports damaged legacy segments per chat and still processes healthy chats', () => {
  const ud = tmp();
  const invalid = [null, {}, { nativeId: 7 }, { nativeId: '' }, { harness: 'claude', nativeId: 'claude:' }];
  for (const [i, segment] of invalid.entries()) write(path.join(ud, 'threads', `bad-${i}.json`), { id: `bad-${i}`, segments: [segment] });
  write(path.join(ud, 'threads', 'good.json'), { id: 'good', segments: [{ harness: 'claude', nativeId: 'claude:ok' }] });
  const result = v2.run({ userData: ud, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.failed,
    invalid.map((_, i) => `bad-${i}`),
  );
  assert.equal(result.written, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ud, 'threads', 'good.v2'), 'utf8')).segments[0].nativeId, 'ok');
  assert.deepEqual(
    chatRecord.legacyRecords(ud, NOW).map((r: any) => r.id),
    ['good'],
  );
  fs.rmSync(ud, { recursive: true, force: true });
});

test('legacy segment files cannot replace a sibling whose id they claim', (t) => {
  const ud = tmp();
  t.after(() => fs.rmSync(ud, { recursive: true, force: true }));
  const dir = path.join(ud, 'threads');
  write(path.join(dir, 'a.json'), { id: 'a', segments: [{ harness: 'codex', nativeId: 'real' }] });
  const foreign = JSON.stringify({ id: 'a', segments: [{ harness: 'claude', nativeId: 'claude:wrong' }] });
  write(path.join(dir, 'z.json'), foreign);
  write(path.join(dir, 'bad.json'), { id: '\ud800', segments: [{ harness: 'codex', nativeId: 'bad' }] });
  write(path.join(dir, 'ghost.json'), { id: 'other', segments: [{ harness: 'codex', nativeId: 'other' }] });
  write(path.join(dir, 'claude%3Aown.json'), { id: 'claude:own', segments: [{ harness: 'claude', nativeId: 'claude:own' }] });
  const records = chatRecord.legacyRecords(ud, NOW);
  assert.deepEqual(
    records.map((r: any) => r.id),
    ['a', 'claude:own'],
  );
  assert.equal(records[0].segments[0].nativeId, 'real');
  const initial = v2.run({ userData: ud, now: NOW });
  assert.equal(initial.ok, false);
  assert.deepEqual(initial.failed, ['bad', 'ghost', 'z']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'a.v2'), 'utf8')).segments[0].nativeId, 'real');
  assert.equal(fs.readFileSync(path.join(dir, 'z.json'), 'utf8'), foreign);
  const future = JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'a.v2'), 'utf8')), id: 'other', schemaVersion: 999 });
  fs.writeFileSync(path.join(dir, 'a.v2'), future);
  const blocked = v2.run({ userData: ud, now: NOW });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.failed, ['a', 'bad', 'ghost', 'z']);
  assert.equal(blocked.after.chats, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'a.v2'), 'utf8'), future);
  assert.equal(chatRecord.legacyRecords(ud, NOW)[0].segments[0].nativeId, 'real');
  assert.equal(mig.runMigration(v2, ud, { now: NOW }).result, 'failed');
  assert.equal(fs.readFileSync(path.join(dir, 'a.v2'), 'utf8'), future, 'rollback also preserves the foreign file');
});

test('rollback deletes owned files but preserves foreign, newer and unreadable records', (t) => {
  const ud = tmp();
  t.after(() => fs.rmSync(ud, { recursive: true, force: true }));
  const dir = path.join(ud, 'threads');
  write(path.join(dir, 'own.v2'), { id: 'own', schemaVersion: 2 });
  const retained = {
    'foreign.v2': JSON.stringify({ id: 'other', schemaVersion: 2 }),
    'new.v2': JSON.stringify({ id: 'new', schemaVersion: 3 }),
    'idless.v2': JSON.stringify({ schemaVersion: 2 }),
    'bad.v2': JSON.stringify({ id: '\ud800', schemaVersion: 2 }),
    'torn.v2': 'not json',
    'legacy.json': '{}',
  };
  for (const [file, text] of Object.entries(retained)) write(path.join(dir, file), text);
  v2.rollback({ userData: ud });
  assert.equal(fs.existsSync(path.join(dir, 'own.v2')), false);
  for (const [file, text] of Object.entries(retained)) assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), text);
});

test('malformed legacy UI identifiers fail per chat and preserve healthy fallback writes', (t) => {
  const ud = tmp();
  t.after(() => fs.rmSync(ud, { recursive: true, force: true }));
  const bad = '\ud800';
  const uiFile = path.join(ud, 'ui-state.json');
  write(uiFile, { pinned: { [bad]: true, good: true } });
  const result = v2.run({ userData: ud, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, [bad]);
  assert.equal(result.written, 1);
  assert.equal(result.after.chats, 1);
  assert.deepEqual(
    chatRecord.legacyRecords(ud, NOW).map((r: any) => r.id),
    ['good'],
  );
  const { ChatsStore } = require('../electron/platform/chats.cjs');
  const store = new ChatsStore(path.join(ud, 'threads'), { uiState: uiFile, fallback: true });
  assert.deepEqual(Object.keys(store.snapshot().chats), ['good']);
  assert.equal(store.ensure(bad), false);
  assert.equal(store.patchMeta('good', { unread: true }), true);
  assert.equal(JSON.parse(fs.readFileSync(uiFile, 'utf8')).pinned[bad], true);
});
