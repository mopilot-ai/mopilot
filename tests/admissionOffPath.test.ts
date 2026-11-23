// Settings → Other harnesses for every ACP harness (electron/harness/admission.cjs entry): the version shown is the
// binary's that is there now (its probe's answer, else its npm package's, never a replaced binary's), and the row says
// when the user's terminal runs another file or none (offPath). Nothing is run; the binary is a fixture npm install.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Admission, binStamp } = require('../electron/harness/admission.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-offpath-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const pkg = path.join(dir, 'lib', 'node_modules', '@google', 'gemini-cli');
const pkgJson = path.join(pkg, 'package.json');
fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
fs.writeFileSync(pkgJson, JSON.stringify({ version: '0.9.0' }));
const BIN = path.join(pkg, 'bin', 'gemini.js');
fs.writeFileSync(BIN, '#!/usr/bin/env node\n');

function admission(pathStatus?: (id: string, bin: string) => { offPath: boolean; terminal: string | null }) {
  return new Admission({
    ids: ['gemini'],
    file: path.join(dir, `${Math.random()}.json`),
    quirks: () => ({ label: 'Gemini CLI', bins: ['gemini'] }),
    resolveBin: () => BIN,
    env: () => ({}),
    tools: {},
    dataDir: dir,
    pathStatus,
  });
}

test("a binary not checked yet, or changed since, shows its package's version, never the one it replaced", () => {
  const a = admission();
  assert.equal(a.list()[0].version, '0.9.0', 'never checked');
  a.cache.gemini = { state: 'admitted', reason: null, version: '0.8.0', stamp: 'the binary before its update', catalog: null };
  const h = a.list()[0];
  assert.equal(h.state, 'checking');
  assert.equal(h.version, '0.9.0', 'not the replaced binary’s 0.8.0');
  assert.equal(h.offPath, undefined, 'no pathStatus: nothing said');
  // checked and current: its own answer, else (an agent that sends no version) its package's
  a.cache.gemini = { state: 'admitted', reason: null, version: '0.9.1', stamp: binStamp(BIN), catalog: null };
  assert.equal(a.list()[0].version, '0.9.1');
  a.cache.gemini.version = null;
  assert.equal(a.list()[0].version, '0.9.0');
  // the package is read once per binary: a new Admission (or a changed binary) reads it again
  fs.writeFileSync(pkgJson, '{}');
  assert.equal(a.list()[0].version, '0.9.0', 'remembered for this binary');
  const b = admission();
  b.cache.gemini = { state: 'admitted', reason: null, version: null, stamp: binStamp(BIN), catalog: null };
  assert.equal(b.list()[0].version, null, 'neither says one');
  fs.writeFileSync(pkgJson, JSON.stringify({ version: '0.9.0' }));
});

test('the row says when the terminal runs another binary or none, on both the checking and the settled entry', () => {
  const seen: [string, string][] = [];
  const a = admission((id, bin) => (seen.push([id, bin]), { offPath: true, terminal: '/opt/homebrew/bin/gemini' }));
  assert.deepEqual([a.list()[0].offPath, a.list()[0].terminal, a.list()[0].state], [true, '/opt/homebrew/bin/gemini', 'checking']);
  a.cache.gemini = { state: 'signin', reason: null, version: '0.9.0', stamp: binStamp(BIN), catalog: null };
  assert.deepEqual([a.list()[0].offPath, a.list()[0].terminal, a.list()[0].state], [true, '/opt/homebrew/bin/gemini', 'signin']);
  assert.deepEqual(seen[0], ['gemini', BIN]);
  const same = admission(() => ({ offPath: false, terminal: BIN }));
  assert.equal('offPath' in same.list()[0], false, 'the terminal runs it: no fields');
});
