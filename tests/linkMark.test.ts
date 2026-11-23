// The mark next to a link (src/lib/format.ts linkMark): drawn locally from the host name, no request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkMark } from '../src/lib/format.ts';

test('http and https links get the first letter of the host, without www', () => {
  assert.equal(linkMark('https://www.example.com/a?b=1')?.letter, 'E');
  assert.equal(linkMark('http://docs.rs')?.letter, 'D');
  assert.equal(linkMark('https://3dprint.example')?.letter, '3');
});

test('the colour depends on the host only, and is a hue', () => {
  const a = linkMark('https://example.com/x')!;
  assert.deepEqual(a, linkMark('https://www.example.com/y'));
  assert.ok(a.hue >= 0 && a.hue < 360);
  assert.notEqual(a.hue, linkMark('https://other.dev')!.hue);
});

test('other schemes and junk get nothing', () => {
  for (const h of ['mailto:a@b.c', 'file:///tmp/x', 'src/foo.ts', '', '#anchor']) assert.equal(linkMark(h), null, h);
});
