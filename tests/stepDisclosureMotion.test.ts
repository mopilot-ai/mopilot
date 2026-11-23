// Step rows' disclosure motion (src/styles/app/thread-steps.css, motion.css, src/components/ui/Presence.tsx): the
// chevron points right when closed and turns down over .15s as the Codex app's disclosure chevron does, rows open
// over Codex's .3s cubic-bezier(.19,1,.22,1) and close in .15s ease-out as Claude Desktop's blocks leave (#1511), and
// closed content stays mounted until it has collapsed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { COLLAPSE_MS } from '../src/components/ui/Presence.tsx';

const css = postcss.parse(appCss());

/** Declarations of the top-level rules listing `selector`, later ones winning. */
function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  css.walkRules((r) => {
    if (r.selectors.includes(selector) && r.parent?.type === 'root')
      r.walkDecls((d) => void (out[d.prop] = d.value.replace(/\s+/g, ' ').trim()));
  });
  return out;
}
/** The longest duration in a transition list, in ms. */
const longest = (transition: string) => Math.max(...[...transition.matchAll(/(\d+)ms/g)].map((m) => +m[1]));

test('the step chevron points right when closed and turns down over .15s cubic-bezier(.4,0,.2,1) as the row opens', () => {
  const c = decls('.step-chevron');
  assert.equal(c.transform, 'rotate(-90deg)');
  assert.equal(c.transition, 'opacity var(--dur), transform 150ms cubic-bezier(0.4, 0, 0.2, 1)');
  for (const open of ['.step.open > .step-row .step-chevron', '.step-group.open > .step-row .step-chevron']) {
    assert.equal(decls(open).transform, 'none', open);
    assert.equal(decls(open).opacity, '1', open);
  }
});

test("a step's body opens over Codex's .3s, closes in .15s, and stays mounted until it has collapsed", () => {
  assert.equal(
    decls('.collapse.open').transition,
    'grid-template-rows var(--dur-sheet) var(--ease-enter), opacity var(--dur-sheet) var(--ease-enter)',
  );
  assert.match(readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'), /--dur-sheet: 300ms;/);
  assert.equal(decls('.collapse').transition, 'grid-template-rows 150ms ease-out, opacity 150ms ease-out');
  assert.ok(300 <= COLLAPSE_MS, 'the opening (--dur-sheet) ends before closed content would unmount');
  assert.match(
    readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'),
    /--ease-enter: cubic-bezier\(0\.19, 1, 0\.22, 1\);/,
  );
  // every Collapse transition, the sidebar lists' included, ends before the closed content unmounts
  for (const sel of ['.collapse', '.collapse.side-collapse', '.collapse.side-collapse > .collapse-inner > *'])
    assert.ok(longest(decls(sel).transition) <= COLLAPSE_MS, sel);
});

test('with reduced motion the chevron snaps and the rows open at once', () => {
  const off: Record<string, string> = {};
  css.walkAtRules('media', (m) => {
    if (!m.params.includes('prefers-reduced-motion: reduce')) return;
    m.walkRules((r) => r.walkDecls('transition', (d) => void r.selectors.forEach((s) => (off[s] = d.value))));
  });
  assert.equal(off['.step-chevron'], 'opacity var(--dur)');
  assert.equal(off['.collapse'], 'none');
});
