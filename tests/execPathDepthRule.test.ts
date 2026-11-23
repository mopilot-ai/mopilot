// The exec-path-depth lint guard (lint/rules/exec-path-depth.grit): a path counted with `..` from process.execPath warns;
// one found by name, one counted from __dirname and one that only names the executable do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('[exec-path-depth] a path counted with .. from process.execPath warns; other paths stay valid', () => {
  for (const [input, expected] of [
    // the updater's bundle path, after a file move rewrote '../..' as if it were module-relative
    ["const bundle = path.resolve(path.dirname(process.execPath), '../../..');", 1],
    ["const bundle = path.resolve(path.dirname(process.execPath), '../..');", 1],
    ["const res = path.join(process.execPath, '..', '..', 'Resources');", 1],
    ["const app = resolve(dirname(process.execPath), '../../Frameworks');", 1],
    ['const app = path.join(process.execPath, `..`);', 1],
    // a module path, the bundle found by name, and the executable itself
    ["const root = path.join(__dirname, '../..');", 0],
    ['const bundle = appBundleOf(process.execPath);', 0],
    ["const dir = path.join(path.dirname(process.execPath), 'resources');", 0],
    ['spawn(process.execPath, [cli]);', 0],
  ] as const) {
    const report = lintFixtures({ 'electron/bundle.cjs': `${input}\n` });
    const hits = report.diagnostics.filter((d) => d.message.includes('[exec-path-depth]'));
    assert.equal(hits.length, expected, input);
  }
});
