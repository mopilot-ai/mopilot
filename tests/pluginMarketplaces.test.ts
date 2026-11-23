// The plugin store's marketplaces (electron/plugins/marketplaces.cjs): local and git sources added, upgraded and
// removed through a staging folder, and a plugin entry fetched to a folder to install from. Git is a fake that
// copies fixture folders, except one check that the real runner runs git. Data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Marketplaces, runGit } = require('../electron/plugins/marketplaces.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-mkt-'));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** A Claude-layout marketplace folder with path, git-subdir and whole-repo entries. */
function marketplace(root: string, name = 'acme', layout = '.claude-plugin/marketplace.json') {
  write(
    path.join(root, layout),
    JSON.stringify({
      name,
      plugins: [
        { name: 'local-one', source: './plugins/local-one' },
        { name: 'remote', source: { source: 'git-subdir', url: 'https://example.test/r.git', path: 'plugins/remote', sha: 'abc123' } },
        { name: 'whole', source: { source: 'url', url: 'https://example.test/w.git', ref: 'v1' } },
        { name: 'escape', source: './plugins/escape' },
        { name: 'sub-escape', source: { source: 'git-subdir', url: 'https://example.test/r.git', path: 'plugins/link' } },
        { name: 'broken', source: { source: 'url', url: 'https://example.test/missing.git' } },
      ],
    }),
  );
  write(path.join(root, 'plugins/local-one/.claude-plugin/plugin.json'), '{"name":"local-one"}');
  const outside = tmp();
  fs.symlinkSync(outside, path.join(root, 'plugins/escape'));
  return root;
}

function pluginRepo() {
  const root = tmp();
  write(path.join(root, 'plugins/remote/.claude-plugin/plugin.json'), '{"name":"remote"}');
  write(path.join(root, '.claude-plugin/plugin.json'), '{"name":"whole"}');
  fs.symlinkSync(tmp(), path.join(root, 'plugins/link'));
  return root;
}

type Run = { ok: boolean; stdout: string; stderr: string };
/** git that "fetches" a fixture folder per URL and checks it out by copying it. */
function fakeGit(repos: Record<string, string>) {
  const log: string[][] = [];
  const fetched = new Map<string, string>();
  const ok: Run = { ok: true, stdout: '', stderr: '' };
  const git = async (args: string[], cwd: string): Promise<Run> => {
    log.push(args);
    if (args[0] === 'fetch') {
      const url = args[4];
      if (!repos[url]) return { ok: false, stdout: '', stderr: url.includes('silent') ? '' : 'fatal: repository not found\n' };
      fetched.set(cwd, url);
    }
    if (args[0] === 'checkout') fs.cpSync(repos[fetched.get(cwd) as string], cwd, { recursive: true, verbatimSymlinks: true });
    return ok;
  };
  return { git, log };
}

function setup(repos: Record<string, string> = {}) {
  const dir = tmp();
  const { git, log } = fakeGit(repos);
  let changes = 0;
  const m = new Marketplaces({ dir: () => dir, home: '/home/me', git, onChange: () => changes++, now: () => 5 });
  return { dir, m, log, changes: () => changes };
}

const leftovers = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith('.staging-'));

test('a local marketplace is read in place and named by its manifest', async () => {
  const { dir, m, changes } = setup();
  const src = marketplace(tmp());
  assert.equal(await m.add(src), 'acme');
  assert.equal(changes(), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'known.json'), 'utf8')), {
    acme: { source: { kind: 'local', path: src }, addedAt: 5 },
  });
  await assert.rejects(m.add(src), /already added/);
  await assert.rejects(m.add(tmp()), /No \.claude-plugin\/marketplace\.json/);
  await assert.rejects(m.add('file:///etc'), /isn't a folder, owner\/repo or git URL/);
  assert.equal(await m.upgrade('acme'), false, 'a local folder has nothing to fetch');
  assert.equal(await m.remove('acme'), true);
  assert.ok(fs.existsSync(src), 'a local folder is left alone');
  assert.equal(await m.remove('acme'), false);
});

test('a git marketplace is checked out in staging and renamed into place', async () => {
  const repo = marketplace(tmp(), 'acme', '.agents/plugins/marketplace.json');
  const { dir, m, log } = setup({ 'https://github.com/acme/mkt.git': repo });
  assert.equal(await m.add('acme/mkt'), 'acme');
  assert.deepEqual(log.slice(0, 3), [
    ['init', '--quiet'],
    ['fetch', '--quiet', '--depth', '1', 'https://github.com/acme/mkt.git', 'HEAD'],
    ['checkout', '--quiet', '--detach', 'FETCH_HEAD'],
  ]);
  assert.ok(fs.existsSync(path.join(dir, 'marketplaces/acme/.agents/plugins/marketplace.json')));
  assert.deepEqual(leftovers(dir), []);
  assert.equal((await m.catalog()).marketplaces[0].marketplace.name, 'acme', 'read from its clone');
  await assert.rejects(m.add('acme/mkt'), /already added/);
  assert.deepEqual(leftovers(dir), []);
  assert.equal(await m.remove('acme'), true);
  assert.equal(fs.existsSync(path.join(dir, 'marketplaces/acme')), false);
});

test('a git source that fails to fetch, or holds no marketplace, adds nothing', async () => {
  const { dir, m } = setup({ 'https://example.test/empty.git': tmp() });
  await assert.rejects(
    m.add('https://example.test/none.git#v1'),
    /git fetch failed for https:\/\/example\.test\/none\.git: fatal: repository not found/,
  );
  await assert.rejects(m.add('https://silent.test/x.git'), /git fetch failed for https:\/\/silent\.test\/x\.git: no output/);
  await assert.rejects(m.add('https://example.test/empty.git'), /No \.claude-plugin\/marketplace\.json/);
  assert.deepEqual(leftovers(dir), []);
  assert.equal(fs.existsSync(path.join(dir, 'known.json')), false);
});

test('upgrade swaps in a fresh checkout and keeps the old one when anything fails', async () => {
  const repos: Record<string, string> = { 'https://github.com/acme/mkt.git': marketplace(tmp()) };
  const { dir, m } = setup(repos);
  await m.add('acme/mkt');
  await assert.rejects(m.upgrade('nope'), /No marketplace named "nope"/);
  write(path.join(repos['https://github.com/acme/mkt.git'], 'NEW'), 'x');
  assert.equal(await m.upgrade('acme'), true);
  assert.ok(fs.existsSync(path.join(dir, 'marketplaces/acme/NEW')));
  assert.deepEqual(
    fs.readdirSync(path.join(dir, 'marketplaces')).filter((n) => n.includes('.old-')),
    [],
  );

  repos['https://github.com/acme/mkt.git'] = marketplace(tmp(), 'renamed');
  await assert.rejects(m.upgrade('acme'), /now named "renamed", not "acme"/);
  assert.ok(fs.existsSync(path.join(dir, 'marketplaces/acme/NEW')), 'the old checkout stays');

  repos['https://github.com/acme/mkt.git'] = tmp();
  await assert.rejects(m.upgrade('acme'), /No \.claude-plugin\/marketplace\.json/);

  // a clone deleted behind the store's back is fetched again
  repos['https://github.com/acme/mkt.git'] = marketplace(tmp());
  fs.rmSync(path.join(dir, 'marketplaces/acme'), { recursive: true });
  assert.equal(await m.upgrade('acme'), true);
  assert.ok(fs.existsSync(path.join(dir, 'marketplaces/acme/.claude-plugin/marketplace.json')));
  assert.deepEqual(leftovers(dir), []);
});

test('a swap that fails puts the previous checkout back', async (t) => {
  const repos: Record<string, string> = { 'https://github.com/acme/mkt.git': marketplace(tmp()) };
  const { dir, m } = setup(repos);
  await m.add('acme/mkt');
  write(path.join(dir, 'marketplaces/acme/MARK'), 'old');
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from: string, to: string) => {
    if (path.basename(from).startsWith('.staging-')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  await assert.rejects(m.upgrade('acme'), /disk full/);
  assert.ok(fs.existsSync(path.join(dir, 'marketplaces/acme/MARK')));
});

test('a swap that cannot move the old checkout aside changes nothing', async (t) => {
  const repos: Record<string, string> = { 'https://github.com/acme/mkt.git': marketplace(tmp()) };
  const { dir, m } = setup(repos);
  await m.add('acme/mkt');
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from: string, to: string) => {
    if (to.includes('.old-')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return rename(from, to);
  });
  await assert.rejects(m.upgrade('acme'), /busy/);
  assert.ok(fs.existsSync(path.join(dir, 'marketplaces/acme/.claude-plugin/marketplace.json')));
  assert.deepEqual(leftovers(dir), []);
});

test('the catalog lists every marketplace, and says which can no longer be read', async () => {
  const { dir, m } = setup();
  const a = marketplace(tmp(), 'acme');
  const b = marketplace(tmp(), 'beta');
  await m.add(b);
  await m.add(a);
  fs.rmSync(path.join(b, '.claude-plugin'), { recursive: true });
  const c = await m.catalog();
  assert.equal(c.error, null);
  assert.deepEqual(
    c.marketplaces.map((x: { name: string }) => x.name),
    ['acme', 'beta'],
  );
  assert.equal(c.marketplaces[0].marketplace.plugins.length, 6);
  assert.equal(c.marketplaces[1].marketplace, null);
  assert.match(c.marketplaces[1].error, /No \.claude-plugin/);

  fs.rmSync(path.join(a, '.claude-plugin/marketplace.json'));
  fs.mkdirSync(path.join(a, '.claude-plugin/marketplace.json'));
  assert.match((await m.catalog()).marketplaces[0].error, /^\.claude-plugin\/marketplace\.json: .*EISDIR/);

  fs.writeFileSync(path.join(dir, 'known.json'), '[ broken');
  const broken = await m.catalog();
  assert.deepEqual(broken.marketplaces, []);
  assert.match(broken.error, /JSON/);
  await assert.rejects(m.add(marketplace(tmp(), 'gamma')), /couldn't be read, so it wasn't changed/);
  assert.equal(fs.readFileSync(path.join(dir, 'known.json'), 'utf8'), '[ broken');
});

test('a plugin entry is fetched to a folder to install from, never outside its source', async () => {
  const repo = pluginRepo();
  const { dir, m, log } = setup({ 'https://example.test/r.git': repo, 'https://example.test/w.git': repo });
  const src = marketplace(tmp());
  await m.add(src);

  const local = await m.fetchPlugin('acme', 'local-one');
  assert.equal(local.dir, path.join(src, 'plugins/local-one'));
  assert.equal(local.entry.name, 'local-one');
  await local.done();
  assert.ok(fs.existsSync(local.dir), 'a path inside the marketplace is used in place');

  const remote = await m.fetchPlugin('acme', 'remote');
  assert.ok(fs.existsSync(path.join(remote.dir, '.claude-plugin/plugin.json')));
  assert.match(remote.dir, /\.staging-[^/]+\/plugins\/remote$/);
  assert.deepEqual(log.at(-2), ['fetch', '--quiet', '--depth', '1', 'https://example.test/r.git', 'abc123']);
  await remote.done();
  assert.deepEqual(leftovers(dir), []);

  const whole = await m.fetchPlugin('acme', 'whole');
  assert.deepEqual(log.at(-2), ['fetch', '--quiet', '--depth', '1', 'https://example.test/w.git', 'v1']);
  assert.match(whole.dir, /\.staging-[^/]+$/);
  await whole.done();

  await assert.rejects(m.fetchPlugin('acme', 'escape'), /points outside its marketplace/);
  await assert.rejects(m.fetchPlugin('acme', 'sub-escape'), /points outside its source/);
  await assert.rejects(m.fetchPlugin('acme', 'broken'), /git fetch failed/);
  assert.deepEqual(leftovers(dir), []);
  await assert.rejects(m.fetchPlugin('acme', 'absent'), /"absent" isn't in acme/);
  await assert.rejects(m.fetchPlugin('nope', 'x'), /No marketplace named "nope"/);
  await assert.rejects(m.fetchPlugin('acme', '../x'), /Not a marketplace plugin/);
  await assert.rejects(m.fetchPlugin('bad name', 'x'), /Not a marketplace plugin/);
  fs.rmSync(path.join(src, '.claude-plugin'), { recursive: true });
  await assert.rejects(m.fetchPlugin('acme', 'local-one'), /No \.claude-plugin/);
});

test('the real runner runs git without a terminal prompt', async () => {
  const ok = await runGit(['--version'], tmp());
  assert.equal(ok.ok, true);
  assert.match(ok.stdout, /^git version/);
  const bad = await runGit(['definitely-not-a-git-command'], tmp());
  assert.equal(bad.ok, false);
  assert.match(bad.stderr, /not a git command/);
});

test('a store without listeners or a clock still records changes', async () => {
  const dir = tmp();
  const m = new Marketplaces({ dir: () => dir, home: '/h' });
  assert.equal(await m.add(marketplace(tmp())), 'acme');
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(dir, 'known.json'), 'utf8')).acme.addedAt, 'number');
});
