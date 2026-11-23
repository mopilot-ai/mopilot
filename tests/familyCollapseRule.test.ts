// The family-collapse lint guard (lint/rules/family-collapse.grit): a chat's harness read as Codex or Claude Code,
// with a basic harness folded into Codex, warns; reading the family, or a guarded first-tier check, does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('collapsing a basic chat into Codex warns, while family reads and guarded checks stay valid', () => {
  for (const [input, expected] of [
    ['export const a = (id: string) => chatHarness(id);', 1],
    ['export const a = (id: string) => composerHarness(id, s);', 1],
    ['export const a = (id: string) => currentHarness(segs, id);', 1],
    ["export const a = (id: string) => ownerOf(id) === 'codex';", 1],
    ["export const a = (id: string) => ownerOf(id) !== 'codex';", 1],
    ["export const a = (kind: string) => (kind === 'claude' ? 'claude' : 'codex');", 1],
    ["export const a = (id: string) => !isAcpThread(id) && ownerOf(id) === 'codex';", 0],
    ["export const a = (id: string) => ownerOf(id) === 'claude';", 0],
    ["export const a = (id: string) => chatFamily(id) === 'codex';", 0],
    ['export const a = (id: string) => firstTierOf(composerFamily(id));', 0],
  ] as const) {
    const report = lintFixtures({ 'src/family.ts': input });
    const hits = report.diagnostics.filter((d) => d.message.includes('[family-collapse]'));
    assert.equal(hits.length, expected, input);
  }
});
