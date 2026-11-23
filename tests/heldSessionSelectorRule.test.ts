// The held-session-selector lint guard (lint/rules/held-session-selector.grit): an app-store selector that reads the
// session through sessionOf (directly or through the composer's family) warns; a session hook, or sessionOf outside a
// selector, does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('an app-store selector reading the held session warns; session hooks and reads outside a render do not', () => {
  for (const [input, expected] of [
    ['export const a = (id: string) => useStore((s) => composerFirstTier(id, s));', 1],
    ['export const a = (id: string) => useStore((s) => composerFamily(id, s) === "claude");', 1],
    ['export const a = (id: string) => useStore((s) => (id ? sessionOf(id).pendingSwitch : s.x));', 1],
    ['export const a = (id: string) => useStore(() => isClaudeComposer(id));', 1],
    ['export const a = (id: string) => useStore((s) => pinnedModel(h, id, s, heldSwitch(id)));', 1],
    ['export const a = (id: string) => useStore((s) => pinnedModel(h, id, s, pending));', 0],
    ['export const a = (id: string) => useComposerFirstTier(id);', 0],
    ['export const a = (id: string) => useStore((s) => s.segments[id]);', 0],
    ['export const a = (id: string) => composerFamily(id) === "claude";', 0],
  ] as const) {
    const report = lintFixtures({ 'src/held.ts': input });
    const hits = report.diagnostics.filter((d) => d.message.includes('[held-session-selector]'));
    assert.equal(hits.length, expected, input);
  }
});
