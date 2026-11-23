// docs/THIRD-PARTY.md is generated from package-lock.json (scripts/gen-third-party.mjs, WP10-8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defined } from './support/defined.ts';

export const GUARDS = ['build/', 'docs/THIRD-PARTY.md', 'package-lock.json', 'package.json'];

const gen = await import('../scripts/gen-third-party.mjs');

test('the committed list is what the generator produces (run npm run third-party)', () => {
  assert.equal(fs.readFileSync(gen.OUT, 'utf8'), gen.build().text);
});

test('each added component is in the lockfile with the license its own license file says', () => {
  const { direct } = gen.build();
  assert.equal(direct.length, gen.DIRECT.length);
  for (const d of direct) assert.equal(d.lock, d.lockLicense, `${d.name}: the lockfile says ${d.lock}`);
  // playwright comes from the copy @playwright/mcp pins, not the test runner's
  assert.match(defined(direct.find((d: any) => d.name === 'playwright')).version, /^1\.64/);
});

test('nothing copyleft is pulled in at run time', () => {
  const { rest } = gen.build();
  assert.ok(rest.length > 20);
  for (const p of rest) assert.doesNotMatch(String(p.license ?? 'unknown'), /GPL|MPL|unknown/i, `${p.name} ${p.license}`);
});

test('the shipped notices file is what the generator produces (run npm run third-party)', () => {
  assert.equal(fs.readFileSync(gen.NOTICES_OUT, 'utf8'), gen.buildNotices());
});

test('the notices carry the full Apache-2.0 text and NOTICE of playwright, plus ripgrep and node-pty', () => {
  const text = gen.buildNotices({ featureNotices: [] });
  for (const name of ['@playwright/mcp', 'playwright', 'playwright-core']) assert.ok(text.includes(`### ${name} `), name);
  // one full Apache text per package, and the NOTICE of the two that have one
  assert.equal(text.split('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION').length - 1, 3);
  assert.equal(text.split('#### NOTICE').length - 1, 2);
  assert.match(text, /derived from the Puppeteer project/);
  assert.match(text, /### @vscode\/ripgrep .*\(MIT\)/);
  assert.match(text, /### Unlicense/);
  assert.match(text, /Copyright \(c\) 2015 Andrew Gallant/);
  assert.match(text, /### node-pty \S+ \(MIT\)/);
  assert.match(text, /Christopher Jeffrey/);
});
