// A text field that a bare class strips of both border and fill is invisible in dark (--surface-border equals --surface-2
// there), as the Memory documents were (#2504). A bare-class rule that sets `border: 0|none` and a transparent background
// may belong to a control inside a bordered container (composer, search pill), but never to a `.text-input`,
// `.text-area` or `.settings-textarea` element, which has no container of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

const ROOT = path.join(import.meta.dirname, '..');
const FIELD = new Set(['text-input', 'text-area', 'settings-textarea']);

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

/** Classes whose bare rule removes the border and the fill. */
export function strippedClasses(css: string): Set<string> {
  const out = new Set<string>();
  postcss.parse(css).walkRules((r) => {
    const d: Record<string, string> = {};
    r.walkDecls((x) => void (d[x.prop] = x.value));
    const noBorder = /^(0|none)\b/.test(d.border ?? '');
    const noFill = /^(transparent|none)\b/.test(d.background ?? d['background-color'] ?? '');
    if (!noBorder || !noFill) return;
    for (const sel of r.selectors) {
      const m = /^\.([\w-]+)$/.exec(sel.trim());
      if (m) out.add(m[1]);
    }
  });
  return out;
}

/** The field elements in a TSX source whose class list also carries a stripped class. */
export function strippedFields(tsx: string, stripped: Set<string>): string[] {
  const hits: string[] = [];
  for (const m of tsx.matchAll(/className=["']([^"']+)["']/g)) {
    const classes = m[1].split(/\s+/);
    if (classes.some((c) => FIELD.has(c))) for (const c of classes) if (stripped.has(c)) hits.push(c);
  }
  return hits;
}

test('the detectors find a stripped field class and ignore a container-bordered control', () => {
  const stripped = strippedClasses(
    '.a { border: 0; background: transparent } .b { border: 1px solid red; background: none } .c .d { border: 0; background: none }',
  );
  assert.deepEqual([...stripped], ['a']);
  assert.deepEqual(strippedFields('<textarea className="text-area x a" />', stripped), ['a']);
  assert.deepEqual(strippedFields('<textarea className="composer a" />', stripped), []);
});

test('no .text-input, .text-area or .settings-textarea element also carries a class that strips its border and fill', () => {
  const stripped = new Set<string>();
  for (const f of walk(path.join(ROOT, 'src'), /\.css$/)) for (const c of strippedClasses(readFileSync(f, 'utf8'))) stripped.add(c);
  const offenders: string[] = [];
  for (const f of walk(path.join(ROOT, 'src'), /\.tsx$/)) {
    for (const c of strippedFields(readFileSync(f, 'utf8'), stripped)) offenders.push(`${path.relative(ROOT, f)}: ${c}`);
  }
  assert.deepEqual(offenders, []);
});
