// Which windows hold an unsent draft (electron/app/unsent.cjs), as each reports it; a window's entry goes with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { report, anyUnsent } = require('../electron/app/unsent.cjs');
const sender = (id: number) => Object.assign(new EventEmitter(), { id });

test('a window with a draft holds the restart until it sends it, clears it, or closes', () => {
  const a = sender(1);
  const b = sender(2);
  assert.equal(anyUnsent(), false);
  report(a, true);
  report(a, true);
  assert.equal(a.listenerCount('destroyed'), 1, 'one listener per window');
  report(b, true);
  report(a, false);
  assert.equal(anyUnsent(), true, 'b still has one');
  b.emit('destroyed');
  assert.equal(anyUnsent(), false);
  report(a, 'yes');
  assert.equal(anyUnsent(), false, 'only true counts');
});
