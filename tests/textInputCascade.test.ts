// A field's own class loses to the shared .text-input/.text-area rule (controls.css) when its one-class rule loads
// earlier: the same specificity, so the later rule wins. The approval card's note took .text-input's 100% width over
// its own calc(100% - 28px), and with its 14px margins ran past the card's edge. Every class written beside
// .text-input or .text-area must not set, in a one-class rule before controls.css, what the shared rule sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';

export const GUARDS = ['src/'];

const BASE = ['.text-input', '.text-area'];
const FIELD = /["'`]([^"'`]*\btext-(?:input|area)\b[^"'`]*)["'`]/g;

/** The classes written beside text-input or text-area in `source`, template holes left out. */
export function fieldClasses(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(FIELD))
    for (const c of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/))
      if (/^[\w-]+$/.test(c) && c !== 'text-input' && c !== 'text-area') out.add(c);
  return out;
}

/** "`.cls` sets prop before the shared rule" for each one-class rule the shared .text-input/.text-area rule overrides. */
export function overridden(css: string, classes: Set<string>): string[] {
  const rules: postcss.Rule[] = [];
  // top-level rules and those in an at-rule (@media, @supports), in cascade order; nested rules carry a parent class
  postcss.parse(css).walkRules((r) => void (r.parent?.type !== 'rule' && rules.push(r)));
  const base = rules.findIndex((r) => r.parent?.type === 'root' && BASE.every((s) => r.selectors.includes(s)));
  assert.ok(base >= 0, 'the shared .text-input, .text-area rule');
  const shared = new Set<string>();
  rules[base].walkDecls((d) => void shared.add(d.prop));
  const out: string[] = [];
  for (const r of rules.slice(0, base))
    for (const sel of r.selectors)
      if (/^\.[\w-]+$/.test(sel) && classes.has(sel.slice(1)))
        r.walkDecls((d) => void (shared.has(d.prop) && out.push(`${sel} sets ${d.prop} before the shared rule`)));
  return out;
}

const sources = (dir: URL): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(new URL(`${e.name}/`, dir)) : /\.tsx?$/.test(e.name) ? [readFileSync(new URL(e.name, dir), 'utf8')] : [],
  );

test('no class written beside .text-input or .text-area loses what it sets to the shared rule', () => {
  const classes = new Set(sources(new URL('../src/', import.meta.url)).flatMap((s) => [...fieldClasses(s)]));
  assert.ok(classes.has('approval-note'), 'the approval note is among the fields read');
  assert.deepEqual(overridden(appCss(), classes), []);
});

test('the check catches a one-class rule before the shared one, in an at-rule too, and leaves later or two-class rules alone', () => {
  assert.deepEqual(
    [...fieldClasses('<input className="text-input approval-note" /><i className={`text-area ${x} body`} />')],
    ['approval-note', 'body'],
  );
  const css = `.approval-note { margin: 0 14px; width: calc(100% - 28px); }
@media (max-width: 600px) { .body { font-size: 12px; } }
.text-input.body { width: 50%; }
.text-input, .text-area { width: 100%; height: 32px; font-size: 14px; }
.body { height: 40px; }`;
  assert.deepEqual(overridden(css, new Set(['approval-note', 'body'])), [
    '.approval-note sets width before the shared rule',
    '.body sets font-size before the shared rule',
  ]);
});
