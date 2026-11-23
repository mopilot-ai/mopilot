// The inherited-table-key lint guard rejects prototype-inclusive membership in named lookup tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('named table membership warns, while own-key and structural checks stay valid', () => {
  // Exercises lint/rules/inherited-table-key.grit through the production Biome configuration.
  for (const [input, expected] of [
    ['export const accepts = (key) => key in LOOKUP;', 1],
    ['export const accepts = (item) => item.kind in LOOKUP_TABLE;', 1],
    ['export const accepts = (key) => Object.hasOwn(LOOKUP, key);', 0],
    ['export const accepts = (item) => "field" in item;', 0],
  ] as const) {
    const report = lintFixtures({ 'shared/table.mjs': input });
    const hits = report.diagnostics.filter((d) => d.message.includes('[inherited-table-key]'));
    assert.equal(hits.length, expected, input);
  }
});
