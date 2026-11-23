// scripts/host-bundle-check.mjs: the staged app folder must build the Host archive this checkout builds (a file the packager drops or changes is refused, a faithful copy returns the archive's checksum).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checkHostBundle } from '../scripts/host-bundle-check.mjs';
const { buildBundle } = createRequire(import.meta.url)('../electron/host/bundle.cjs');

const ROOT = path.join(import.meta.dirname, '..');
const FILES: Record<string, string> = {
  'host/package.json': JSON.stringify({ name: 'mopilot-host', version: '9.9.9' }),
  'host/bin/mopilot-host.mjs': "import './a.mjs';\nimport '../../package.json';\n",
  'package.json': JSON.stringify({ name: 'mopilot', version: '1.0.0' }),
  'host/bin/a.mjs': 'export const a = 1;\n',
};
const tmp = (t: any) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-check-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const tree = (root: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
};

test('a faithful copy builds the same archive, and its checksum is returned', (t) => {
  const source = tree(tmp(t), FILES);
  const app = tree(tmp(t), FILES);
  const sha256 = checkHostBundle(app, source);
  assert.equal(sha256, buildBundle({ root: source, outDir: path.join(tmp(t), 'out') }).sha256);
  assert.match(sha256, /^[0-9a-f]{64}$/);
});

test('a file the packager dropped is named, and so is one it left that the checkout does not reach', (t) => {
  const source = tree(tmp(t), FILES);
  const dropped = tree(tmp(t), FILES);
  fs.rmSync(path.join(dropped, 'host/bin/a.mjs'));
  assert.throws(() => checkHostBundle(dropped, source), /reads \.\/a\.mjs, which is not there/);
  // the app reaches a file the checkout does not (its entry imports more), and lacks one the checkout reaches
  const other = tree(tmp(t), {
    ...FILES,
    'host/bin/mopilot-host.mjs': "import './b.mjs';\nimport '../../package.json';\n",
    'host/bin/b.mjs': 'export {};\n',
  });
  assert.throws(() => checkHostBundle(other, source), /host\/bin\/a\.mjs is missing, host\/bin\/b\.mjs is extra/);
});

test('the root package.json, which the packager stamps and versions, may differ', (t) => {
  const source = tree(tmp(t), FILES);
  const app = tree(tmp(t), { ...FILES, 'package.json': JSON.stringify({ name: 'mopilot', version: '1.0.0', mopilotBuild: 'release' }) });
  const sha256 = checkHostBundle(app, source);
  assert.notEqual(
    sha256,
    buildBundle({ root: source, outDir: path.join(tmp(t), 'out') }).sha256,
    'the stamp is in the archive the app uploads',
  );
});

test('a file with other bytes is named', (t) => {
  const source = tree(tmp(t), FILES);
  const app = tree(tmp(t), { ...FILES, 'host/bin/a.mjs': 'export const a = 2;\n' });
  assert.throws(() => checkHostBundle(app, source), /host\/bin\/a\.mjs differs/);
});

test('this checkout checked against itself builds its archive', () => {
  assert.match(checkHostBundle(ROOT), /^[0-9a-f]{64}$/);
});
