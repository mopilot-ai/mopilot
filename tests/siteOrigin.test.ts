// Browser origin normalization shared by settings and main-process writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteOrigin } from '../src/lib/browserSites.ts';

test('explicit non-web schemes are rejected instead of being interpreted as credentials', () => {
  assert.equal(siteOrigin('mailto:user@example.com'), null);
  assert.equal(siteOrigin('custom:user@example.com'), null);
  assert.equal(siteOrigin('ftp://example.com'), null);
});

test('HTTP URI forms and bare hosts with ports retain their intended origin', () => {
  for (const [input, expected] of [
    ['https:example.com/path', 'https://example.com'],
    ['http:example.com/path', 'http://example.com'],
    ['localhost:3000/path', 'https://localhost:3000'],
    ['example.com:8443/path', 'https://example.com:8443'],
    ['[::1]:8080/path', 'https://[::1]:8080'],
    [' example.com/path ', 'https://example.com'],
  ])
    assert.equal(siteOrigin(input), expected);
  assert.equal(siteOrigin(''), null);
  assert.equal(siteOrigin('http://'), null);
});
