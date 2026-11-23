// electron/platform/winbin.cjs: candidates derived from USERPROFILE alone, a bare environment, the cmd.exe
// fallback without ComSpec, the real I/O, and killTree on each platform.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const execCalls: any[] = [];
let execErr: Error | null = null;
mock.module('node:child_process', {
  namedExports: { execFile: (cmd: string, args: string[], o: any, cb: Function) => (execCalls.push([cmd, args, o]), cb(execErr)) },
});
const require = createRequire(import.meta.url);
const { windowsCandidates, pathLookup, launchSpec, realIo, killTree } = require('../electron/platform/winbin.cjs');

test('candidates: AppData, Local and scoop folders come from USERPROFILE; a bare environment has none', () => {
  const list = windowsCandidates('codex', { USERPROFILE: 'C:\\Users\\bob' });
  assert.ok(list.includes('C:\\Users\\bob\\AppData\\Roaming\\npm\\codex.cmd'));
  assert.ok(list.includes('C:\\Users\\bob\\AppData\\Local\\Programs\\codex\\codex.exe'));
  assert.ok(list.includes('C:\\Users\\bob\\scoop\\shims\\codex.exe'));
  assert.deepEqual(windowsCandidates('codex', {}), []);
  assert.deepEqual(pathLookup('codex', {}), []);
});

test('a shim that cannot be read runs through cmd.exe when ComSpec is unset', () => {
  const io = { platform: 'win32', env: {}, readFile: () => null, exists: () => false };
  const s = launchSpec('C:\\x\\tool.cmd', ['a b'], {}, io);
  assert.equal(s.command, 'cmd.exe');
  assert.deepEqual(s.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(s.options.windowsVerbatimArguments, true);
  assert.equal(s.options.windowsHide, true);
});

test('realIo reads files (null when missing) and checks existence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winbin-'));
  const f = path.join(dir, 'a.cmd');
  fs.writeFileSync(f, 'shim');
  const io = realIo();
  assert.equal(io.platform, process.platform);
  assert.equal(io.readFile(f), 'shim');
  assert.equal(io.readFile(path.join(dir, 'missing')), null);
  assert.equal(io.exists(f), true);
  assert.equal(io.exists(path.join(dir, 'missing')), false);
});

test('killTree: nothing without a process; SIGTERM off Windows; on Windows the core ends the tree, and the process alone when it does not', async () => {
  killTree(null);
  const proc = (pid?: number) => {
    const p: any = { pid, kills: 0, kill: () => (p.kills++, true) };
    return p;
  };
  const real = process.platform;
  const setPlatform = (v: string) => Object.defineProperty(process, 'platform', { value: v, configurable: true });
  try {
    setPlatform('darwin');
    const a = proc(1);
    assert.equal(killTree(a), true);
    assert.equal(a.stopped, true);
    assert.equal(a.kills, 1);

    setPlatform('win32');
    const noPid = proc();
    killTree(noPid);
    assert.equal(noPid.kills, 1);
    assert.equal(execCalls.length, 0);

    // this run has no core, so nothing ended the tree
    const b = proc(42);
    killTree(b);
    assert.equal(b.kills, 0, 'asked of the core first');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(b.kills, 1);
    assert.equal(execCalls.length, 0, 'no process is started');
  } finally {
    setPlatform(real);
  }
});
