// Finding a harness CLI the way the user's terminal would, and whether the terminal runs that same file
// (electron/platform/userTools.cjs): the user's path, then PATH, then the shared user-tool folders and every Node
// version, then the harness's own places; offPath when the login shell's PATH runs another file or none. The login
// shell (env.cjs) is faked; homes are fixtures.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';

const fake = { childPath: '', loginPath: null as string | null, vars: {} as Record<string, string> };
/** The first `name` in a PATH-like list of folders (env.cjs which, without the executable bit). */
const lookIn = (name: string, p: string) =>
  p
    .split(':')
    .map((d) => path.join(d, name))
    .find((f) => d(f)) ?? null;
const d = (f: string) => fs.existsSync(f) && fs.statSync(f).isFile();
mock.module(path.resolve('electron/platform/env.cjs'), {
  exports: {
    which: (name: string, envPath?: string) => lookIn(name, envPath ?? fake.childPath),
    loginPath: () => fake.loginPath,
    dirVars: () => fake.vars,
  },
});
const require = createRequire(import.meta.url);
const ut = require('../electron/platform/userTools.cjs');

const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usertools-'));
const exe = (file: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
};
function withHome(t: any) {
  const home = fixture();
  const saved = process.env.HOME;
  process.env.HOME = home;
  fake.vars = {};
  t.after(() => (process.env.HOME = saved));
  return home;
}

test('pathStatus: the same file through a link is on PATH; another file, or none, is not; unknown when unasked', () => {
  const root = fixture();
  const mine = exe(path.join(root, 'nvm', 'bin', 'codex'));
  const linked = path.join(root, 'linkdir', 'codex');
  fs.mkdirSync(path.dirname(linked));
  fs.symlinkSync(mine, linked);
  const other = exe(path.join(root, 'brew', 'codex'));
  assert.deepEqual(ut.pathStatus(mine, ['codex'], { loginPath: path.dirname(linked) }), { offPath: false, terminal: linked });
  assert.deepEqual(ut.pathStatus(mine, ['codex'], { loginPath: `${path.dirname(other)}:${path.dirname(mine)}` }), {
    offPath: true,
    terminal: other,
  });
  assert.deepEqual(ut.pathStatus(mine, ['codex'], { loginPath: '/nowhere' }), { offPath: true, terminal: null });
  assert.deepEqual(ut.pathStatus(mine, ['codex'], { loginPath: null }), { offPath: false, terminal: null }, 'shell never answered');
  assert.deepEqual(ut.pathStatus(null, ['codex'], { loginPath: '/x' }), { offPath: false, terminal: null });
  // a bare name left to PATH, and CLIs an app ships inside itself, are never said to be off PATH
  const none = { offPath: false, terminal: null };
  assert.deepEqual(ut.pathStatus('codex', ['codex'], { loginPath: '/nowhere' }), none);
  assert.deepEqual(ut.pathStatus('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', ['codex'], { loginPath: '/x' }), none);
  assert.deepEqual(
    ut.pathStatus('/Users/a/Library/Application Support/Claude/claude-code/2.1/claude', ['claude'], { loginPath: '/x' }),
    none,
  );
  assert.deepEqual(
    ut.pathStatus('C:\\Users\\a\\AppData\\Roaming\\Claude\\claude-code\\2.1\\claude.exe', ['claude'], { loginPath: '/x' }).offPath,
    false,
  );
  // names are tried in order; the default PATH is the login shell's
  fake.loginPath = path.dirname(other);
  assert.deepEqual(ut.pathStatus(other, ['nope', 'codex']), { offPath: false, terminal: other });
  fake.loginPath = null;
  assert.deepEqual(ut.offPathFields(mine, ['codex'], { loginPath: path.dirname(other) }), { offPath: true, terminal: other });
  assert.deepEqual(ut.offPathFields(other, ['codex'], { loginPath: path.dirname(other) }), {}, 'nothing to say: no fields');
  assert.equal(ut.fileKey(path.join(root, 'GONE'), 'win32'), path.join(root, 'GONE').toLowerCase());
});

test('resolveTool: the user path, then PATH, then every Node version, then the harness’s own places', (t) => {
  const home = withHome(t);
  const v18 = exe(path.join(home, '.nvm', 'versions', 'node', 'v18.0.0', 'bin', 'gemini'));
  exe(path.join(home, '.nvm', 'versions', 'node', 'v18.0.0', 'bin', 'node'));
  fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, '.nvm', 'alias'));
  fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), '22');
  const own = exe(path.join(home, '.gemini', 'bin', 'gemini'));
  const onPath = exe(path.join(home, 'path', 'gemini'));
  const manual = exe(path.join(home, 'mine', 'gemini'));
  fake.childPath = path.dirname(onPath);
  fake.loginPath = path.dirname(onPath);
  assert.deepEqual(ut.resolveTool(['gemini'], { manual }), { path: manual, source: 'manual', offPath: true, terminal: onPath });
  assert.deepEqual(ut.resolveTool(['gemini'], { manual: path.join(home, 'gone') }), {
    path: onPath,
    source: 'path',
    offPath: false,
    terminal: onPath,
  });
  fake.childPath = '';
  // not the default Node's, but installed under another one a terminal would not run: found, and said so
  assert.deepEqual(ut.resolveTool(['gemini']), { path: v18, source: 'known', offPath: true, terminal: onPath });
  fs.rmSync(v18);
  assert.equal(ut.resolveTool(['gemini'], { extra: [own] })?.path, own);
  assert.equal(ut.resolveTool(['gemini'], { extra: [own], exists: () => false }), null);
  assert.ok(ut.searchDirs().includes(path.join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin')));
  fake.loginPath = null;
});

test('toolCandidates: PATH first, every user-tool folder whether or not it exists yet, then extra; no repeats', (t) => {
  const home = withHome(t);
  const onPath = exe(path.join(home, '.local', 'bin', 'claude'));
  fake.childPath = path.dirname(onPath);
  const list = ut.toolCandidates(['claude'], ['/Applications/X.app/claude', onPath]);
  assert.equal(list[0], onPath);
  assert.equal(list.filter((p: string) => p === onPath).length, 1);
  assert.ok(list.includes(path.join(home, '.bun', 'bin', 'claude')), 'a folder that is not there yet');
  assert.ok(list.includes(path.join(home, '.npm-global', 'bin', 'claude')));
  assert.equal(list.at(-1), '/Applications/X.app/claude');
  fake.childPath = '';
  assert.ok(!ut.toolCandidates(['claude']).includes(null));
});

test('forgetTool looks at the folders and the binary again; the API re-exports the version readers', () => {
  assert.equal(typeof ut.toolVersion, 'function');
  assert.equal(typeof ut.fileVersion, 'function');
  assert.equal(typeof ut.forgetVersion, 'function');
  ut.forgetTool('/x/codex');
  ut.forgetTool();
});

test('highest-version discovery checks more than one Windows PATH directory and uses PATHEXT', (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalPath = process.env.PATH;
  const originalExtensions = process.env.PATHEXT;
  t.after(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    process.env.PATH = originalPath;
    if (originalExtensions === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = originalExtensions;
  });
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
  process.env.PATH = 'C:\\first;D:\\later';
  process.env.PATHEXT = '.EXE;.CMD';
  const copies = ut.toolCandidates(['goose'], ['C:\\extra\\goose.exe'], true);
  assert.deepEqual(copies.slice(-5), [
    'C:\\first\\goose.exe',
    'C:\\first\\goose.cmd',
    'D:\\later\\goose.exe',
    'D:\\later\\goose.cmd',
    'C:\\extra\\goose.exe',
  ]);
});

test('version comparison re-reads an executable replaced during a scan and drops one that changes again', async (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const other = exe(path.join(dir, 'other'));
  for (const again of [false, true]) {
    const bin = exe(path.join(dir, `versioned-${again}`));
    const original = deferred<string>();
    const retryStarted = deferred<void>();
    const retry = deferred<string>();
    let calls = 0;
    const finding = ut.versionedToolCopies([bin, other], (p: string) => {
      if (p === other) return Promise.resolve('3.0.0');
      if (++calls === 1) return original.promise;
      retryStarted.resolve();
      return retry.promise;
    });
    fs.appendFileSync(bin, '# replacement\n');
    original.resolve('4.0.0');
    await retryStarted.promise;
    if (again) fs.appendFileSync(bin, '# changed again\n');
    retry.resolve('2.0.0');
    const copies = await finding;
    assert.deepEqual(copies, [...(again ? [] : [{ path: bin, version: '2.0.0' }]), { path: other, version: '3.0.0' }]);
    assert.equal(calls, 2);
  }
});
