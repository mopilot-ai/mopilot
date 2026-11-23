// Which strings may name a Tart VM or an image to clone (shared/vmName.mjs): a plain name or a plain image reference, never a path out of the VM directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM with a declaration file
import { assertImageRef, assertVmName, isImageRef, isVmName } from '../shared/vmName.mjs';

test('plain VM names pass, anything else does not', () => {
  for (const ok of ['a', 'mopilot-sbx-0123456789ab', 'mopilot-g8.v2', 'A_b-c.d', 'x'.repeat(64)]) assert.equal(isVmName(ok), true, ok);
  for (const bad of ['', '-x', '.x', '_x', 'a/b', '../x', 'a..b', 'a b', 'x'.repeat(65), 'é', 'a\nb'])
    assert.equal(isVmName(bad), false, JSON.stringify(bad));
  for (const bad of [1, null, undefined, {}, ['a']]) assert.equal(isVmName(bad), false);
  assert.equal(assertVmName('ok-1'), 'ok-1');
  assert.throws(() => assertVmName('x/../y'), /not a valid VM name/);
});

test('image references: registry, path, tag or digest; no empty or dot-dot parts', () => {
  const digest = 'sha256:' + 'a'.repeat(64);
  for (const ok of [
    'golden',
    'ghcr.io/org/img',
    'ghcr.io/org/img:latest',
    `ghcr.io/org/img@${digest}`,
    'localhost:5000/img:v1.2',
    'r.io/a/b/c:tag',
  ])
    assert.equal(isImageRef(ok), true, ok);
  for (const bad of [
    '',
    '/x',
    'ghcr.io/',
    'ghcr.io//img',
    'ghcr.io/../img',
    'a/b/../c',
    'ghcr.io/org/img:',
    'ghcr.io/org/img:a:b',
    'ghcr.io/org/img@nodigest',
    `ghcr.io/org/img:tag@${digest}`,
    '-x/y',
    'x/-y',
    'r.io:99999999/img',
    'a b/c',
    `x/${'y'.repeat(260)}`,
  ])
    assert.equal(isImageRef(bad), false, bad);
  assert.equal(isImageRef(7), false);
  assert.equal(assertImageRef('ghcr.io/org/img:latest'), 'ghcr.io/org/img:latest');
  assert.throws(() => assertImageRef('ghcr.io/../x'), /not a valid image reference/);
});
