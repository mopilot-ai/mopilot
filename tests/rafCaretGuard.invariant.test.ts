// A frame callback that moves a caret or selection first checks the user has not typed since it was scheduled: a late
// frame (an unpainted window) otherwise moves the caret under the user's typing (#3148).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';
import { stripComments } from './support/source-strings.ts';

export const GUARDS = ['src/'];

/** Calls that move a caret or a selection. */
const MOVES = /\b(?:setCaretAfter|setSelectionRange|placeCaret|selectAllChildren)\(|\.select\(\)/;

/**
 * The frame callbacks in `source` that move a caret or selection with no condition before the move: the text of each
 * `requestAnimationFrame(` call up to its closing parenthesis.
 */
export function unguardedFrames(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/requestAnimationFrame\(/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < source.length && depth > 0) {
      const ch = source[end++];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const body = source.slice(match.index, end);
    const move = body.search(MOVES);
    if (move < 0) continue;
    // a condition ahead of the move: an if, a return guard or a && / ? before it
    if (!/\bif\s*\(|&&|\?\s/.test(body.slice(0, move))) found.push(body.replace(/\s+/g, ' ').slice(0, 160));
  }
  return found;
}

test('the check finds a frame that moves the caret unconditionally and passes a guarded one', () => {
  assert.equal(unguardedFrames('requestAnimationFrame(() => e.target.select());').length, 1);
  assert.equal(unguardedFrames('requestAnimationFrame(() => { ta.focus(); ta.setCaretAfter(ta.value, ta.value.length); });').length, 1);
  assert.deepEqual(unguardedFrames('requestAnimationFrame(() => { if (edits.current === before) e.target.select(); });'), []);
  assert.deepEqual(unguardedFrames('requestAnimationFrame(() => { if (ta.value !== restored) return; ta.setCaretAfter(x, 1); });'), []);
  // a frame that only focuses moves no caret
  assert.deepEqual(unguardedFrames('requestAnimationFrame(() => input.current?.focus());'), []);
});

test('no frame callback in the app moves a caret or selection without checking first', () => {
  const hits = treeFiles('src', /\.tsx?$/).flatMap((f: string) =>
    unguardedFrames(stripComments(fs.readFileSync(f, 'utf8'))).map((body) => `${f}: ${body}`),
  );
  assert.deepEqual(hits, []);
});
