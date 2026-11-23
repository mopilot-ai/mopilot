import assert from 'node:assert/strict';

/** `v`, after asserting it is there: for a result the test needs before it can check anything else. */
export function defined<T>(v: T | null | undefined, what = 'a value'): T {
  assert.ok(v !== null && v !== undefined, `expected ${what}`);
  return v;
}
