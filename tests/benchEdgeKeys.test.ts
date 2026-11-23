// bench/lib/edge.mjs KEY_TARGET and strayKey: where a key the bench presses lands, read the way the driver reads it (#1658).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';

const { KEY_TARGET, strayKey } = await import('../bench/lib/edge.mjs');

test('KEY_TARGET names what has the keyboard, and strayKey is a key that reached nothing (#1658)', async () => {
  const read = () => window.eval(KEY_TARGET);
  document.body.innerHTML = '<div contenteditable="true" aria-label="Message"></div><button>Go</button>';
  assert.equal(read(), 'BODY');
  (document.body.firstElementChild as HTMLElement).focus();
  assert.equal(read(), 'DIV[Message]');
  (document.body.lastElementChild as HTMLElement).focus();
  assert.equal(read(), 'BUTTON');
  document.body.replaceChildren();
  assert.deepEqual(['BODY', '', null, undefined, 'DIV[Message]'].map(strayKey), [true, true, true, true, false]);
});
