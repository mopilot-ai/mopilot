// scripts/gen-third-party.mjs: a lockfile missing what it needs, packages without a license, and the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, recorder, runScript, tempDir } from './support/scripts-shared-cli.ts';

const gen = await import('../scripts/gen-third-party.mjs');
const lock = () => JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8')).packages;

test('a component missing from the lockfile is an error', () => {
  const packages = lock();
  delete packages['node_modules/zod'];
  assert.throws(() => gen.build(packages), /zod is not in package-lock\.json/);
});

test('a pulled-in package without a license field says so in both files', () => {
  const packages = lock();
  const dep = gen.build(packages).rest[0];
  delete packages[dep.key].license;
  assert.ok(gen.build(packages).text.includes(`| ${dep.version} | not stated |`));
  const root = tempDir();
  const notices = [
    { title: 'one', key: gen.NOTICE_PACKAGES[0].key, license: 'MIT' },
    { title: '@vscode/ripgrep (w)', key: gen.NOTICE_PACKAGES[3].key, license: 'MIT' },
  ];
  for (const n of notices) fs.mkdirSync(path.join(root, n.key), { recursive: true });
  fs.writeFileSync(path.join(root, notices[0].key, 'LICENSE'), 'License one\r\n');
  fs.writeFileSync(path.join(root, notices[0].key, 'NOTICE'), 'Notice one');
  fs.writeFileSync(path.join(root, notices[1].key, 'LICENSE'), 'License two');
  const text = gen.buildNotices({ packages, root, notices, featureNotices: [] });
  assert.ok(text.includes(`| \`${dep.name}\` | ${dep.version} | not stated |`));
  assert.ok(text.includes('#### LICENSE\n\n```text\nLicense one\n```\n\n#### NOTICE\n\n```text\nNotice one\n```'));
  assert.equal(text.split('#### NOTICE').length, 2);
  assert.ok(text.includes(gen.RIPGREP_LICENSES));
});

test('a notices package missing from the lockfile or without a LICENSE file is an error', () => {
  const packages = lock();
  assert.throws(
    () => gen.buildNotices({ packages, root: tempDir(), notices: [{ title: 'x', key: 'node_modules/nope', license: 'MIT' }] }),
    /node_modules\/nope is not in package-lock\.json/,
  );
  assert.throws(
    () => gen.buildNotices({ packages, root: tempDir(), notices: [gen.NOTICE_PACKAGES[0]] }),
    /node_modules\/@playwright\/mcp has no LICENSE file/,
  );
});

test('the command line writes both files, and --check reports the first stale one', () => {
  const files = () => [
    ['/a.md', 'a.md', 'A'],
    ['/b.md', 'b.md', 'B'],
  ];
  const disk = new Map([['/a.md', 'A']]);
  const fsx = {
    existsSync: (f: string) => disk.has(f),
    readFileSync: (f: string) => disk.get(f),
    writeFileSync: recorder((f: string, t: string) => disk.set(f, t)),
  };
  const error = recorder();
  assert.equal(gen.main(['--check'], { files, fsx: fsx as any, error }), 1);
  assert.deepEqual(error.calls, [['b.md is stale; run npm run third-party']]);
  disk.set('/b.md', 'old');
  assert.equal(gen.main(['--check'], { files, fsx: fsx as any, error }), 1);
  const log = recorder();
  assert.equal(gen.main([], { files, fsx: fsx as any, log }), 0);
  assert.deepEqual(fsx.writeFileSync.calls, [
    ['/a.md', 'A'],
    ['/b.md', 'B'],
  ]);
  assert.deepEqual(log.calls, [['a.md'], ['b.md']]);
  assert.equal(gen.main(['--check'], { files, fsx: fsx as any, error }), 0);
});

test('run directly with --check, the committed files are current', () => {
  const r = runScript('scripts/gen-third-party.mjs', ['--check']);
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
});
