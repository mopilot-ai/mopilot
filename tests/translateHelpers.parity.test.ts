// The item helpers ACP translation needs that also stay in JS (the window's approval cards, main's reading of a stop): the
// Rust core has its own copies (core/crates/translate), and both sides answer tests/fixtures/core/translate/helpers/, so a
// change to one alone fails here or in the crate's parity test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { blockText, toolItem, toolOutput } from '../shared/acpItems/toolItems.mjs';
import { editChanges, patchChanges, replaceDiff } from '../shared/acpItems/editChanges.mjs';
import { acpStop, isLimitError } from '../shared/acpStop.mjs';
import { compactionItem, COMPACT_COMMAND } from '../shared/compaction.mjs';
import { contentBlocks, normalizeContentBlock } from '../shared/contentBlocks.mjs';
import { prefixUnits } from '../shared/textPrefix.mjs';

const HELPERS: Record<string, (...args: any[]) => unknown> = {
  acpStop,
  blockText,
  compactCommand: (text: string) => COMPACT_COMMAND.test(text),
  compactionItem,
  contentBlocks,
  editChanges: (tc: unknown) => editChanges(tc),
  isLimitError,
  normalizeContentBlock,
  patchChanges,
  prefixUnits,
  replaceDiff,
  toolItem,
  toolOutput,
};

/**
 * Helpers whose JS side is gone, which the fixture still holds the core to: `parentOf` is the stream batcher's key and the
 * translator's, both in Rust (core/crates/batcher, core/crates/translate).
 */
const RUST_ONLY = new Set(['parentOf']);

const folder = new URL('./fixtures/core/translate/helpers/', import.meta.url);
const cases = readdirSync(folder)
  .sort()
  .flatMap((part) => JSON.parse(readFileSync(new URL(part, folder), 'utf8')))
  .filter((c: { fn: string }) => !RUST_ONLY.has(c.fn));

test('each helper left in JS answers as the fixture the Rust core holds to says', () => {
  assert.ok(cases.length > 1000);
  for (const { name, fn, args, result, thrown } of cases) {
    if (thrown) assert.throws(() => HELPERS[fn](...JSON.parse(args)), TypeError, name);
    else assert.equal(JSON.stringify(HELPERS[fn](...JSON.parse(args))), result, name);
  }
});

test('the fixture covers every helper on both sides', () => {
  assert.deepEqual([...new Set(cases.map((c: { fn: string }) => c.fn))].sort(), Object.keys(HELPERS).sort());
});
