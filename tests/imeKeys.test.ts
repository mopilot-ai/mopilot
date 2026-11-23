// Enter and Escape while an input method is composing (Japanese, Chinese…) are the input method's: Enter confirms a
// candidate and Escape cancels it. Every handler that acts on either key checks `imeComposing` (src/lib/focus.ts) or a
// helper built on it first, or is listed here with why its keys can never come from a composition. Claude Desktop
// guards both keys the same way (`isComposing || keyCode === 229`) in 48 modules of 2.42304.2's ion-dist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';
import { stripComments } from './support/source-strings.ts';
import { imeComposing, isEnter, cancelOnEscape, listKey, onActivate } from '../src/lib/focus.ts';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const KEY = /\bkey\s*[!=]==\s*['"](?:Enter|Escape)['"]/;
// a guard in the same handler: the shared helpers, or the raw checks where a script runs in a page and imports nothing
const GUARD =
  /\bimeComposing\(|\bisEnter\(|\bcancelOnEscape\(|\blistKey\(|\bonActivate\(|isComposing|keyCode\s*[!=]==\s*229|\bisTypingTarget\(/;
const BEFORE = 15;

/** Where a file compares a key with Enter or Escape and no guard precedes it, and why that is safe. */
const SAFE: Record<string, { lines: number; why: string }> = {
  'src/components/composer/ComposerPopups.tsx': { lines: 1, why: "the composer's own key, forwarded after its imeComposing check" },
  'src/components/composer/useComposerStop.ts': {
    lines: 3,
    why: "called only from the composer's onKeyDown, after its imeComposing check",
  },
  'src/components/thread/approvalLogic.ts': {
    lines: 4,
    why: 'every caller returns on isTypingTarget first; endsHold reads keyup, which ends a hold',
  },
  'electron/capabilities/browser/iabBackend/policy.cjs': { lines: 1, why: "the agent's CDP key events, not a person's input method" },
  'shared/shortcutKeys.mjs': { lines: 1, why: 'reads a stored shortcut string, not a key event' },
};

function unguarded(text: string): number {
  const lines = stripComments(text).split('\n');
  return lines.filter((line, i) => KEY.test(line) && !GUARD.test(lines.slice(Math.max(0, i - BEFORE), i + 1).join('\n'))).length;
}

const FILES = ['src', 'electron', 'shared'].flatMap((root) => treeFiles(root, /\.(tsx?|cjs|mjs)$/)).filter((f) => !f.endsWith('.d.ts'));

test('every Enter and Escape handler leaves an input method its keys', () => {
  const found: Record<string, number> = {};
  for (const file of FILES) {
    const n = unguarded(fs.readFileSync(file, 'utf8'));
    if (n) found[file] = n;
  }
  const listed = Object.fromEntries(Object.entries(SAFE).map(([f, { lines }]) => [f, lines]));
  assert.deepEqual(found, listed, 'guard the key with imeComposing (src/lib/focus.ts), or list the file in SAFE with why');
});

test('the scan sees a handler with no guard and accepts one with a guard', () => {
  assert.equal(unguarded("const h = (e) => e.key === 'Escape' && onClose();"), 1);
  assert.equal(unguarded("const h = (e) => e.key === 'Escape' && !imeComposing(e) && onClose();"), 0);
  assert.equal(unguarded("if (imeComposing(e)) return;\nif (e.key !== 'Enter') return;"), 0);
  assert.equal(unguarded("// e.key === 'Enter' in a comment\nconst k = 'Enter';"), 0);
});

test('imeComposing: the composition flag on the event or its native event, or the IME key code', () => {
  assert.equal(imeComposing({ key: 'Escape', isComposing: true }), true);
  assert.equal(imeComposing({ key: 'Escape', nativeEvent: { isComposing: true } }), true);
  assert.equal(imeComposing({ key: 'Enter', keyCode: 229 }), true);
  assert.equal(imeComposing({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false }, isComposing: true }), false);
  assert.equal(imeComposing({ key: 'Escape', keyCode: 27 }), false);
});

test('the helpers built on it leave composing keys alone', () => {
  let cancelled = 0;
  const ev = (key: string, extra = {}) => ({ key, preventDefault() {}, ...extra });
  assert.equal(isEnter(ev('Enter', { keyCode: 229 })), false);
  assert.equal(
    cancelOnEscape(ev('Escape', { keyCode: 229 }), () => cancelled++),
    false,
  );
  assert.equal(
    cancelOnEscape(ev('Escape'), () => cancelled++),
    true,
  );
  assert.equal(cancelled, 1);
  assert.equal(listKey(ev('Enter', { isComposing: true })), null);
  let ran = 0;
  const target = {};
  onActivate(() => ran++)({ ...ev(' ', { keyCode: 229 }), target, currentTarget: target });
  onActivate(() => ran++)({ ...ev(' '), target, currentTarget: target });
  assert.equal(ran, 1);
});
