// The version-sort lint guard (lint/rules/version-sort.grit): text sorts of version folders and hand-rolled comparators
// that split a version on both "." and "-" warn; a comparator that splits on "." alone or keeps the prerelease apart does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('[version-sort] a text sort reversed, or a version split on "." and "-", warns; other splits stay valid', () => {
  for (const [input, expected] of [
    ['const newest = fs.readdirSync(dir).sort().reverse()[0];', 1],
    // the cmpVer that ranked 0.163.0-alpha.10.2 above 0.163.0
    ['const parts = (v) => String(v).split(/[.-]/).map((x) => parseInt(x) || 0);', 1],
    ['const parts = (v) => v.split(/[-.]/);', 1],
    ['const parts = (v) => v.split(/[\\.\\-]/g);', 1],
    // a dotted version, and a prerelease kept apart from its release
    ["const parts = (v) => v.split('.').map(Number);", 0],
    ['const [core, pre] = v.split(/-(.*)/s);', 0],
    ['const words = s.split(/[,;]/);', 0],
    ['const sorted = [...names].sort((a, b) => compareVersions(b, a));', 0],
  ] as const) {
    const report = lintFixtures({ 'electron/versions.cjs': `${input}\n` });
    const hits = report.diagnostics.filter((d) => d.message.includes('[version-sort]'));
    assert.equal(hits.length, expected, input);
  }
});
