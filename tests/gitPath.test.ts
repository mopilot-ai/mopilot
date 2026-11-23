// Git filename encoding and decoding regressions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDiffHeaderPath, decodeGitPath, encodeGitPath } from '../src/lib/gitPath.ts';

test('unquoted and incomplete paths are preserved', () => {
  for (const path of ['a/plain name.txt', '', '"unclosed', 'not-open"']) assert.equal(decodeGitPath(path), path);
  assert.equal(decodeGitPath('""'), '');
  assert.equal(decodeGitPath('"你好.txt"'), '你好.txt');
});

test('patch filename encoding quotes spaces, escapes controls, and preserves Unicode', () => {
  assert.equal(encodeGitPath('a/plain.txt'), 'a/plain.txt');
  assert.equal(encodeGitPath('a/你好.txt'), 'a/你好.txt');
  assert.equal(encodeGitPath('a/space name.txt'), '"a/space name.txt"');
  assert.equal(encodeGitPath('a/tab\tline\n.txt'), String.raw`"a/tab\011line\012.txt"`);
  assert.equal(encodeGitPath('a/quote"slash\\.txt'), String.raw`"a/quote\"slash\\.txt"`);
  for (const path of ['space name', '你好\t.txt', '\x07\b\t\n\v\f\r\x7f', '"\\']) assert.equal(decodeGitPath(encodeGitPath(path)), path);
});

test('Git C escapes and octal UTF-8 bytes round-trip to actual filenames', () => {
  assert.equal(decodeGitPath(String.raw`"a/\344\275\240\345\245\275.txt"`), 'a/你好.txt');
  assert.equal(decodeGitPath(String.raw`"\a\b\t\n\v\f\r\"\\"`), '\x07\b\t\n\v\f\r"\\');
  assert.equal(decodeGitPath(String.raw`"prefix\040\344\275\240\tend"`), 'prefix 你\tend');
  assert.equal(decodeGitPath(String.raw`"unknown\q"`), String.raw`unknown\q`);
});

test('unified header timestamps are separated from quoted filenames and literal tabs', () => {
  assert.equal(decodeDiffHeaderPath('a/plain name.txt\t2026-10-12'), 'a/plain name.txt');
  assert.equal(decodeDiffHeaderPath('"a/tab\tname.txt"\t2026-10-12'), 'a/tab\tname.txt');
  assert.equal(decodeDiffHeaderPath('"a/tab\tname.txt"'), 'a/tab\tname.txt');
  assert.equal(decodeDiffHeaderPath('a/你好.txt'), 'a/你好.txt');
});
