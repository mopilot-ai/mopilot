// An added Claude Code login keeps the CLAUDE_CONFIG_DIR it signed in with (electron/identity/contract/accountDirs.cjs): the CLI
// keys its macOS keychain item by a hash of that literal path, so a renamed, moved or copied userData folder must not
// change the string. When the path can't be kept, the login says it needs to be confirmed again. Also the folder-link helpers
// (junctions and hard links on Windows). The CLI is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import edition from '../shared/edition.json' with { type: 'json' };
import { waitFor } from './support/waitFor.ts';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-claude-dirs-')));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'shared');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const require = createRequire(import.meta.url);
const { ClaudeAccounts } = require('../electron/harness/claude/accounts.cjs');
const { migrateUserData } = require('../electron/migrations/migrate.cjs');
const dirs = require('../electron/identity/contract/accountDirs.cjs');
const { accountConfigDir } = require('../electron/identity/contract/accountState.cjs');

let n = 0;
const fresh = () => {
  const d = path.join(tmp, `case-${n++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const readState = (userData: string) => JSON.parse(fs.readFileSync(path.join(userData, 'claude-accounts.json'), 'utf8'));
const writeState = (userData: string, state: object) => {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'claude-accounts.json'), JSON.stringify(state));
};
/** A login is signed in only when the CLI runs with the path its token is keyed by. */
function make(userData: string, tokens: Set<string>, extra: object = {}) {
  const runs: { args: string[]; dir: string | undefined }[] = [];
  let m: any;
  const run = async (_bin: string, args: string[], id: string) => {
    const dir = m.env(id).CLAUDE_CONFIG_DIR;
    runs.push({ args, dir });
    return JSON.stringify(dir && tokens.has(dir) ? { loggedIn: true, email: `${id}@example.com` } : { loggedIn: false });
  };
  m = new ClaudeAccounts({ userData, broadcast: () => {}, run, ...extra });
  return { m, runs };
}
const row = (m: any, id: string) => m.view().accounts.find((a: any) => a.id === id);
const legacyProfiles: readonly string[] = edition.desktop.legacyProfiles;

function migrateLegacyProfile(appData: string, target: string, legacy: string) {
  const moved = migrateUserData(appData, target);
  if (legacyProfiles.includes(path.basename(legacy))) {
    assert.equal(moved, legacy);
  } else {
    assert.equal(moved, null);
    assert.ok(fs.existsSync(legacy));
    assert.ok(!fs.existsSync(target));
  }
  return moved;
}

test('a login added before the Sage Codex rename keeps its original path and stays signed in', async () => {
  const appData = fresh();
  const legacy = path.join(appData, 'Sage Codex');
  const original = path.join(legacy, 'claude-accounts', 'abc');
  writeState(legacy, { active: 'abc', accounts: [{ id: 'abc', email: 'me@example.com', loggedIn: true }] });
  fs.mkdirSync(original, { recursive: true });
  fs.writeFileSync(path.join(original, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }));
  const target = path.join(appData, edition.desktop.profile);
  if (!migrateLegacyProfile(appData, target, legacy)) return;
  assert.equal(readState(target).accounts[0].configDir, original);

  const { m } = make(target, new Set([original]));
  // the CLI runs with the literal path the token is keyed by, which now reaches the moved folder
  assert.equal(m.env('abc').CLAUDE_CONFIG_DIR, original);
  assert.equal(fs.realpathSync(original), path.join(target, 'claude-accounts', 'abc'));
  await m.refresh('claude');
  assert.equal(row(m, 'abc').loggedIn, true);
  assert.equal(row(m, 'abc').reconfirm, false);
  // the moved folder's cached login fields are read through the link
  assert.equal(row(m, 'abc').email, 'abc@example.com');
});

test('a cross-volume copy keeps running the old profile’s folder, which is still there', () => {
  const appData = fresh();
  const legacy = path.join(appData, 'Sage Codex');
  writeState(legacy, { accounts: [{ id: 'abc', email: 'me@example.com', loggedIn: true }] });
  fs.mkdirSync(path.join(legacy, 'claude-accounts', 'abc'), { recursive: true });
  const target = path.join(appData, edition.desktop.profile);
  const rename = fs.renameSync;
  // only the profile itself is on another volume; atomic writes inside it still rename
  (fs as any).renameSync = (a: string, b: string) => {
    if (a === legacy) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    return rename(a, b);
  };
  try {
    if (!migrateLegacyProfile(appData, target, legacy)) return;
  } finally {
    (fs as any).renameSync = rename;
  }
  const { m } = make(target, new Set());
  assert.equal(m.env('abc').CLAUDE_CONFIG_DIR, path.join(legacy, 'claude-accounts', 'abc'));
  assert.equal(fs.lstatSync(path.join(legacy, 'claude-accounts', 'abc')).isSymbolicLink(), false);
});

test('a renamed userData folder keeps the recorded path working through a link', async () => {
  const before = path.join(fresh(), 'Profile A');
  const { m: first } = make(before, new Set());
  const { id } = first.startLogin('claude');
  // keep the record: only the sign-in's poll goes
  clearTimeout(first.pending.timer);
  first.pending = null;
  const recorded = path.join(before, 'claude-accounts', id);
  assert.equal(first.state.accounts[0].configDir, recorded);
  first.state.accounts[0].email = 'me@example.com';
  first.state.accounts[0].loggedIn = true;
  first.save();

  const after = path.join(path.dirname(before), 'Profile B');
  fs.renameSync(before, after);
  const { m } = make(after, new Set([recorded]));
  await m.refresh('claude');
  assert.equal(row(m, id).loggedIn, true);
  assert.equal(fs.lstatSync(recorded).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(recorded), path.join(after, 'claude-accounts', id));
});

test('a copied profile runs the original folder, so its logins keep working', async () => {
  const real = fresh();
  const original = path.join(real, 'claude-accounts', 'abc');
  fs.mkdirSync(original, { recursive: true });
  const copy = fresh();
  writeState(copy, { accounts: [{ id: 'abc', email: 'me@example.com', loggedIn: true, configDir: original }] });
  fs.mkdirSync(path.join(copy, 'claude-accounts', 'abc'), { recursive: true });
  const { m } = make(copy, new Set([original]));
  assert.equal(m.env('abc').CLAUDE_CONFIG_DIR, original);
  await m.refresh('claude');
  assert.equal(row(m, 'abc').loggedIn, true);
});

test('a path that cannot be restored falls back to the local folder and asks to confirm the login again', async () => {
  const userData = fresh();
  // its parent is a file, so the recorded path can't be made again (as for a home folder that is gone)
  const blocked = path.join(fresh(), 'gone');
  fs.writeFileSync(blocked, '');
  const recorded = path.join(blocked, 'claude-accounts', 'abc');
  writeState(userData, { accounts: [{ id: 'abc', email: 'me@example.com', loggedIn: true, configDir: recorded }] });
  fs.mkdirSync(path.join(userData, 'claude-accounts', 'abc'), { recursive: true });
  const local = path.join(userData, 'claude-accounts', 'abc');
  const tokens = new Set<string>();
  const { m } = make(userData, tokens);
  assert.equal(m.env('abc').CLAUDE_CONFIG_DIR, local);
  await m.refresh('claude');
  assert.deepEqual([row(m, 'abc').loggedIn, row(m, 'abc').reconfirm], [false, true]);
  // the record keeps the path its token is keyed by while it can't be confirmed
  assert.equal(m.state.accounts[0].configDir, recorded);
  // signing in again at the local folder records it
  tokens.add(local);
  await m.refresh('claude');
  assert.deepEqual([row(m, 'abc').loggedIn, row(m, 'abc').reconfirm], [true, false]);
  assert.equal(readState(userData).accounts[0].configDir, local);
});

test('a record from before this fix is adopted at its folder and asks to confirm only when it reads signed out', async () => {
  const userData = fresh();
  writeState(userData, {
    accounts: [
      { id: 'kept', email: 'kept@example.com', loggedIn: true },
      { id: 'moved', email: 'moved@example.com', loggedIn: true },
    ],
  });
  const local = (id: string) => path.join(userData, 'claude-accounts', id);
  const { m } = make(userData, new Set([local('kept')]));
  assert.deepEqual(
    m.state.accounts.map((a: any) => [a.configDir, a.unconfirmed]),
    [
      [local('kept'), true],
      [local('moved'), true],
    ],
  );
  // before any read, a signed-in record is not asked about
  assert.equal(row(m, 'moved').reconfirm, false);
  await m.refresh('claude');
  assert.deepEqual([row(m, 'kept').loggedIn, row(m, 'kept').reconfirm], [true, false]);
  assert.deepEqual([row(m, 'moved').loggedIn, row(m, 'moved').reconfirm], [false, true]);
  assert.equal(readState(userData).accounts[0].unconfirmed, undefined);
  assert.equal(readState(userData).accounts[1].unconfirmed, true);
});

test('a login confirmed at an unchanged path that reads signed out is plainly signed out', async () => {
  const userData = fresh();
  const local = path.join(userData, 'claude-accounts', 'abc');
  writeState(userData, { accounts: [{ id: 'abc', email: 'me@example.com', loggedIn: true, configDir: local }] });
  const { m } = make(userData, new Set());
  await m.refresh('claude');
  assert.deepEqual([row(m, 'abc').loggedIn, row(m, 'abc').reconfirm], [false, false]);
});

test('a recorded path that is not this account’s folder is never used, and the record is adopted instead', () => {
  const userData = fresh();
  const local = path.join(userData, 'claude-accounts', 'abc');
  for (const configDir of [
    '/',
    os.homedir(),
    'relative/claude-accounts/abc',
    `${tmp}/claude-accounts/other`,
    `${tmp}/x/../claude-accounts/abc`,
    7,
  ]) {
    writeState(userData, { accounts: [{ id: 'abc', email: 'me@example.com', loggedIn: true, configDir }] });
    const { m } = make(userData, new Set());
    assert.equal(m.env('abc').CLAUDE_CONFIG_DIR, local, String(configDir));
    assert.equal(m.state.accounts[0].unconfirmed, true);
  }
});

test('accountConfigDir accepts only an absolute, normalized account folder inside claude-accounts', () => {
  const ok = path.join(tmp, 'p', 'claude-accounts', 'abc');
  assert.equal(accountConfigDir(ok, 'abc'), ok);
  assert.equal(accountConfigDir(path.join(tmp, 'p', 'accounts', 'abc'), 'abc'), null);
  assert.equal(accountConfigDir(ok, 'abd'), null);
  assert.equal(accountConfigDir(null, 'abc'), null);
  assert.equal(accountConfigDir(ok, '..'), null);
});

test('removing a login reached through a link deletes the moved folder and the link, never the shared entries', async () => {
  const appData = fresh();
  const recorded = path.join(appData, 'Old', 'claude-accounts', 'abc');
  const userData = path.join(appData, 'New');
  const local = path.join(userData, 'claude-accounts', 'abc');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, '.claude.json'), '{}');
  writeState(userData, { accounts: [{ id: 'abc', email: 'me@example.com', loggedIn: true, configDir: recorded }] });
  const marker = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'keep.txt');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, 'shared');
  const { m } = make(userData, new Set([recorded]));
  m.prepare('abc');
  assert.equal(fs.lstatSync(path.join(local, 'projects')).isSymbolicLink(), true);
  m.remove(undefined, 'abc');
  await waitFor(() => !fs.existsSync(local), 'the local folder to be removed');
  assert.equal(fs.existsSync(local), false);
  assert.equal(fs.lstatSync(recorded, { throwIfNoEntry: false }), undefined);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'shared');
});

test('pinConfigDirs records the old profile’s folders and leaves recorded or unreadable state alone', () => {
  const from = path.join(fresh(), 'Sage Codex');
  const to = fresh();
  assert.equal(dirs.pinConfigDirs(to, from), 0);
  fs.writeFileSync(path.join(to, 'claude-accounts.json'), '{oops');
  assert.equal(dirs.pinConfigDirs(to, from), 0);
  assert.equal(fs.readFileSync(path.join(to, 'claude-accounts.json'), 'utf8'), '{oops');
  const kept = path.join(tmp, 'elsewhere', 'claude-accounts', 'b');
  // a file the accounts can't load is not rewritten
  writeState(to, { accounts: [{ id: '../x' }] });
  assert.equal(dirs.pinConfigDirs(to, from), 0);
  writeState(to, { active: 'a' });
  assert.equal(dirs.pinConfigDirs(to, from), 0);
  writeState(to, { active: 'a', accounts: [{ id: 'a' }, { id: 'b', configDir: kept }] });
  assert.equal(dirs.pinConfigDirs(to, from), 1);
  assert.deepEqual(
    readState(to).accounts.map((a: any) => a.configDir),
    [path.join(from, 'claude-accounts', 'a'), kept],
  );
  assert.equal(readState(to).active, 'a');
  // pinned already: nothing to write
  assert.equal(dirs.pinConfigDirs(to, from), 0);
});

test('a link left at the recorded path by a deleted folder is replaced by one to the moved folder', () => {
  const userData = fresh();
  const recorded = path.join(fresh(), 'Old', 'claude-accounts', 'abc');
  fs.mkdirSync(path.dirname(recorded), { recursive: true });
  fs.symlinkSync(path.join(tmp, 'nowhere'), recorded);
  const local = path.join(userData, 'claude-accounts', 'abc');
  fs.mkdirSync(local, { recursive: true });
  assert.deepEqual(dirs.placeConfigDir(recorded, local), { dir: recorded, moved: false });
  assert.equal(fs.realpathSync(recorded), local);
});

test('removal deletes only what this profile holds: a link at the recorded path and its own folder', async () => {
  const root = path.join(fresh(), 'claude-accounts');
  const local = (id: string) => path.join(root, id);
  fs.mkdirSync(root, { recursive: true });
  // a recorded path left as a link to a folder that is gone: the link goes
  const dangling = path.join(fresh(), 'claude-accounts', 'abc');
  fs.mkdirSync(path.dirname(dangling));
  fs.symlinkSync(path.join(tmp, 'nowhere'), dangling);
  dirs.deleteAccountFolders(dangling, local('abc'));
  assert.equal(fs.lstatSync(dangling, { throwIfNoEntry: false }), undefined);
  // a link in a folder it may not change stays
  const locked = path.join(fresh(), 'claude-accounts');
  fs.mkdirSync(locked, { recursive: true });
  fs.symlinkSync(local('abc'), path.join(locked, 'abc'));
  fs.chmodSync(locked, 0o500);
  try {
    dirs.deleteAccountFolders(path.join(locked, 'abc'), local('abc'));
  } finally {
    fs.chmodSync(locked, 0o700);
  }
  assert.equal(fs.lstatSync(path.join(locked, 'abc')).isSymbolicLink(), true);
  // a recorded path that is a real folder is another profile's (the original of a copy): it stays
  const original = path.join(fresh(), 'claude-accounts', 'def');
  fs.mkdirSync(original, { recursive: true });
  fs.writeFileSync(path.join(original, '.claude.json'), '{}');
  fs.mkdirSync(local('def'));
  dirs.deleteAccountFolders(original, local('def'));
  assert.equal(fs.readFileSync(path.join(original, '.claude.json'), 'utf8'), '{}');
  await waitFor(() => !fs.existsSync(local('def')), 'the def folder to be removed');
  assert.equal(fs.existsSync(local('def')), false);
  // an entry that is not a folder can't be listed and is left alone
  fs.writeFileSync(local('ghi'), 'x');
  dirs.deleteAccountFolders(undefined, local('ghi'));
  assert.equal(fs.readFileSync(local('ghi'), 'utf8'), 'x');
});

test('the account list reads a login’s cached fields without making its folder', () => {
  const userData = fresh();
  // a copied profile whose original folder is gone: reading must not make it (or a link) again
  const recorded = path.join(fresh(), 'Original', 'claude-accounts', 'abc');
  const local = path.join(userData, 'claude-accounts', 'abc');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'local@example.com' } }));
  writeState(userData, { accounts: [{ id: 'abc', email: null, loggedIn: true, configDir: recorded }] });
  const { m } = make(userData, new Set());
  assert.equal(row(m, 'abc').email, 'local@example.com');
  assert.equal(fs.existsSync(path.dirname(recorded)), false);
  assert.equal(m.configFile('nobody'), path.join(userData, 'claude-accounts', 'nobody', '.claude.json'));
});

test('a migration whose account file cannot be rewritten still moves the profile', () => {
  const appData = fresh();
  const legacy = path.join(appData, 'Sage Codex');
  writeState(legacy, { accounts: [{ id: 'abc', email: 'me@example.com', loggedIn: true }] });
  // the moved profile itself can't take new files: the marker and the record both fail
  fs.chmodSync(legacy, 0o500);
  const target = path.join(appData, edition.desktop.profile);
  try {
    if (!migrateLegacyProfile(appData, target, legacy)) return;
  } finally {
    fs.chmodSync(fs.existsSync(target) ? target : legacy, 0o700);
  }
  assert.equal(readState(target).accounts[0].configDir, undefined);
});

test('on Windows folders become junctions, files symlinks or else hard links', (t) => {
  const d = fs.mkdtempSync(path.join(tmp, 'win-'));
  const folder = path.join(d, 'folder');
  const file = path.join(d, 'file.json');
  fs.mkdirSync(folder);
  fs.writeFileSync(file, '{}');
  const types: (string | undefined)[] = [];
  const real = fs.symlinkSync;
  let fail = false;
  t.mock.method(fs, 'symlinkSync', (target: string, link: string, type?: string) => {
    types.push(type);
    if (fail) throw new Error('EPERM');
    return real(target, link);
  });
  dirs.linkShared(folder, path.join(d, 'l1'), 'win32');
  dirs.linkShared(file, path.join(d, 'l2'), 'win32');
  fail = true;
  dirs.linkShared(file, path.join(d, 'l3'), 'win32');
  assert.deepEqual(types, ['junction', 'file', 'file']);
  assert.ok(fs.lstatSync(path.join(d, 'l1')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(d, 'l3')).isSymbolicLink());
  assert.equal(fs.statSync(path.join(d, 'l3')).ino, fs.statSync(file).ino);
});

test('a Windows link matches its target in any case, with a device prefix or trailing separator', () => {
  const d = fs.mkdtempSync(path.join(tmp, 'win-link-'));
  const target = path.join(d, 'Target');
  fs.symlinkSync(`${target.toUpperCase()}/`, path.join(d, 'a'));
  assert.equal(dirs.linksTo(path.join(d, 'a'), target, 'win32'), true);
  assert.equal(dirs.linksTo(path.join(d, 'a'), target, 'darwin'), false);
  fs.symlinkSync('\\\\?\\' + target, path.join(d, 'b'));
  fs.symlinkSync('\\??\\' + target, path.join(d, 'c'));
  // the prefix is stripped before the path is resolved
  assert.equal(dirs.linksTo(path.join(d, 'b'), path.resolve(target), 'win32'), true);
  assert.equal(dirs.linksTo(path.join(d, 'c'), path.join(d, 'other'), 'win32'), false);
});

test('lock entries are named, and a folder not made yet has no lock links to clean (#1582)', () => {
  assert.deepEqual(
    ['.oauth_refresh.lock', '.oauth_refresh.lock.owner', '.storage-write', '.storage-write.lock', 'settings.json', 'skills', 'clock'].map(
      dirs.isLockEntry,
    ),
    [true, true, true, true, false, false, false],
  );
  assert.doesNotThrow(() => dirs.unlinkLocks(path.join(tmp, 'never-made')));
});

test('removing lock links is best effort: a lock the CLI released meanwhile, a junction, and one that will not go (#1582)', () => {
  const gone = Object.assign(new Error('gone'), { code: 'ENOENT' });
  const removed: string[] = [];
  const fake = (o: { lstat?: (f: string) => any; unlink?: (f: string) => void; rmdir?: (f: string) => void }) => ({
    readdirSync: () => ['.oauth_refresh.lock', '.storage-write.lock', 'skills'],
    lstatSync: o.lstat ?? (() => ({ isSymbolicLink: () => true })),
    unlinkSync: o.unlink ?? ((f: string) => void removed.push(`unlink ${path.basename(f)}`)),
    rmdirSync: o.rmdir ?? ((f: string) => void removed.push(`rmdir ${path.basename(f)}`)),
  });
  // released between the listing and the look: the next entry is still handled
  let first = true;
  dirs.unlinkLocks(
    '/d',
    fake({
      lstat: () => {
        if (first) {
          first = false;
          throw gone;
        }
        return { isSymbolicLink: () => true };
      },
    }) as any,
  );
  assert.deepEqual(removed, ['unlink .storage-write.lock']);
  // a junction (Windows) refuses unlink and is removed as a folder
  removed.length = 0;
  dirs.unlinkLocks(
    '/d',
    fake({
      unlink: () => {
        throw Object.assign(new Error('perm'), { code: 'EPERM' });
      },
    }) as any,
  );
  assert.deepEqual(removed, ['rmdir .oauth_refresh.lock', 'rmdir .storage-write.lock']);
  // anything else is left for the next start, and preparing the folder goes on
  assert.doesNotThrow(() =>
    dirs.unlinkLocks(
      '/d',
      fake({
        unlink: () => {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        },
      }) as any,
    ),
  );
});

test('an old link at an own folder becomes a folder: a dangling one empty, a failing one kept for the next start (#1933)', () => {
  const d = fresh();
  // a link to a folder deleted since: an empty folder, nothing copied
  fs.symlinkSync(path.join(d, 'gone'), path.join(d, 'plans'));
  dirs.ownFolders(d);
  assert.ok(fs.lstatSync(path.join(d, 'plans')).isDirectory());
  assert.deepEqual(fs.readdirSync(path.join(d, 'plans')), []);
  // a real folder is the CLI's own: left alone
  fs.writeFileSync(path.join(d, 'plans', 'p.md'), 'x');
  dirs.ownFolders(d);
  assert.deepEqual(fs.readdirSync(path.join(d, 'plans')), ['p.md']);
  // a link that will not go stays a link; nothing throws
  const e = fresh();
  fs.symlinkSync(d, path.join(e, 'plans'));
  const calls: string[] = [];
  const f = {
    ...fs,
    unlinkSync: () => {
      calls.push('unlink');
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    },
  };
  assert.doesNotThrow(() => dirs.ownFolders(e, f));
  assert.deepEqual(calls, ['unlink']);
  assert.ok(fs.lstatSync(path.join(e, 'plans')).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(e, 'plans.own')));
  // a copy that fails leaves the link for the next start
  const shared = fresh();
  fs.writeFileSync(path.join(shared, 'a.md'), 'A');
  const g = fresh();
  fs.symlinkSync(shared, path.join(g, 'plans'));
  dirs.ownFolders(g, {
    ...fs,
    cpSync: () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  });
  assert.ok(fs.lstatSync(path.join(g, 'plans')).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(g, 'plans.own')));
  // a CLI that made the folder meanwhile keeps what it wrote, and the copies join it
  dirs.ownFolders(g, {
    ...fs,
    renameSync: () => {
      fs.mkdirSync(path.join(g, 'plans'));
      fs.writeFileSync(path.join(g, 'plans', 'a.md'), 'CLI');
      throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' });
    },
  });
  assert.deepEqual(fs.readdirSync(g).sort(), ['plans']);
  assert.equal(fs.readFileSync(path.join(g, 'plans', 'a.md'), 'utf8'), 'CLI');
  assert.equal(fs.readFileSync(path.join(shared, 'a.md'), 'utf8'), 'A');
  // no entry at all: nothing to do
  assert.doesNotThrow(() => dirs.ownFolders(path.join(tmp, 'never-made')));
  assert.deepEqual(dirs.OWN_FOLDERS, ['plans']);
});
