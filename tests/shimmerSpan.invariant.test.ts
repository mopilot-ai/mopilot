// A shimmering label is drawn by ShimmerSpan (src/components/ui/ShimmerBand.tsx), which keys the element by its words: a
// label whose words change in place keeps the old words' glyph mask (mask-clip: text) and smears the new ones (#4654).
// No other component puts the shimmer classes or the band on an element of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const GUARDS = ['src/'];

const root = new URL('..', import.meta.url).pathname;
const OWNER = 'src/components/ui/ShimmerBand.tsx';

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );

/** The code without block comments that start a line and without line comments, so a mention in prose never counts. */
const code = (text: string) => text.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');

/** A shimmer class of any spelling in a className (a literal, a template, a conditional, clsx), the band, or its component. */
const HAND_ROLLED =
  /\bshimmer-(text|band)\b|<ShimmerBand\b|className=(?:"[^"]*|\{[^\n]*?)\bshimmer\b|classList\.(?:add|toggle)\([^)]*\bshimmer(?:-text)?\b/;

test('only ShimmerSpan puts a shimmer class or a band on an element', () => {
  const offenders = files(join(root, 'src'))
    .map((f) => relative(root, f))
    .filter((f) => f !== OWNER)
    .filter((f) => HAND_ROLLED.test(code(readFileSync(join(root, f), 'utf8'))));
  assert.deepEqual(offenders, [], 'draw a shimmering label with <ShimmerSpan> so its element is keyed by its words');
});

test('the guard finds each way of writing a shimmer class by hand', () => {
  for (const source of [
    '<span className="shimmer-text">a</span>',
    '<span className="step shimmer">a</span>',
    '<span className={`step ${x} shimmer`}>a</span>',
    "<span className={on ? 'shimmer' : ''}>a</span>",
    "<span className={clsx('a', 'shimmer')}>a</span>",
    "el.classList.add('shimmer')",
    '<ShimmerBand />',
  ])
    assert.ok(HAND_ROLLED.test(source), source);
  for (const source of [
    "const ux = 'shimmer';",
    '<ShimmerSpan shimmer="shimmer">a</ShimmerSpan>',
    '<span className="shimmering-note">a</span>',
  ])
    assert.equal(HAND_ROLLED.test(source), false, source);
});
