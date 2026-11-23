// An input's Escape that cancels its edit handles the key, so the app's own Escape (closing the side pane) leaves it
// alone: cancelOnEscape (src/lib/focus.ts), the app's Escape skipping a handled key, and lint/rules/escape-leak.grit,
// which keeps every rename, search and address field in src on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelOnEscape } from '../src/lib/focus.ts';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';
import { assertRendererRuleAtZero } from './support/lint-rule-kit.ts';

const key = (k: string) => {
  const e = { key: k, defaultPrevented: false, preventDefault: () => (e.defaultPrevented = true) };
  return e;
};

test('cancelOnEscape cancels on Escape and handles the key; any other key is left alone', () => {
  const cancelled: string[] = [];
  const esc = key('Escape');
  assert.equal(
    cancelOnEscape(esc, () => cancelled.push('esc')),
    true,
  );
  assert.equal(esc.defaultPrevented, true);
  const other = key('a');
  assert.equal(
    cancelOnEscape(other, () => cancelled.push('a')),
    false,
  );
  assert.equal(other.defaultPrevented, false);
  // Escape that ends an input method's composition, or with a modifier (a possible shortcut), is not the cancel
  for (const extra of [
    { nativeEvent: { isComposing: true } },
    { isComposing: true },
    { shiftKey: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
  ]) {
    const e = Object.assign(key('Escape'), extra);
    assert.equal(
      cancelOnEscape(e, () => cancelled.push('modified')),
      false,
      JSON.stringify(extra),
    );
    assert.equal(e.defaultPrevented, false);
  }
  assert.deepEqual(cancelled, ['esc']);
});

/** The [escape-leak] warnings Biome reports for `input`, written as a .tsx file under src. */
function hits(input: string): number {
  return lintFixtures({ 'src/components/Field.tsx': input }).diagnostics.filter((d) => d.message.includes('[escape-leak]')).length;
}

test("a field's Escape that cancels without handling the key warns; a handled one, or another element's, does not", () => {
  for (const [input, expected] of [
    ["export const A = () => <input onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }} />;", 1],
    ["export const B = () => <textarea onKeyDown={(e) => e.key === 'Escape' && close()} />;", 1],
    ["export const B2 = () => <textarea onKeyDown={(e) => e.key === 'Escape' && close()}>x</textarea>;", 1],
    ['export const C = () => <input onKeyDown={(e) => cancelOnEscape(e, () => setEditing(false))} />;', 0],
    ["export const D = () => <input onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }} />;", 0],
    ["export const E = () => <input onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') cancel(); }} />;", 0],
    ['export const F = () => <input onKeyDown={(e) => isEnter(e) && commit()} />;', 0],
    ['export const G = () => <div role="dialog" onKeyDown={(e) => e.key === \'Escape\' && close()} />;', 0],
  ] as const)
    assert.equal(hits(input), expected, input);
});

test('the rule covers the renderer and starts at zero', () => assertRendererRuleAtZero('./lint/rules/escape-leak.grit'));
