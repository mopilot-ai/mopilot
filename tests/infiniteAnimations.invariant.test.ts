// Every infinite CSS animation animates only properties the compositor runs (opacity, transform, translate, rotate, scale):
// a looping animation of anything else repaints on the main thread for as long as it is on screen (#3151).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const STYLES = path.resolve(import.meta.dirname, '../src/styles');
const COMPOSITED = new Set(['opacity', 'transform', 'translate', 'rotate', 'scale']);
/** Keyframe names allowed to loop on a main-thread property, each with the reason. */
const ALLOWED: Record<string, string> = {};

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? cssFiles(p) : e.name.endsWith('.css') ? [p] : [];
  });
}

/** Properties each @keyframes block sets, with comments removed. */
function keyframeProps(css: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0 && i < css.length) (depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0), (i += 1);
    const body = css.slice(re.lastIndex, i - 1);
    const props = new Set<string>();
    for (const d of body.matchAll(/([\w-]+)\s*:/g)) props.add(d[1]);
    out.set(m[1], props);
  }
  return out;
}

/** Names of keyframes that an `infinite` animation declaration uses. */
function infiniteNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const d of css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    if (!/\binfinite\b/.test(d[1])) continue;
    for (const w of d[1].split(/[\s,]+/)) if (/^[a-z][\w-]*$/i.test(w) && w !== 'infinite') names.add(w);
  }
  return names;
}

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('infinite animations animate only compositor properties', () => {
  const files = cssFiles(STYLES).map((f) => strip(fs.readFileSync(f, 'utf8')));
  const frames = new Map<string, Set<string>>();
  for (const css of files) for (const [k, v] of keyframeProps(css)) frames.set(k, v);
  const bad: string[] = [];
  for (const css of files)
    for (const name of infiniteNames(css)) {
      const props = frames.get(name);
      if (!props || ALLOWED[name]) continue;
      const off = [...props].filter((p) => !COMPOSITED.has(p) && p !== 'animation-timing-function');
      if (off.length) bad.push(`${name}: ${off.join(', ')}`);
    }
  assert.deepEqual(
    [...new Set(bad)],
    [],
    'a looping animation of a main-thread property; animate transform/opacity, or allow it in ALLOWED with the reason',
  );
});

test('the scan understands keyframes and infinite declarations', () => {
  const css = strip(
    '/* c */ @keyframes a { 0%, 100% { opacity: 0 } 50% { width: 1px; } } .x { animation: a 1s infinite; } .y { animation: b 1s; }',
  );
  assert.deepEqual([...(keyframeProps(css).get('a') ?? [])], ['opacity', 'width']);
  assert.deepEqual([...infiniteNames(css)], ['a']);
  assert.deepEqual([...infiniteNames('.z{animation-name:q;animation-iteration-count:infinite}')], []);
});

test('the styles folder is scanned recursively and finds the known loops', () => {
  const files = cssFiles(STYLES);
  assert.ok(files.some((f) => f.endsWith('motion.css')));
  const names = new Set(files.flatMap((f) => [...infiniteNames(strip(fs.readFileSync(f, 'utf8')))]));
  for (const known of ['spin', 'shimmer-band', 'row-dot-pulse']) assert.ok(names.has(known), known);
});
