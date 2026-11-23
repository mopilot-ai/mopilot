// The archive-list-predicate lint guard (lint/rules/archive-list-predicate.grit, #3403): an app-store selector asking
// whether a chat is archived of the lazily loaded Settings archive list warns; the chat's archive mark, and list upkeep
// outside a selector, do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('a selector reading the archive list as "is archived" warns; the archive mark and list upkeep do not', () => {
  for (const [input, expected] of [
    ['export const a = (id: string) => useStore((s) => s.archived.some((t) => t.id === id));', 1],
    ['export const a = (id: string) => useStore((s) => !!s.archived.find((t) => t.id === id));', 1],
    ['export const a = (id: string) => useStore((s) => s.archived.findIndex((t) => t.id === id) >= 0);', 1],
    ['export const a = (id: string) => useStore((s) => s.claudeArchived[id] != null);', 0],
    ['export const a = () => useStore((s) => s.archived);', 0],
    ['export const a = (id: string) => get().archived.find((t) => t.id === id);', 0],
  ] as const) {
    const report = lintFixtures({ 'src/archived.ts': input });
    const hits = report.diagnostics.filter((d) => d.message.includes('[archive-list-predicate]'));
    assert.equal(hits.length, expected, input);
  }
});
