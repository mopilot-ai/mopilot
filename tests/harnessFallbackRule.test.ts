// The harness-fallback lint guard (lint/rules/harness-fallback.grit): the default harness's label shown as a feature's,
// or one harness named as the fallback for a missing label, warns; a chat's own label, or a neutral fallback, does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test("naming the default harness, or one harness as a fallback, warns; the chat's own label and neutral words do not", () => {
  for (const [input, expected] of [
    // the Code Review page before #1645
    ['export const a = (s: any) => HARNESS_LABEL[newChatHarness(s)];', 1],
    ['export const a = () => HARNESS_LABEL[defaultHarness().kind];', 1],
    ['export const a = (k: string) => REG[k]?.label ?? HARNESS_LABEL.codex;', 1],
    ['export const a = (k: string) => REG[k]?.label || HARNESS_LABEL.claude;', 1],
    ['export function md(label: (t: number) => string = () => HARNESS_LABEL.codex) { return label; }', 1],
    ["export const a = (v: any) => v.account ?? 'Claude subscription';", 1],
    ["export const a = (p: any) => p.reason || 'Codex is requesting additional permissions';", 1],
    ["export const a = (v: any) => v.name ?? 'OpenCode';", 1],
    ['export const a = (h: HarnessId) => HARNESS_LABEL[h];', 0],
    ['export const a = { codex: HARNESS_LABEL.codex, claude: HARNESS_LABEL.claude };', 0],
    ["export const a = (v: any) => v.label ?? 'Assistant';", 0],
    ["export const a = (v: any) => v.account ?? 'own subscription';", 0],
    ['export const a = (p: any, agent: string) => p.reason || `${agent} is requesting additional permissions`;', 0],
  ] as const) {
    const report = lintFixtures({ 'src/copy.ts': input });
    const hits = report.diagnostics.filter((d) => d.message.includes('[harness-fallback]'));
    assert.equal(hits.length, expected, input);
  }
});

test("one harness's own modules may name it as a fallback", () => {
  const input = "export const a = (e) => e.error || 'Codex failed to start';";
  for (const file of [
    'electron/platform/codexImport.cjs',
    'electron/harness/claude/usage.cjs',
    'src/components/harness/codex/x.ts',
    'src/harness/claude/x.ts',
  ]) {
    const report = lintFixtures({ [file]: input });
    assert.equal(report.diagnostics.filter((d) => d.message.includes('[harness-fallback]')).length, 0, file);
  }
  const shared = lintFixtures({ 'electron/app/x.cjs': input });
  assert.equal(shared.diagnostics.filter((d) => d.message.includes('[harness-fallback]')).length, 1);
});
