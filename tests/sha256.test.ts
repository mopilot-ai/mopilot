// shared/remote/sha256.mjs against node's own SHA-256: every padding edge, a long input, bytes and strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../shared/remote/sha256.mjs';

test('it agrees with node on every length around the padding edges, on bytes and on UTF-8 text', () => {
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 70_000]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 255);
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'), `length ${n}`);
  }
  for (const text of ['', 'abc', 'owner policy', '日本語の規則 ✓'])
    assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'));
});
