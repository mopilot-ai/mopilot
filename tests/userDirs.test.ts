// The user-tool folders every harness detector shares (electron/platform/userDirs.cjs) and the Node version managers'
// folders behind them (nodeManagers.cjs), read from fixture homes only: nvm's default alias as nvm.sh resolves it, fnm's
// default link, mise's installs, volta/bun/pnpm/asdf/mise shims, npm's prefix, and the variables that move them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nm = require('../electron/platform/nodeManagers.cjs');
const ud = require('../electron/platform/userDirs.cjs');

const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'userdirs-'));
const mk = (...p: string[]) => {
  const d = path.join(...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const write = (file: string, text = '') => {
  mk(path.dirname(file));
  fs.writeFileSync(file, text);
  return file;
};
/** An nvm folder with these Node versions installed (each with an executable bin/node). */
function nvm(home: string, versions: string[], aliases: Record<string, string> = {}) {
  const dir = mk(home, '.nvm');
  for (const v of versions) write(path.join(dir, 'versions', 'node', v, 'bin', 'node'));
  for (const [name, to] of Object.entries(aliases)) write(path.join(dir, 'alias', ...name.split('/')), `${to}\n`);
  return dir;
}
const bin = (dir: string, v: string) => path.join(dir, 'versions', 'node', v, 'bin');

test('Node versions sort by number, newest first, with names that are no version after them', () => {
  assert.deepEqual(['v9.1.0', 'lts', 'v22.1.0', 'v22.10.0', 'zz', 'v22'].sort(nm.newestFirst), [
    'v22.10.0',
    'v22.1.0',
    'v22',
    'v9.1.0',
    'lts',
    'zz',
  ]);
  assert.equal(nm.newestFirst('v1.0.0', 'v1.0.0'), 0);
  assert.equal(nm.newestFirst('lts', 'lts'), 0);
  assert.equal(nm.newestFirst('v1', '1'), 1, 'equal numbers fall back to the name');
  assert.equal(nm.newestFirst('1', 'v1'), -1);
  assert.equal(nm.newestFirst('zz', 'aa'), 1, 'two names that are no version: by name');
  assert.equal(nm.newestFirst('aa', 'zz'), -1);
  assert.deepEqual(nm.parseNodeVersion('v22.1'), { v: [22, 1, 0], parts: 2 });
  assert.equal(nm.parseNodeVersion('1.2.3.4'), null);
  assert.equal(nm.parseNodeVersion('v'), null);
  assert.deepEqual(nm.nodeVersions(path.join(fixture(), 'none'), 'bin'), [], 'no folder: no versions');
});

test("nvm's default alias resolves as nvm.sh does: full, partial, chains, node/stable, lts/-N", () => {
  const home = fixture();
  const dir = nvm(home, ['v18.20.0', 'v20.1.0', 'v22.3.0', 'v22.12.0'], {
    default: 'lts/*',
    'lts/*': 'lts/jod',
    'lts/jod': 'v22.3.0',
    'lts/iron': 'v20.1.0',
  });
  const names = nm.nodeVersions(path.join(dir, 'versions', 'node'), 'bin');
  assert.deepEqual(names, ['v22.12.0', 'v22.3.0', 'v20.1.0', 'v18.20.0']);
  assert.deepEqual(nm.nvmDefault(dir, names), { version: 'v22.3.0', system: false });
  const set = (to: string) => write(path.join(dir, 'alias', 'default'), `\n${to}\n`);
  set('22');
  assert.equal(nm.nvmDefault(dir, names).version, 'v22.12.0', 'a partial version: the newest it starts');
  set('v20.1');
  assert.equal(nm.nvmDefault(dir, names).version, 'v20.1.0');
  set('18.20.0');
  assert.equal(nm.nvmDefault(dir, names).version, 'v18.20.0', 'a full version without its v');
  set('v16.0.0');
  assert.equal(nm.nvmDefault(dir, names).version, null, 'a full version not installed');
  set('v16');
  assert.equal(nm.nvmDefault(dir, names).version, null, 'a partial version nothing starts');
  set('node');
  assert.equal(nm.nvmDefault(dir, names).version, 'v22.12.0');
  set('stable');
  assert.equal(nm.nvmDefault(dir, ['lts']).version, null, 'stable with nothing installed');
  set('iojs');
  assert.equal(nm.nvmDefault(dir, names).version, null, 'not a Node of versions/node');
  set('system');
  assert.deepEqual(nm.nvmDefault(dir, names), { version: null, system: true });
  set('lts/-1');
  assert.equal(nm.nvmDefault(dir, names).version, 'v20.1.0', 'the LTS line before the newest (ls order: *, iron, jod)');
  set('lts/-0');
  assert.equal(nm.nvmDefault(dir, names).version, null, 'lts/-0 is no alias');
  set('lts/-9');
  assert.equal(nm.nvmAlias(path.join(dir, 'alias'), 'lts/-9'), '', 'past the oldest: the first entry, which is *');
  set('../escape');
  assert.equal(nm.nvmDefault(dir, names).version, null, 'an alias that leaves the folder');
  set('\n  \n');
  assert.equal(nm.nvmAlias(path.join(dir, 'alias'), 'default'), '', 'an alias with only blank lines');
  set('loop');
  write(path.join(dir, 'alias', 'loop'), 'default');
  assert.deepEqual(nm.nvmDefault(dir, names), { version: null, system: false }, 'a cycle is none');
  assert.equal(nm.nvmAlias(path.join(fixture(), 'alias'), 'lts/-1'), '', 'no lts folder');
});

test("nvm's bin folders: the default first; the newest when none is set; none for the system's Node", () => {
  const home = fixture();
  const dir = nvm(home, ['v18.0.0', 'v22.0.0'], { default: '18' });
  assert.deepEqual(nm.nvmBins(dir), { def: bin(dir, 'v18.0.0'), all: [bin(dir, 'v18.0.0'), bin(dir, 'v22.0.0')] });
  fs.rmSync(path.join(dir, 'alias'), { recursive: true });
  assert.equal(nm.nvmBins(dir).def, bin(dir, 'v22.0.0'), 'no default: the newest');
  write(path.join(dir, 'alias', 'default'), 'system');
  assert.deepEqual(nm.nvmBins(dir), { def: null, all: [bin(dir, 'v22.0.0'), bin(dir, 'v18.0.0')] });
  assert.deepEqual(nm.nvmBins(path.join(home, 'none')), { def: null, all: [] });
});

test("fnm's default link comes first; a link outside its versions or to a version without bin is none", () => {
  const dir = mk(fixture(), 'fnm');
  const inst = (v: string) => mk(dir, 'node-versions', v, 'installation', 'bin');
  const v18 = inst('v18.0.0');
  const v22 = inst('v22.0.0');
  assert.deepEqual(nm.fnmBins(dir), { def: null, all: [v22, v18] });
  mk(dir, 'aliases');
  fs.symlinkSync(path.join(dir, 'node-versions', 'v18.0.0', 'installation'), path.join(dir, 'aliases', 'default'));
  assert.deepEqual(nm.fnmBins(dir), { def: v18, all: [v18, v22] });
  fs.rmSync(path.join(dir, 'aliases', 'default'));
  fs.symlinkSync(mk(dir, 'elsewhere'), path.join(dir, 'aliases', 'default'));
  assert.equal(nm.fnmBins(dir).def, null, 'outside node-versions');
  fs.rmSync(path.join(dir, 'aliases', 'default'));
  fs.symlinkSync(mk(dir, 'node-versions', 'v1.0.0'), path.join(dir, 'aliases', 'default'));
  assert.equal(nm.fnmBins(dir).def, null, 'a version folder without bin');
  const mise = mk(fixture(), 'installs', 'node');
  mk(mise, '20.1.0', 'bin');
  mk(mise, 'lts', 'bin');
  assert.deepEqual(nm.nodeBins(mise), [path.join(mise, '20.1.0', 'bin'), path.join(mise, 'lts', 'bin')]);
});

test('the shared list: each manager in order, only folders that exist, every Node version only when asked', () => {
  const home = fixture();
  const dir = nvm(home, ['v20.0.0', 'v22.0.0'], { default: '20' });
  const fnmDir = mk(home, '.local', 'share', 'fnm');
  const fnm = mk(fnmDir, 'node-versions', 'v21.0.0', 'installation', 'bin');
  mk(fnmDir, 'aliases');
  fs.symlinkSync(path.dirname(fnm), path.join(fnmDir, 'aliases', 'default'));
  const mise = mk(home, '.local', 'share', 'mise', 'installs', 'node', '23.0.0', 'bin');
  const want = [
    bin(dir, 'v20.0.0'),
    fnm,
    mk(home, '.volta', 'bin'),
    mk(home, '.local', 'share', 'mise', 'shims'),
    mk(home, '.asdf', 'shims'),
    mk(home, '.bun', 'bin'),
    mk(home, '.local', 'bin'),
    mk(home, '.npm-global', 'bin'),
    mk(home, 'npm-prefix', 'bin'),
    mk(home, 'Library', 'pnpm'),
  ];
  write(path.join(home, '.npmrc'), `registry=https://x\nprefix = "~/npm-prefix"\n`);
  const cargo = mk(home, '.cargo', 'bin');
  const sys = ['/opt/homebrew/bin', '/usr/local/bin'].filter((d) => fs.existsSync(d));
  assert.deepEqual(ud.userToolDirs({ home, vars: {}, platform: 'darwin' }), [...want, ...sys, cargo]);
  assert.deepEqual(ud.userToolDirs({ home, vars: {}, platform: 'darwin', everyNode: true }).slice(want.length + sys.length + 1), [
    bin(dir, 'v22.0.0'),
    mise,
  ]);
  assert.deepEqual(ud.userToolDirs({ home, vars: {}, platform: 'win32' }), [], 'Windows: winbin.cjs');
  assert.deepEqual(ud.userToolDirs({ home: '', vars: {}, platform: 'darwin' }), []);
  const every = ud.userToolDirs({ home: path.join(home, 'none'), vars: {}, platform: 'darwin', keep: () => true });
  assert.ok(every.includes(path.join(home, 'none', '.bun', 'bin')), '`keep` lists folders that are not there yet');
});

test('variables move a manager’s folder; relative values are ignored', () => {
  const home = fixture();
  const alt = fixture();
  const vars = {
    NVM_DIR: nvm(alt, ['v20.0.0']),
    VOLTA_HOME: mk(alt, 'volta'),
    BUN_INSTALL: mk(alt, 'bun'),
    PNPM_HOME: mk(alt, 'pnpm'),
    MISE_DATA_DIR: mk(alt, 'mise'),
    ASDF_DATA_DIR: mk(alt, 'asdf'),
    XDG_DATA_HOME: 'relative/data',
    FNM_DIR: mk(alt, 'fnm'),
  };
  mk(alt, 'volta', 'bin');
  mk(alt, 'bun', 'bin');
  mk(alt, 'mise', 'shims');
  mk(alt, 'asdf', 'shims');
  const fnm = mk(alt, 'fnm', 'node-versions', 'v19.0.0', 'installation', 'bin');
  const dirs = ud.userToolDirs({ home, vars, platform: 'linux', everyNode: true });
  for (const d of [
    path.join(alt, '.nvm', 'versions', 'node', 'v20.0.0', 'bin'),
    path.join(alt, 'volta', 'bin'),
    path.join(alt, 'bun', 'bin'),
    path.join(alt, 'pnpm'),
    path.join(alt, 'mise', 'shims'),
    path.join(alt, 'asdf', 'shims'),
    fnm,
  ])
    assert.ok(dirs.includes(d), d);
});

test("npm's prefix: NPM_CONFIG_PREFIX, else ~/.npmrc; relative and missing ones are none", () => {
  const home = fixture();
  assert.equal(ud.npmPrefixBin(home, {}), null, 'no .npmrc');
  assert.equal(ud.npmPrefixBin(home, { NPM_CONFIG_PREFIX: '/p' }), '/p/bin');
  assert.equal(ud.npmPrefixBin(home, { npm_config_prefix: '/q' }), '/q/bin');
  write(path.join(home, '.npmrc'), 'prefix=relative\n');
  assert.equal(ud.npmPrefixBin(home, { NPM_CONFIG_PREFIX: 'rel' }), null);
  write(path.join(home, '.npmrc'), "prefix='/abs/npm'\n");
  assert.equal(ud.npmPrefixBin(home, {}), '/abs/npm/bin');
});

test('the default list is reused for a minute per home and variables, and looked at again when forgotten', () => {
  const home = fixture();
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    ud.forgetUserDirs();
    assert.deepEqual(
      ud.defaultUserDirs({}, 1000).filter((d: string) => d.startsWith(home)),
      [],
    );
    const local = mk(home, '.local', 'bin');
    assert.ok(!ud.defaultUserDirs({}, 1000 + ud.TTL_MS - 1).includes(local), 'cached');
    assert.ok(ud.defaultUserDirs({}, 1000 + ud.TTL_MS).includes(local), 'looked at again after the TTL');
    const bun = mk(home, 'bun2', 'bin');
    assert.ok(ud.defaultUserDirs({ BUN_INSTALL: path.dirname(bun) }, 1000 + ud.TTL_MS).includes(bun), 'other variables: another list');
    const cargo = mk(home, '.cargo', 'bin');
    ud.forgetUserDirs();
    assert.ok(ud.defaultUserDirs({}, 1000 + ud.TTL_MS).includes(cargo), 'forgotten: looked at again');
    assert.ok(ud.defaultUserDirs().includes(cargo), 'defaults: this process');
    const v20 = path.join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin');
    fs.mkdirSync(v20, { recursive: true });
    fs.writeFileSync(path.join(v20, 'node'), '');
    ud.forgetUserDirs();
    assert.ok(ud.defaultUserDirs({}, 0, true).includes(v20), 'every Node version, cached apart');
    // a ninth set of variables starts the cache over rather than growing it
    for (let i = 0; i < 9; i++) ud.defaultUserDirs({ BUN_INSTALL: `/b${i}` }, 0);
    assert.ok(ud.defaultUserDirs({}, 0, true).includes(v20));
  } finally {
    process.env.HOME = saved;
    ud.forgetUserDirs();
  }
});
