// What the native release check copies: generated folders stay out, a module's own native sources and the phone's imports from outside mobile/ stay in.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copiesIntoScratch, phoneImportsOutsideMobile } from '../design/mobile-remote/spike/expo/projectCopy.mjs';

const root = path.join('/repo', 'mobile');
const at = (...parts: string[]) => path.join(root, ...parts);

test('the root folder itself is copied', () => {
  assert.equal(copiesIntoScratch(root, root), true);
});

test('generated folders at the root stay out', () => {
  for (const name of ['ios', 'android', 'dist']) {
    assert.equal(copiesIntoScratch(root, at(name)), false, name);
    assert.equal(copiesIntoScratch(root, at(name, 'Podfile')), false, name);
  }
});

test('node_modules stays out at any depth', () => {
  assert.equal(copiesIntoScratch(root, at('node_modules')), false);
  assert.equal(copiesIntoScratch(root, at('modules', 'x', 'node_modules', 'y.js')), false);
});

test("a local module's native sources are copied", () => {
  assert.equal(copiesIntoScratch(root, at('modules', 'mopilot-live-activity', 'ios')), true);
  assert.equal(copiesIntoScratch(root, at('modules', 'mopilot-live-activity', 'ios', 'ActivityState.swift')), true);
  assert.equal(copiesIntoScratch(root, at('modules', 'mopilot-live-activity', 'android', 'build.gradle')), true);
});

test('every native folder under mobile/modules in this repository is copied', () => {
  const modules = path.resolve(import.meta.dirname, '../mobile/modules');
  const repoMobile = path.dirname(modules);
  let checked = 0;
  for (const name of readdirSync(modules)) {
    for (const native of ['ios', 'android']) {
      const folder = path.join(modules, name, native);
      if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) continue;
      assert.equal(copiesIntoScratch(repoMobile, folder), true, folder);
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'expected a module with native sources');
});

const repoRoot = path.resolve(import.meta.dirname, '..');

function fakeRepo(files: Record<string, string>) {
  const repo = mkdtempSync(path.join(tmpdir(), 'phone-copy-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  }
  return repo;
}

test('imports leaving mobile/ are followed transitively, and each file is listed once', () => {
  const repo = fakeRepo({
    'mobile/src/a.ts': "import { x } from '../../electron/x.cjs';\nimport { y } from '../../src/lib/y';\nimport { z } from './z';",
    'mobile/src/z.ts': "export const z = require('../../electron/x.cjs');",
    'electron/x.cjs': "const n = require('../shared/n.mjs');",
    'shared/n.mjs': 'export const n = 1;',
    'src/lib/y.ts': "export { w } from './w/index';",
    'src/lib/w/index.tsx': 'export const w = 1;',
  });
  assert.deepEqual(phoneImportsOutsideMobile(repo), ['electron/x.cjs', 'shared/n.mjs', 'src/lib/w/index.tsx', 'src/lib/y.ts']);
  rmSync(repo, { recursive: true });
});

test('a folder import resolves to its index, and a data file is copied without being read as code', () => {
  const repo = fakeRepo({
    'mobile/a.ts': "import '../lib/folder';\nimport data from '../lib/data.json';",
    'lib/folder/index.ts': "import './inner';",
    'lib/folder/inner.ts': '',
    'lib/data.json': '{"text": "from \'./ignored\'"}',
  });
  assert.deepEqual(phoneImportsOutsideMobile(repo), ['lib/data.json', 'lib/folder/index.ts', 'lib/folder/inner.ts']);
  rmSync(repo, { recursive: true });
});

test('an import that names no file, generated folders and non-source files are left out', () => {
  const repo = fakeRepo({
    'mobile/a.ts': "import '../missing';\nimport './b.png';",
    'mobile/b.png': "from '../hidden'",
    'mobile/ios/generated.ts': "import '../../hidden';",
    'mobile/node_modules/p/i.js': "require('../../../hidden');",
    'hidden.ts': '',
  });
  assert.deepEqual(phoneImportsOutsideMobile(repo), []);
  rmSync(repo, { recursive: true });
});

test("this repository's phone imports reach the files the bundle needs", () => {
  const files = phoneImportsOutsideMobile(repoRoot);
  for (const file of [
    'electron/capabilities/browser/chromePanelToolLines.cjs',
    'electron/chrome-extension/src/panelPreview.mjs',
    'shared/ownToolLines.mjs',
    'src/lib/composerSkills.ts',
    'src/lib/streamCut.ts',
    'src/lib/textPacer.ts',
  ]) {
    assert.ok(files.includes(file), file);
  }
});
