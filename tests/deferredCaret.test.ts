// lint/rules/deferred-caret.grit: a caret placed on the next frame (setSelectionRange inside requestAnimationFrame) warns as [deferred-caret]; a caret placed in the same step, or a frame that only focuses, does not (#1719).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

const warnings = (input: string) =>
  lintFixtures({ 'src/components/Caret.tsx': input }).diagnostics.filter((d) => d.message.includes('[deferred-caret]')).length;

test('a caret set inside requestAnimationFrame warns; one set in the same step, a focus-only frame or setCaretAfter does not', () => {
  for (const [input, expected] of [
    ['export const a = (ta) => requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(1, 1); });', 1],
    ['export const b = (ta) => requestAnimationFrame(() => ta.current?.setSelectionRange(0, 0));', 1],
    ['export const c = (ta) => { ta.setSelectionRange(1, 1); requestAnimationFrame(() => ta.focus()); };', 0],
    ['export const d = (ta) => requestAnimationFrame(() => ta.focus());', 0],
    ['export const e = (ta) => requestAnimationFrame(() => ta.setCaretAfter(ta.value, ta.value.length));', 0],
  ] as const)
    assert.equal(warnings(input), expected, input);
});
