// electron/harness/installTools.cjs: npm and Homebrew on the login-shell PATH, and whether npm's global folder can be
// written without admin rights, read without running npm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { installTools, npmPrefix, npmrcPrefix } = require('../electron/harness/installTools.cjs');

const err = (code: string) => Object.assign(new Error(code), { code });
const noRc = () => {
  throw err('ENOENT');
};
/** `writable`: folders that can be written; `present`: folders that exist but can't. Anything else is missing. */
const fsOf = (writable: string[], present: string[] = []) => ({
  access: (p: string) => {
    if (writable.includes(p)) return;
    throw err(present.includes(p) ? 'EACCES' : 'ENOENT');
  },
});
const which = (found: Record<string, string>) => (n: string) => found[n] ?? null;

test('no npm: Node.js is missing and there is no npm folder to ask about; Homebrew is looked for on its own', () => {
  assert.deepEqual(installTools({ which: which({}), env: {}, platform: 'darwin', home: '/h', readFile: noRc }), {
    npm: false,
    brew: false,
    npmWritable: null,
  });
  assert.deepEqual(
    installTools({ which: which({ brew: '/opt/homebrew/bin/brew' }), env: {}, platform: 'darwin', home: '/h', readFile: noRc }),
    {
      npm: false,
      brew: true,
      npmWritable: null,
    },
  );
  // Homebrew is never a Windows tool, whatever PATH holds
  assert.equal(installTools({ which: which({ brew: 'C:\\brew' }), env: {}, platform: 'win32', home: '/h', readFile: noRc }).brew, false);
});

test("npm's prefix: the environment, then ~/.npmrc, then the folder npm itself lives in (%APPDATA%\\npm on Windows)", () => {
  const base = { npmBin: '/usr/local/bin/npm', home: '/h', platform: 'darwin', readFile: noRc };
  assert.equal(npmPrefix({ ...base, env: { npm_config_prefix: '/e' } }), '/e');
  assert.equal(npmPrefix({ ...base, env: { NPM_CONFIG_PREFIX: '/E' } }), '/E');
  assert.equal(npmPrefix({ ...base, env: {}, readFile: () => 'x=1\nprefix = ~/.npm-global\n' }), '/h/.npm-global');
  assert.equal(npmPrefix({ ...base, env: {}, readFile: () => 'registry=https://r\n' }), '/usr/local');
  assert.equal(npmPrefix({ ...base, env: {} }), '/usr/local');
  assert.equal(npmPrefix({ ...base, platform: 'win32', npmBin: '/nodejs/npm.cmd', env: { APPDATA: '/AppData' } }), '/AppData/npm');
  assert.equal(npmPrefix({ ...base, platform: 'win32', npmBin: '/nodejs/npm.cmd', env: {} }), '/nodejs');
  assert.equal(npmrcPrefix('prefix=~', '/h'), '/h');
  assert.equal(npmrcPrefix('prefix=~other/x', '/h'), '~other/x', "only the user's own ~ expands");
  assert.equal(npmrcPrefix('', '/h'), null);
});

test("npm's global folder: writable, not yet made under a writable folder, or owned by root (needs admin rights)", () => {
  const run = (fs: any, env: any = {}, platform = 'darwin') =>
    installTools({ which: which({ npm: '/usr/local/bin/npm' }), env, platform, home: '/h', readFile: noRc, ...fs }).npmWritable;
  assert.equal(run(fsOf(['/usr/local/lib/node_modules'])), true);
  // a prefix whose node_modules isn't there yet is writable if the nearest folder above it is
  assert.equal(run(fsOf(['/h']), { npm_config_prefix: '/h/.npm-global' }), true);
  // a system Node's root-owned prefix: installing there needs sudo, which we never run
  assert.equal(run(fsOf([], ['/usr/local/lib/node_modules'])), false);
  // nothing up to the root exists or can be written
  assert.equal(run(fsOf([])), false);
  assert.equal(run(fsOf(['/AppData/npm/node_modules']), { APPDATA: '/AppData' }, 'win32'), true);
});

test('defaults read a real .npmrc and real folders', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-tools-'));
  try {
    const npmBin = path.join(home, 'node', 'bin', 'npm');
    // no .npmrc in this home: npm's own prefix, whose lib/node_modules isn't made yet, under a folder we can write
    assert.deepEqual(installTools({ which: which({ npm: npmBin }), env: {}, home, platform: 'linux' }), {
      npm: true,
      brew: false,
      npmWritable: true,
    });
    fs.writeFileSync(path.join(home, '.npmrc'), 'prefix=~/g\n');
    assert.equal(
      npmPrefix({ npmBin, env: {}, home, platform: 'linux', readFile: (p: string) => fs.readFileSync(p, 'utf8') }),
      path.join(home, 'g'),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
