// electron/platform/timingSafe.cjs: the one constant-time text comparison (Computer Access pairing, the Chrome
// extension's proof, MoMo's audit log MACs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { sameText } = createRequire(import.meta.url)('../electron/platform/timingSafe.cjs');

test('only the same string matches; other lengths and non-strings are false, never a throw', () => {
  assert.equal(sameText('abc', 'abc'), true);
  assert.equal(sameText('abc', 'abd'), false);
  assert.equal(sameText('ab', 'abc'), false);
  assert.equal(sameText(1, '1'), false);
  assert.equal(sameText(undefined, ''), false);
});
