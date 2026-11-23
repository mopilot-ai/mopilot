// Paced text on an engine without Intl.Segmenter (the phone's Hermes): steps still never split a surrogate pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphemeBoundaries, revealedPrefix } from '../src/lib/textPacer';

test('without a segmenter, boundaries fall on code points, so an emoji is never cut in half', () => {
  const original = Intl.Segmenter;
  // the segmenter is made on first use: this file's first call sees an engine that has none
  Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true, writable: true });
  try {
    const text = 'a😀b';
    assert.deepEqual(graphemeBoundaries('k', text), [0, 1, 3]);
    assert.equal(revealedPrefix(text, 2, 'k'), 'a', 'half an emoji is not shown');
    assert.equal(revealedPrefix(text, 3, 'k'), 'a😀');
    // a reply that grows segments only what it appended, still on code points
    assert.deepEqual(graphemeBoundaries('k', `${text}😀c`), [0, 1, 3, 4, 6]);
  } finally {
    Object.defineProperty(Intl, 'Segmenter', { value: original, configurable: true, writable: true });
  }
});
