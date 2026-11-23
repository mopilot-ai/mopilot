// Main and renderer expose one version-order policy, including prerelease ordering and equivalent version spellings.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { compareVersions as rendererCompare } from '../src/harness/compat.ts';

const { compareVersions: mainCompare } = createRequire(import.meta.url)('../electron/harness/versions.cjs');

test('main and renderer expose the same version-order implementation', () => {
  assert.equal(mainCompare, rendererCompare);
});

test('version policy orders major, minor, patch and prerelease components', () => {
  const groups = [
    ['', '0', '0.0.0'],
    ['1.2.0-1'],
    ['1.2.0-alpha'],
    ['1.2.0-alpha.1'],
    ['1.2.0-alpha.2'],
    ['1.2.0-alpha.10'],
    ['1.2.0-beta'],
    ['1.2', '1.2.0', 'v1.2.0', '  v1.2.0  '],
    ['1.2.1'],
    ['1.3.0'],
    ['2.0.0'],
  ];
  for (const [left, a] of groups.entries())
    for (const [right, b] of groups.entries())
      for (const x of a)
        for (const y of b) {
          const expected = Math.sign(left - right);
          assert.equal(mainCompare(x, y), expected, `${x} vs ${y}`);
          assert.equal(rendererCompare(x, y), expected, `${x} vs ${y}`);
        }
});
