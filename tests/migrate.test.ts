// Profile migrations keep the existing storage folder while the app displays its current name.
import edition from '../shared/edition.json' with { type: 'json' };
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { userDataDir, migrateUserData } = require('../electron/migrations/migrate.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-migrate-'));

test('moves the legacy profile and leaves a marker', () => {
  const appData = tmp();
  fs.mkdirSync(path.join(appData, 'Sage Codex', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Sage Codex', 'ui-state.json'), '{"prefs":{}}');
  const target = userDataDir(appData, {});
  assert.equal(target, path.join(appData, edition.desktop.profile));
  if (!edition.desktop.legacyProfiles.length) {
    assert.equal(migrateUserData(appData, target), null);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(appData, 'Sage Codex')), true);
    return;
  }
  assert.equal(migrateUserData(appData, target), path.join(appData, 'Sage Codex'));
  assert.equal(fs.readFileSync(path.join(target, 'ui-state.json'), 'utf8'), '{"prefs":{}}');
  assert.ok(fs.existsSync(path.join(target, 'threads')));
  assert.ok(fs.existsSync(path.join(target, '.migrated-from')));
  assert.ok(!fs.existsSync(path.join(appData, 'Sage Codex')));
});

test('never touches an existing new profile', () => {
  const appData = tmp();
  fs.mkdirSync(path.join(appData, 'Sage Codex'));
  fs.mkdirSync(path.join(appData, edition.desktop.profile));
  assert.equal(migrateUserData(appData, path.join(appData, edition.desktop.profile)), null);
  assert.ok(fs.existsSync(path.join(appData, 'Sage Codex')));
});

test('env overrides win, with SAGE_USER_DATA kept as an alias', () => {
  assert.equal(userDataDir('/x', { MOPILOT_USER_DATA: '/a', SAGE_USER_DATA: '/b' }), '/a');
  assert.equal(userDataDir('/x', { SAGE_USER_DATA: '/b' }), '/b');
});

/* ------------------------------------------------------------------ */
/* 2026-10-threads-v2: ui-state.json and threads/<id>.json -> threads/<id>.v2 */
/* ------------------------------------------------------------------ */
const { runMigrations, retryMigration, readRegistry, migrationReport, restoreMigration } = require('../electron/migrations/migrate.cjs');
const v2 = require('../electron/migrations/2026-10-threads-v2.cjs');
const chatRecord = require('../electron/platform/chatRecord.cjs');
const { ChatsStore, flushPendingWrites } = require('../electron/platform/chats.cjs');

import { NOW, twoSegments, legacyUi, profile, v2Files, read, uiOf } from './support/migration-profile.ts';

test('v2: every chat with state gets a v2 file with its meta and segments', () => {
  const dir = profile();
  const [r] = runMigrations(dir, { now: NOW, appVersion: '0.3.0' });
  assert.equal(r.result, 'ok');
  assert.deepEqual(r.before, r.after);
  assert.deepEqual(r.before, { chats: 8, pinned: 2, unread: 1, archived: 2, worktree: 1, accounts: 2, accountsPinned: 1, multiSegment: 2 });

  const pinnedClaude = read(dir, 'claude:s-pinned');
  assert.equal(pinnedClaude.schemaVersion, 2);
  assert.deepEqual(pinnedClaude.segments, [
    { kind: 'claude', nativeId: 's-pinned', instance: null, provider: null, model: null, handoff: null, start: 0, count: null },
  ]);
  assert.equal(pinnedClaude.meta.pinned, true);
  assert.equal(pinnedClaude.meta.archived, 1700000000001);
  assert.deepEqual(pinnedClaude.meta.account, { id: 'acct-2', pinned: true });
  assert.equal(read(dir, 'cx-pinned').segments[0].kind, 'codex');
  assert.equal(read(dir, 'cx-wt').meta.worktreeOf, '/work/repo');
  assert.equal(read(dir, 'cx-unread').meta.unread, true);
  // a chat that only says "not pinned" carries nothing to move
  assert.ok(!fs.existsSync(path.join(dir, 'threads', 'cx-unpinned.v2')));

  const switched = read(dir, 'cx-switched');
  assert.deepEqual(
    switched.segments.map((s: any) => [s.kind, s.nativeId, s.start, s.count]),
    [
      ['codex', 'cx-switched', 0, 2],
      ['claude', 's-2', 2, null],
    ],
  );
  assert.equal(switched.segments[1].handoff.text, 'note');
  assert.equal(read(dir, 'cx-old-ui').segments.length, 2);

  // legacy data is frozen: untouched apart from stateVersion
  const { stateVersion, ...ui } = uiOf(dir);
  assert.equal(stateVersion, 2);
  assert.deepEqual(ui, legacyUi());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'threads', 'cx-switched.json'), 'utf8')).segments, twoSegments);
});

test('v2: backs up ui-state.json and threads/ with a verified manifest, and keeps the last 3', () => {
  const dir = profile();
  for (const t of ['20260101T000000Z', '20260201T000000Z', '20260301T000000Z']) {
    fs.mkdirSync(path.join(dir, 'backups', `pre-v2-${t}`), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backups', `pre-v2-${t}`, 'manifest.json'), JSON.stringify({ createdAt: NOW - 1000, files: [] }));
  }
  runMigrations(dir, { now: NOW });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')).sort(), [
    'pre-v2-20260201T000000Z',
    'pre-v2-20260301T000000Z',
    'pre-v2-20261010T120000Z',
  ]);
  const b = path.join(dir, 'backups', 'pre-v2-20261010T120000Z');
  const manifest = JSON.parse(fs.readFileSync(path.join(b, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.map((f: any) => f.path).sort(), [path.join('threads', 'cx-switched.json'), 'ui-state.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b, 'ui-state.json'), 'utf8')), legacyUi());
  for (const f of manifest.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
});

test('v2: a report with matching counts is written and the run recorded once', () => {
  const dir = profile();
  const [r] = runMigrations(dir, { now: NOW, appVersion: '0.3.0' });
  assert.equal(path.dirname(r.report), path.join(dir, 'migrations'));
  const report = JSON.parse(fs.readFileSync(r.report, 'utf8'));
  assert.equal(report.ok, true);
  assert.deepEqual(report.before, report.after);
  assert.deepEqual(report.failed, []);
  const reg = readRegistry(dir);
  assert.deepEqual(
    reg.map((e: any) => [e.id, e.result, e.appVersion]),
    [['2026-10-threads-v2', 'ok', '0.3.0']],
  );
  assert.ok(!fs.existsSync(path.join(dir, '.migrating')));
});

test('v2: the run records counts only (written, left as they were, failed) for the migration report', () => {
  const dir = profile();
  const [r] = runMigrations(dir, { now: NOW });
  assert.deepEqual(r.counts, { migrated: 8, skipped: 0, failed: 0 });
  assert.deepEqual(readRegistry(dir)[0].counts, r.counts);
  // a second run finds the finished entry and reports nothing new
  assert.equal(runMigrations(dir, { now: NOW })[0].counts, undefined);
});

test('v2: idempotent: a second launch skips it, and rerunning the step writes the same bytes', () => {
  const dir = profile();
  runMigrations(dir, { now: NOW });
  const once = v2Files(dir);
  const [again] = runMigrations(dir, { now: NOW + 5000 });
  assert.equal(again.result, 'done');
  assert.deepEqual(v2Files(dir), once);
  // even forced, the step only fills empty fields
  const r = v2.run({ userData: dir, now: NOW + 9000 });
  assert.equal(r.ok, true);
  assert.equal(r.written, 0);
  assert.deepEqual(v2Files(dir), once);
  assert.equal(readRegistry(dir).length, 1);
});

test('v2: a crash midway, then a rerun, ends the same as one clean run', () => {
  const clean = profile();
  runMigrations(clean, { now: NOW });

  const dir = profile();
  assert.throws(() => runMigrations(dir, { now: NOW, crashAfter: 4 }), /simulated crash/);
  assert.equal(Object.keys(v2Files(dir)).length, 4);
  assert.ok(fs.existsSync(path.join(dir, '.migrating')), 'the lock names the backup to reuse');
  assert.equal(readRegistry(dir).length, 0);

  const [r] = runMigrations(dir, { now: NOW + 60_000 });
  assert.equal(r.result, 'ok');
  // only the files written after the crash carry the later time
  const noTime = (files: Record<string, string>) =>
    Object.fromEntries(Object.entries(files).map(([f, t]) => [f, { ...JSON.parse(t), updatedAt: 0 }]));
  assert.deepEqual(noTime(v2Files(dir)), noTime(v2Files(clean)));
  // the crashed run's backup was reused rather than a second one taken
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  assert.ok(!fs.existsSync(path.join(dir, '.migrating')));
});

test('v2: too little disk space defers the run without touching anything', () => {
  const dir = profile();
  const [r] = runMigrations(dir, { now: NOW, freeBytes: () => 10 });
  assert.deepEqual(r, { id: '2026-10-threads-v2', result: 'deferred', reason: 'disk' });
  assert.deepEqual(v2Files(dir), {});
  assert.ok(!fs.existsSync(path.join(dir, 'backups')));
  assert.equal(readRegistry(dir).length, 0);
  assert.equal(runMigrations(dir, { now: NOW })[0].result, 'ok');
});

test('v2: a count mismatch rolls back, is recorded as failed and not retried until asked', () => {
  const dir = profile();
  // a file a newer build wrote is left alone, so that chat's pin can't be counted as moved
  fs.writeFileSync(
    path.join(dir, 'threads', 'cx-pinned.v2'),
    JSON.stringify({ schemaVersion: 3, id: 'cx-pinned', segments: [], meta: {} }),
  );
  const [r] = runMigrations(dir, { now: NOW });
  assert.equal(r.result, 'failed');
  assert.notDeepEqual(r.before, r.after);
  assert.deepEqual(Object.keys(v2Files(dir)), ['cx-pinned.v2']);
  assert.equal(read(dir, 'cx-pinned').schemaVersion, 3);
  assert.equal(runMigrations(dir, { now: NOW + 1 })[0].result, 'failed');
  assert.deepEqual(uiOf(dir), legacyUi());
  // An older build cannot remove newer data merely by retrying the migration.
  fs.rmSync(path.join(dir, 'threads', 'cx-pinned.v2'));
  assert.equal(retryMigration(dir, '2026-10-threads-v2', { now: NOW + 2 }).result, 'ok');
});

test('v2: ui-state from a newer version is not migrated', () => {
  const dir = profile({ ...legacyUi(), stateVersion: 3 });
  assert.equal(runMigrations(dir, { now: NOW })[0].result, 'newer');
  assert.deepEqual(v2Files(dir), {});
});

test('v2: an empty profile completes with nothing to move', () => {
  const [r] = runMigrations(tmp(), { now: NOW });
  assert.equal(r.result, 'ok');
  assert.equal(r.before.chats, 0);
});

test('v2: broken legacy JSON is skipped, not fatal', () => {
  const dir = profile();
  fs.writeFileSync(path.join(dir, 'threads', 'broken.json'), '{nope');
  assert.equal(runMigrations(dir, { now: NOW })[0].result, 'ok');
});

test('v2: after the run, changes are mirrored back to where 0.2.0 reads them', () => {
  const dir = profile();
  runMigrations(dir, { now: NOW });
  const store = new ChatsStore(path.join(dir, 'threads'), { uiState: path.join(dir, 'ui-state.json'), now: () => NOW });
  store.patchMeta('claude:s-archived', { archived: null, pinned: true });
  store.patchMeta('cx-pinned', { pinned: false });
  const ui = uiOf(dir);
  assert.deepEqual(ui.pinned, { 'claude:s-archived': true, 'claude:s-pinned': true });
  assert.deepEqual(ui.claudeArchived, { 'claude:s-pinned': 1700000000001 });
  assert.deepEqual(ui.claudeChats, legacyUi().claudeChats);
  assert.deepEqual(ui.worktreeOf, legacyUi().worktreeOf);
  assert.deepEqual(ui.prefs, legacyUi().prefs);

  // Codex and Claude segments go back to threads/<id>.json in the old shape
  store.setSegments('cx-pinned', [
    { harness: 'codex', nativeId: 'cx-pinned', start: 0, count: 1, model: null, handoff: null },
    { harness: 'claude', nativeId: 'claude:s-new', start: 1, count: null, model: 'opus', handoff: null },
  ]);
  flushPendingWrites();
  const legacy = JSON.parse(fs.readFileSync(path.join(dir, 'threads', 'cx-pinned.json'), 'utf8'));
  assert.deepEqual(legacy.segments[1], {
    harness: 'claude',
    nativeId: 'claude:s-new',
    start: 1,
    count: null,
    model: 'opus',
    handoff: null,
  });
  assert.equal(read(dir, 'cx-pinned').segments[1].nativeId, 's-new');

  // a chat with an acp segment is never mirrored: no legacy file, and it leaves the old keys
  store.setSegments('cx-pinned', [
    { harness: 'codex', nativeId: 'cx-pinned', start: 0, count: 1, model: null, handoff: null },
    { harness: 'acp', nativeId: 'acp:k-1', start: 1, count: null, model: null, handoff: null },
  ]);
  store.patchMeta('cx-pinned', { pinned: true });
  flushPendingWrites();
  assert.ok(!fs.existsSync(path.join(dir, 'threads', 'cx-pinned.json')));
  assert.ok(!('cx-pinned' in uiOf(dir).pinned));
  assert.equal(read(dir, 'cx-pinned').meta.pinned, true);
  assert.equal(read(dir, 'cx-pinned').segments[1].nativeId, 'k-1');
});

test('v2: until a run finishes, the store serves the legacy data and writes only legacy files', () => {
  const dir = profile();
  const store = new ChatsStore(path.join(dir, 'threads'), { uiState: path.join(dir, 'ui-state.json'), fallback: true, now: () => NOW });
  const snap = store.snapshot();
  assert.equal(snap.chats['claude:s-pinned'].meta.pinned, true);
  assert.equal(snap.chats['cx-switched'].segments.length, 2);
  store.patchMeta('cx-wt', { pinned: true });
  assert.deepEqual(v2Files(dir), {});
  assert.equal(uiOf(dir).pinned['cx-wt'], true);
  // and the next run picks it up
  assert.equal(runMigrations(dir, { now: NOW })[0].result, 'ok');
  assert.equal(read(dir, 'cx-wt').meta.pinned, true);
});

test('v2: the old id rule lives only in the migration code', () => {
  // main and the modules it composes (its IPC handlers and its app wiring)
  const own = ['app/ipc', 'app'].flatMap((dir) =>
    fs
      .readdirSync(path.join(import.meta.dirname, '..', 'electron', dir))
      .filter((f) => f.endsWith('.cjs'))
      .map((f) => `electron/${dir}/${f}`),
  );
  assert.ok(own.includes('electron/app/ipc/chats.cjs'));
  assert.ok(own.includes('electron/app/sessions.cjs'));
  for (const f of ['electron/platform/chats.cjs', 'electron/main.cjs', ...own, 'src/lib/chatMeta.ts'])
    assert.doesNotMatch(fs.readFileSync(path.join(import.meta.dirname, '..', f), 'utf8'), /startsWith\('claude:'\)/, f);
  assert.deepEqual(chatRecord.legacyFirstSegment('claude:abc').kind, 'claude');
  assert.deepEqual(chatRecord.legacyFirstSegment('claude:abc').nativeId, 'abc');
  assert.deepEqual(chatRecord.legacyFirstSegment('019a-codex').kind, 'codex');
});

test('v2: the report view reads counts, failed chats and the backup of the last run', () => {
  const dir = profile();
  assert.equal(migrationReport(dir), null);
  runMigrations(dir, { now: NOW });
  const r = migrationReport(dir);
  assert.equal(r.result, 'ok');
  assert.equal(r.backupOk, true);
  assert.deepEqual(r.report.before, r.report.after);
  assert.equal(r.report.before.chats, 8);
  assert.deepEqual(r.report.failed, []);
});

test('v2: restoring puts the pre-migration data back, keeps prefs and is not rerun until Retry', () => {
  const dir = profile();
  runMigrations(dir, { now: NOW });
  // the app changed things after the run: a pref and a legacy key the mirror wrote
  const ui = uiOf(dir);
  fs.writeFileSync(path.join(dir, 'ui-state.json'), JSON.stringify({ ...ui, prefs: { theme: 'light' }, pinned: { 'cx-new': true } }));
  fs.writeFileSync(path.join(dir, 'threads', 'cx-switched.json'), '{"id":"cx-switched","segments":[]}');
  const e = restoreMigration(dir, '2026-10-threads-v2', { now: NOW + 1 });
  assert.equal(e.result, 'restored');
  assert.deepEqual(Object.keys(v2Files(dir)), []);
  const after = uiOf(dir);
  assert.equal(after.stateVersion, undefined);
  assert.deepEqual(after.prefs, { theme: 'light' });
  assert.deepEqual(after.pinned, legacyUi().pinned);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'threads', 'cx-switched.json'), 'utf8')).segments, twoSegments);
  // a later launch leaves it restored; Retry migrates again
  assert.equal(runMigrations(dir, { now: NOW + 2 })[0].result, 'restored');
  assert.equal(migrationReport(dir).result, 'restored');
  assert.equal(retryMigration(dir, '2026-10-threads-v2', { now: NOW + 3 }).result, 'ok');
  assert.ok(Object.keys(v2Files(dir)).length > 0);
});

test('v2: restoring without a verifiable backup does nothing', () => {
  const dir = profile();
  runMigrations(dir, { now: NOW });
  fs.rmSync(path.join(dir, 'backups'), { recursive: true });
  assert.equal(restoreMigration(dir), null);
  assert.ok(Object.keys(v2Files(dir)).length > 0);
});

test('v2 step 8: recordings do not infer cloud consent and saved dictation choices remain unchanged', () => {
  const a = profile();
  runMigrations(a, { now: NOW });
  assert.equal(uiOf(a).prefs.dictationEngine, undefined);
  const b = profile();
  fs.mkdirSync(path.join(b, 'recordings'));
  fs.writeFileSync(path.join(b, 'recordings', '1.webm'), 'x');
  runMigrations(b, { now: NOW });
  assert.equal(uiOf(b).prefs.dictationEngine, undefined);
  assert.equal(uiOf(b).prefs.theme, 'dark');
  // a saved choice wins
  assert.deepEqual(v2.migratePrefs(b), { dictationEngine: null });
  for (const choice of ['local', 'chatgpt', 'credits']) {
    const c = profile({ ...legacyUi(), prefs: { dictationEngine: choice } });
    fs.mkdirSync(path.join(c, 'recordings'));
    fs.writeFileSync(path.join(c, 'recordings', '1.webm'), 'x');
    runMigrations(c, { now: NOW });
    assert.equal(uiOf(c).prefs.dictationEngine, choice);
  }
});

test('v2: the chat store asks the legacy-mirror switch on every write', () => {
  const dir = profile();
  runMigrations(dir, { now: NOW });
  let on = true;
  const store = new ChatsStore(path.join(dir, 'threads'), { uiState: path.join(dir, 'ui-state.json'), legacyMirror: () => on });
  store.patchMeta('cx-a', { pinned: true });
  assert.equal(uiOf(dir).pinned['cx-a'], true);
  on = false;
  store.patchMeta('cx-b', { pinned: true });
  assert.equal(uiOf(dir).pinned['cx-b'], undefined);
});

test('v2: a threads folder that cannot be listed stops the run before anything is written, and the next start runs it', () => {
  const { recentIgnored } = require('../electron/ignored.cjs');
  const dir = profile();
  const threads = path.join(dir, 'threads');
  const real = fs.readdirSync;
  const denied = (p: any, ...rest: any[]) => {
    if (String(p) === threads) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return (real as any)(p, ...rest);
  };
  // a folder the backup doesn't copy (a browser cache) can't be listed: the run is not held up
  const other = profile();
  const cache = path.join(other, 'Partitions', 'p', 'Cache');
  fs.mkdirSync(cache, { recursive: true });
  let m = mock.method(fs, 'readdirSync', (p: any, ...rest: any[]) => {
    if (String(p) === cache) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return (real as any)(p, ...rest);
  });
  assert.equal(runMigrations(other, { now: NOW })[0].result, 'ok');
  m.mock.restore();
  // the backup can't list it: no backup, no lock, nothing recorded
  m = mock.method(fs, 'readdirSync', denied);
  assert.throws(() => runMigrations(dir, { now: NOW }), /EACCES/);
  m.mock.restore();
  assert.equal(fs.existsSync(path.join(dir, '.migrating')), false);
  assert.equal(readRegistry(dir).length, 0);
  assert.deepEqual(v2Files(dir), {});

  // a run after a crash reuses its backup: the run itself refuses to read the folder as "no chats"
  const clean = profile();
  assert.throws(() => runMigrations(clean, { now: NOW, crashAfter: 0 }), /simulated crash/);
  const cleanThreads = path.join(clean, 'threads');
  m = mock.method(fs, 'readdirSync', (p: any, ...rest: any[]) => {
    if (String(p) === cleanThreads) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    return (real as any)(p, ...rest);
  });
  assert.throws(() => runMigrations(clean, { now: NOW }), /EIO/);
  // until then the store's fallback still serves what ui-state.json knows, and the failure is recorded
  const fallback = chatRecord.legacyRecords(clean, NOW);
  m.mock.restore();
  assert.ok(fallback.some((r: any) => r.id === 'cx-pinned'));
  assert.equal(
    fallback.some((r: any) => r.id === 'cx-switched'),
    false,
  );
  assert.ok(recentIgnored().some((e: any) => e.context === 'list the old chat files' && /EIO/.test(e.message)));
  assert.equal(readRegistry(clean).length, 0, 'not recorded as done');

  const [r] = runMigrations(clean, { now: NOW });
  assert.equal(r.result, 'ok');
  assert.equal(read(clean, 'cx-switched').segments.length, 2);
});

test('v2: an old chat file that cannot be read stops the run; one that is not JSON is skipped', () => {
  const dir = profile();
  assert.throws(() => runMigrations(dir, { now: NOW, crashAfter: 0 }), /simulated crash/);
  const file = path.join(dir, 'threads', 'cx-switched.json');
  const real = fs.readFileSync;
  const m = mock.method(fs, 'readFileSync', (p: any, ...rest: any[]) => {
    if (String(p) === file) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    return (real as any)(p, ...rest);
  });
  assert.throws(() => runMigrations(dir, { now: NOW }), /EIO/);
  assert.equal(readRegistry(dir).length, 0, 'not recorded as done');
  // the fallback reads what it can meanwhile
  assert.ok(chatRecord.legacyRecords(dir, NOW).some((r: any) => r.id === 'cx-pinned'));
  m.mock.restore();
  // a file removed meanwhile is nothing to read; a torn one is skipped and the run completes
  fs.writeFileSync(path.join(dir, 'threads', 'torn.json'), '{"id":');
  const [r] = runMigrations(dir, { now: NOW });
  assert.equal(r.result, 'ok');
  assert.equal(read(dir, 'cx-switched').segments.length, 2);
});

for (const value of [true, 42, 'damaged', [{ prefs: { theme: 'foreign' } }], null]) {
  test(`migration restores a non-record saved UI root ${JSON.stringify(value)}`, (t) => {
    const dir = profile(value);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.equal(runMigrations(dir, { now: NOW })[0].result, 'ok');
    assert.deepEqual(uiOf(dir), value, 'no state-version stamping of non-records');
    fs.writeFileSync(path.join(dir, 'ui-state.json'), JSON.stringify({ prefs: { theme: 'light' }, stateVersion: 2 }));
    assert.equal(restoreMigration(dir).result, 'restored');
    assert.deepEqual(uiOf(dir), { prefs: { theme: 'light' } });
    assert.deepEqual(v2Files(dir), {});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'threads', 'cx-switched.json'), 'utf8')).segments, twoSegments);
  });
  test(`migration restore does not spread a non-record current UI root ${JSON.stringify(value)}`, (t) => {
    const dir = profile();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    runMigrations(dir, { now: NOW });
    fs.writeFileSync(path.join(dir, 'ui-state.json'), JSON.stringify(value));
    assert.equal(restoreMigration(dir).result, 'restored');
    assert.equal(fs.readFileSync(path.join(dir, 'ui-state.json.unreadable'), 'utf8'), JSON.stringify(value));
    assert.deepEqual(
      uiOf(dir),
      Object.fromEntries(
        Object.entries(legacyUi()).filter(([key]) =>
          ['pinned', 'unread', 'worktreeOf', 'claudeArchived', 'claudeChats', 'segments'].includes(key),
        ),
      ),
    );
  });
  test(`preference migration preserves an unreadable root without inferring cloud consent ${JSON.stringify(value)}`, (t) => {
    const dir = profile(value);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'recordings'));
    fs.writeFileSync(path.join(dir, 'recordings', 'sample.webm'), 'recorded');
    assert.deepEqual(v2.migratePrefs(dir), { dictationEngine: null });
    assert.equal(fs.readFileSync(path.join(dir, 'ui-state.json.unreadable'), 'utf8'), JSON.stringify(value, null, 2));
    assert.deepEqual(uiOf(dir), value);
  });
}

test('restore and direct preference migration preserve the oldest invalid UI recovery copy', (t) => {
  const dir = profile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  runMigrations(dir, { now: NOW });
  const ui = path.join(dir, 'ui-state.json');
  fs.writeFileSync(`${ui}.unreadable`, 'oldest original');
  fs.writeFileSync(ui, '["later"]');
  assert.equal(restoreMigration(dir).result, 'restored');
  assert.equal(fs.readFileSync(`${ui}.unreadable`, 'utf8'), 'oldest original');
  fs.writeFileSync(ui, '"later preference root"');
  fs.mkdirSync(path.join(dir, 'recordings'));
  fs.writeFileSync(path.join(dir, 'recordings', 'sample.webm'), 'recorded');
  assert.deepEqual(v2.migratePrefs(dir), { dictationEngine: null });
  assert.equal(fs.readFileSync(`${ui}.unreadable`, 'utf8'), 'oldest original');
});
