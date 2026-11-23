// A CLI's version without running it where its package says it, and otherwise one `--version` per binary
// (electron/platform/toolVersion.cjs): an answer kept 24 hours, a failure until the binary changes, a timeout not kept,
// concurrent asks sharing one run, and version-manager shims kept 10 minutes. child_process is faked; binaries are
// files in a fixture folder.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tick as flush } from './support/async-scenarios.ts';

type Answer = { err?: any; stdout?: string; stderr?: string; throws?: boolean; noChild?: boolean };
const runs: { file: string; args: string[]; opts: any; stdinEnded: boolean; answer: (a: Answer) => void }[] = [];
let auto: ((file: string) => Answer) | null = null;
mock.module('node:child_process', {
  exports: {
    execFile(file: string, args: string[], opts: any, cb: (e: any, out: string, err: string) => void) {
      const run = { file, args, opts, stdinEnded: false, answer: (a: Answer) => cb(a.err ?? null, a.stdout ?? '', a.stderr ?? '') };
      const a = auto?.(file);
      if (a?.throws) throw new Error('spawn failed');
      runs.push(run);
      if (a) setImmediate(() => run.answer(a));
      if (a?.noChild) return undefined;
      return { stdin: { end: () => (run.stdinEnded = true) } };
    },
  },
});
const require = createRequire(import.meta.url);
const tv = require('../electron/platform/toolVersion.cjs');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'toolver-'));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });
  return file;
};
beforeEach(() => {
  runs.length = 0;
  auto = null;
  tv.forgetVersion();
});

test("an npm CLI's version is its package.json's, read through its link without running it", async () => {
  const root = dir();
  const pkg = path.join(root, 'lib', 'node_modules', '@openai', 'codex');
  write(path.join(pkg, 'package.json'), JSON.stringify({ version: '0.162.0' }));
  const js = write(path.join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n');
  const link = path.join(root, 'bin', 'codex');
  fs.mkdirSync(path.dirname(link));
  fs.symlinkSync(js, link);
  assert.equal(await tv.toolVersion(link), '0.162.0');
  assert.equal(tv.fileVersion(link), '0.162.0');
  const plain = path.join(root, 'lib', 'node_modules', 'cline');
  write(path.join(plain, 'package.json'), JSON.stringify({ version: ' 3.1.0 ' }));
  assert.equal(tv.fileVersion(write(path.join(plain, 'bin', 'cline'), '')), '3.1.0');
  assert.equal(runs.length, 0, 'nothing ran');
  // a package without a usable version is asked
  write(path.join(plain, 'package.json'), JSON.stringify({ version: 3 }));
  assert.equal(tv.fileVersion(path.join(plain, 'bin', 'cline')), null);
  write(path.join(plain, 'package.json'), '{');
  assert.equal(tv.fileVersion(path.join(plain, 'bin', 'cline')), null, 'malformed');
  assert.equal(tv.fileVersion(null), null);
  // a scope-like folder outside node_modules is no package
  assert.equal(tv.npmVersion(path.join(root, '@scope', 'tool', 'bin', 'tool')), null);
  assert.equal(tv.fileVersion(path.join(root, 'missing')), null);
});

test('a Windows npm shim names its package: the version comes from there', () => {
  const root = dir();
  write(path.join(root, 'node_modules', '@google', 'gemini-cli', 'package.json'), JSON.stringify({ version: '0.9.2' }));
  const cmd = write(path.join(root, 'gemini.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*\r\n');
  assert.equal(tv.fileVersion(cmd), '0.9.2');
  write(path.join(root, 'node_modules', 'qwen', 'package.json'), JSON.stringify({ version: '1.0.0' }));
  assert.equal(tv.shimVersion(write(path.join(root, 'qwen'), 'exec node "$basedir/node_modules/qwen/cli.js"')), '1.0.0');
  assert.equal(tv.shimVersion(write(path.join(root, 'plain'), '#!/bin/sh\necho hi\n')), null, 'no package named');
  assert.equal(tv.shimVersion(root), null, 'a folder');
  assert.equal(tv.shimVersion(write(path.join(root, 'big'), 'x'.repeat(65 * 1024))), null, 'too large to be a shim');
});

test('one --version per binary: stdin closed, NO_COLOR, the answer kept 24 hours, then asked again', async () => {
  const bin = write(path.join(dir(), 'claude'), 'v1');
  let now = 1000;
  const o = { env: { A: '1' }, now: () => now };
  const first = tv.toolVersion(bin, o);
  const second = tv.toolVersion(bin, o);
  await flush();
  assert.equal(runs.length, 1, 'two asks, one run');
  assert.deepEqual(runs[0].args, ['--version']);
  assert.equal(runs[0].stdinEnded, true);
  assert.equal(runs[0].opts.env.A, '1');
  assert.equal(runs[0].opts.env.NO_COLOR, '1');
  assert.equal(runs[0].opts.env.CLINE_NO_AUTO_UPDATE, '1');
  runs[0].answer({ stdout: '2.1.295 (Claude Code)\n' });
  assert.deepEqual(await Promise.all([first, second]), ['2.1.295', '2.1.295']);
  now += tv.SUCCESS_TTL_MS - 1;
  assert.equal(await tv.toolVersion(bin, o), '2.1.295');
  assert.equal(runs.length, 1, 'kept');
  now += 1;
  const again = tv.toolVersion(bin, o);
  await flush();
  assert.equal(runs.length, 2, 'asked again after 24 hours');
  runs[1].answer({ stdout: 'codex-cli 0.162.0-alpha.17.2' });
  assert.equal(await again, '0.162.0-alpha.17.2');
});

test('a binary that failed is never run again until it changes; a timeout is asked again', async () => {
  const bin = write(path.join(dir(), 'kimi'), 'v1');
  auto = () => ({ err: Object.assign(new Error('exit 1'), { code: 1 }), stdout: 'usage: kimi' });
  assert.equal(await tv.toolVersion(bin, { now: () => 0 }), null);
  assert.equal(await tv.toolVersion(bin, { now: () => 1e12 }), null);
  assert.equal(runs.length, 1, 'not run again, however long after');
  // the binary changes (an update in place): it is asked again
  write(bin, 'v2 is longer');
  auto = () => ({ err: Object.assign(new Error('exit 2'), { code: 2 }), stderr: 'kimi 1.4.0' });
  assert.equal(await tv.toolVersion(bin), '1.4.0', 'a version printed with a non-zero exit still counts');
  assert.equal(runs.length, 2);
  // a run cut off by its timeout is not kept
  write(bin, 'v3, longer still');
  auto = () => ({ err: Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) });
  assert.equal(await tv.toolVersion(bin, { timeoutMs: 5 }), null);
  assert.equal(runs.at(-1)!.opts.timeout, 5);
  assert.equal(runs.at(-1)!.opts.killSignal, 'SIGKILL');
  auto = () => ({ stdout: '1.5.0' });
  assert.equal(await tv.toolVersion(bin), '1.5.0', 'asked again after a timeout');
  assert.equal(runs.length, 4);
  // one that could not start (its interpreter missing) may start once that is fixed: not kept
  const other = write(path.join(path.dirname(bin), 'other'), 'x');
  auto = () => ({ err: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
  assert.equal(await tv.toolVersion(other), null);
  auto = () => ({ stdout: '2.0.0' });
  assert.equal(await tv.toolVersion(other), '2.0.0');
  // killed for printing too much is a failure of the binary itself: kept
  const loud = write(path.join(path.dirname(bin), 'loud'), 'x');
  auto = () => ({ err: Object.assign(new Error('maxBuffer'), { killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) });
  assert.equal(await tv.toolVersion(loud), null);
  assert.equal(await tv.toolVersion(loud), null);
  assert.equal(runs.length, 7);
});

test('a version manager shim is kept 10 minutes either way; a binary that cannot be looked at is asked each time', async () => {
  const root = dir();
  const shim = write(path.join(root, 'shims', 'goose'), '#!/bin/sh\nexec asdf exec goose "$@"\n');
  let now = 0;
  auto = () => ({ err: new Error('no version set') });
  assert.equal(await tv.toolVersion(shim, { now: () => now }), null);
  now = tv.SHIM_TTL_MS - 1;
  assert.equal(await tv.toolVersion(shim, { now: () => now }), null);
  assert.equal(runs.length, 1);
  now = tv.SHIM_TTL_MS;
  auto = () => ({ stdout: 'goose 1.2.0' });
  assert.equal(await tv.toolVersion(shim, { now: () => now }), '1.2.0', 'the tool behind it may have changed');
  assert.ok(tv.isShim('/x/bin/codex', '/x/.volta/bin/volta-shim'));
  assert.ok(tv.isShim('/x/bin/codex', '/x/mise.exe'));
  assert.ok(!tv.isShim('/x/bin/codex', '/x/bin/codex'));
  // stat fails (a fake path): no key to keep the answer under
  auto = () => ({ stdout: '9.9.9' });
  const gone = path.join(root, 'gone');
  assert.equal(await tv.toolVersion(gone), '9.9.9');
  assert.equal(await tv.toolVersion(gone), '9.9.9');
  assert.equal(runs.length, 4);
  assert.equal(tv.stampOf(gone), null);
});

test('forgetting a binary asks it again; an answer that lands after it was forgotten is not kept', async () => {
  const bin = write(path.join(dir(), 'codex'), 'x');
  auto = () => ({ stdout: '1.0.0' });
  assert.equal(await tv.toolVersion(bin), '1.0.0');
  tv.forgetVersion(bin);
  assert.equal(await tv.toolVersion(bin), '1.0.0');
  assert.equal(runs.length, 2);
  auto = null;
  const pending = tv.toolVersion(path.join(path.dirname(bin), 'codex'));
  assert.equal(runs.length, 2, 'kept');
  tv.forgetVersion(bin);
  const late = tv.toolVersion(bin);
  await flush();
  tv.forgetVersion(); // forgotten while out
  runs.at(-1)!.answer({ stdout: '2.0.0' });
  assert.equal(await late, '2.0.0');
  assert.equal(await pending, '1.0.0');
  auto = () => ({ stdout: '3.0.0' });
  assert.equal(await tv.toolVersion(bin), '3.0.0', 'the forgotten answer was not kept');
});

test('a run that cannot start is no version; output without a version is none; a missing child is tolerated', async () => {
  auto = () => ({ throws: true });
  assert.equal(await tv.toolVersion(write(path.join(dir(), 'a'), '1')), null);
  auto = () => ({ stdout: 'no digits here', noChild: true });
  assert.equal(await tv.toolVersion(write(path.join(dir(), 'b'), '1')), null);
  auto = () => ({ stdout: undefined as any, stderr: undefined as any });
  assert.equal(await tv.toolVersion(write(path.join(dir(), 'c'), '1'), { parse: () => null }), null);
  assert.equal(tv.parseVersion(undefined), null);
  assert.equal(tv.parseVersion('v1.2'), '1.2');
});
