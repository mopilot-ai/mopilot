// Every endless animation in the app's stylesheets moves only what the compositor animates by itself (transform,
// translate, scale, rotate, opacity). A loop over any other property (a background-position sweep) is repainted by
// the renderer's main thread every frame and stutters whenever that thread is busy, as the running chat's shimmering
// sidebar title did while its turn streamed (render-cost).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';

export const GUARDS = ['src/'];

const COMPOSITED = new Set(['transform', 'translate', 'scale', 'rotate', 'opacity', 'animation-timing-function']);
const ROOT = new URL('../src/', import.meta.url).pathname;

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : [],
  );
}

/** Each stylesheet's keyframes by name with the properties they animate, and every endless animation that names one. */
function scan() {
  const frames = new Map<string, Set<string>>();
  const loops: { file: string; selector: string; value: string }[] = [];
  for (const file of cssFiles(ROOT)) {
    const css = postcss.parse(readFileSync(file, 'utf8'));
    css.walkAtRules(/keyframes$/, (a) => {
      const props = frames.get(a.params) ?? new Set<string>();
      a.walkDecls((d) => void props.add(d.prop));
      frames.set(a.params, props);
    });
    css.walkDecls('animation', (d) => {
      if (/\binfinite\b/.test(d.value))
        loops.push({ file: file.slice(ROOT.length), selector: (d.parent as postcss.Rule).selector, value: d.value });
    });
  }
  return { frames, loops };
}

test('endless animations move only composited properties', () => {
  const { frames, loops } = scan();
  assert.ok(loops.length > 5, 'the scan finds the endless animations');
  const offenders = loops.flatMap(({ file, selector, value }) =>
    [...frames]
      .filter(([name]) => value.split(/[\s,]+/).includes(name))
      .flatMap(([name, props]) => [...props].filter((p) => !COMPOSITED.has(p)).map((p) => `${file} ${selector}: ${name} animates ${p}`)),
  );
  assert.deepEqual(offenders, []);
});

test('the shimmer sweeps that used to repaint are found and now translate', () => {
  const { frames, loops } = scan();
  for (const name of ['shimmer-band', 'shimmer-cadence', 'ctx-stripes']) {
    assert.ok(
      loops.some((l) => l.value.split(/[\s,]+/).includes(name)),
      `${name} loops`,
    );
    assert.deepEqual(
      [...frames.get(name)!].filter((p) => p !== 'animation-timing-function'),
      ['translate'],
    );
  }
});
