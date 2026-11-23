// Git numstat filenames that collide with JavaScript object properties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { parseNumstatZ } = createRequire(import.meta.url)('../electron/platform/gitParse.cjs');

test('special object-key filenames remain enumerable data without changing the stats prototype', () => {
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
  const stats = parseNumstatZ(names.map((name) => `3\t1\t${name}\0`).join(''));
  for (const name of names) {
    assert.equal(Object.hasOwn(stats, name), true);
    assert.deepEqual(stats[name], { added: 3, removed: 1 });
  }
  assert.equal(Object.getPrototypeOf(stats), Object.prototype);
  assert.deepEqual(Object.keys(stats), names);
  assert.deepEqual(JSON.parse(JSON.stringify(stats)).__proto__, { added: 3, removed: 1 });
});

test('repeated records and no-index renamed paths retain special-key names', () => {
  const stats = parseNumstatZ('1\t0\t__proto__\0' + '2\t0\t\0/dev/null\0__proto__\0');
  assert.equal(Object.hasOwn(stats, '__proto__'), true);
  assert.deepEqual(stats.__proto__, { added: 2, removed: 0 });
});
