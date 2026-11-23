// A phone build carries the commit it was made from, About shows it, and a build of another tree is refused before it is installed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { buildCommit, treeCommit } = require('../mobile/config/commit.js');
const appConfig = require('../mobile/app.config.js');
const { builtCommit, checkBuild } = await import('../scripts/mobile-ios-commit.mjs');
const versionPath = '../mobile/src/appVersion.ts';
const { displayVersion } = await import(versionPath);
const script = path.join(import.meta.dirname, '../scripts/mobile-ios-commit.mjs');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-repo-'));
  git(dir, 'init', '-q');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');
  return dir;
}
function app(commit?: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-app-'));
  fs.mkdirSync(path.join(dir, 'EXConstants.bundle'));
  fs.writeFileSync(
    path.join(dir, 'EXConstants.bundle', 'app.config'),
    JSON.stringify({ extra: commit === undefined ? {} : { buildCommit: commit } }),
  );
  return dir;
}

test('the tree commit is the short sha, marked dirty while tracked files differ, and absent where there is no tree', () => {
  const dir = repo();
  const sha = git(dir, 'rev-parse', '--short=9', 'HEAD');
  assert.equal(treeCommit(dir), sha);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  git(dir, 'add', 'file.txt');
  assert.equal(treeCommit(dir), `${sha}-dirty`);
  assert.equal(treeCommit(fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-none-'))), undefined, 'not a git tree');
  assert.equal(
    treeCommit('/x', () => 'not a sha\n'),
    undefined,
    'git said something else',
  );
});

test('the build stamp is the given commit, refused when malformed, else the tree it is read from', () => {
  assert.equal(buildCommit({ MOPILOT_BUILD_COMMIT: ' abc1234 ' }, '/x'), 'abc1234');
  assert.equal(buildCommit({ MOPILOT_BUILD_COMMIT: 'abc1234-dirty' }, '/x'), 'abc1234-dirty');
  assert.throws(() => buildCommit({ MOPILOT_BUILD_COMMIT: 'main' }, '/x'), /must be a short or full commit sha/);
  const dir = repo();
  assert.equal(buildCommit({}, dir), git(dir, 'rev-parse', '--short=9', 'HEAD'));
});

test('the Expo config carries the stamp for the app to show and the install check to read', () => {
  const before = process.env.MOPILOT_BUILD_COMMIT;
  process.env.MOPILOT_BUILD_COMMIT = 'abc1234';
  try {
    assert.equal(appConfig({ config: {} }).extra.buildCommit, 'abc1234');
  } finally {
    if (before === undefined) delete process.env.MOPILOT_BUILD_COMMIT;
    else process.env.MOPILOT_BUILD_COMMIT = before;
  }
});

test('About shows the version, with the commit the build carries', () => {
  assert.equal(displayVersion({ expoConfig: { version: '1.0.0', extra: { buildCommit: 'abc1234' } } }), '1.0.0 (abc1234)');
  assert.equal(displayVersion({ expoConfig: { version: '1.0.0', extra: {} } }), '1.0.0');
  assert.equal(
    displayVersion({ expoConfig: { version: '1.0.0', extra: { buildCommit: 7 } } }),
    '1.0.0',
    'a stamp that is not text is not shown',
  );
  assert.equal(displayVersion({ expoConfig: { extra: { buildCommit: 'abc1234' } } }), undefined, 'no version, nothing to show');
  assert.equal(displayVersion({ expoConfig: null }), undefined);
});

test('a built app tells its commit, or nothing when it carries none or cannot be read', () => {
  assert.equal(builtCommit(app('abc1234')), 'abc1234');
  assert.equal(builtCommit(app()), undefined);
  assert.equal(builtCommit(app(7)), undefined);
  assert.equal(builtCommit('/no/such/app'), undefined);
});

test('a build is accepted only when it was made from the tree it was asked for', () => {
  const dir = repo();
  const sha = git(dir, 'rev-parse', '--short=9', 'HEAD');
  assert.deepEqual(checkBuild(app(sha), dir), { ok: true, commit: sha });
  const other = checkBuild(app('0123456'), dir);
  assert.equal(other.ok, false);
  assert.match((other as { reason: string }).reason, new RegExp(`built from 0123456, not from ${sha}`));
  assert.match((checkBuild(app(), dir) as { reason: string }).reason, /carries no build commit/);
  assert.match(
    (checkBuild(app(sha), fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-none-'))) as { reason: string }).reason,
    /not a git tree/,
  );
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  git(dir, 'add', 'file.txt');
  assert.equal(checkBuild(app(sha), dir).ok, false, 'a tree changed after the build is not the build');
});

test('the install step exits with the reason when the build is of another tree, and quietly when it is right', () => {
  const dir = repo();
  const sha = git(dir, 'rev-parse', '--short=9', 'HEAD');
  const run = (...args: string[]) => spawnSync('node', [script, ...args], { encoding: 'utf8' });
  const good = run(app(sha), dir);
  assert.equal(good.status, 0);
  assert.match(good.stdout, new RegExp(`build commit ${sha} matches`));
  const bad = run(app('0123456'), dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /refusing to install: .* was built from 0123456/);
  assert.equal(run().status, 2);
});
