// Motion tokens (#1511): the motion scale in src/styles/tokens.css has its values and says what each is for, and reduced motion ends every animation at once (the catch-all in src/styles/app/motion.css).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';

const tokensText = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

/** Each custom property declared in tokens.css with its value and the comment just above it. */
function declarations() {
  const out = new Map<string, { value: string; comment: string }>();
  postcss.parse(tokensText).walkDecls((d) => {
    if (!d.prop.startsWith('--')) return;
    const prev = d.prev();
    out.set(d.prop, { value: d.value, comment: prev?.type === 'comment' ? prev.text : '' });
  });
  return out;
}

const SCALE: Record<string, string> = {
  '--dur-fast': '60ms',
  '--dur-snap': '120ms',
  '--dur-base': '200ms',
  '--dur-sheet': '300ms',
  '--dur-slow': '450ms',
  '--reveal-hold': '500ms',
  '--ease-snap': 'cubic-bezier(0.32, 0.72, 0, 1)',
  '--ease-overshoot': 'cubic-bezier(0.34, 1.3, 0.64, 1)',
  '--ease-move': 'cubic-bezier(0.65, 0, 0.35, 1)',
};

test('the motion scale has its values, and each token says what it is for', () => {
  const decls = declarations();
  for (const [prop, value] of Object.entries(SCALE)) {
    assert.equal(decls.get(prop)?.value, value, prop);
    assert.match(decls.get(prop)?.comment ?? '', /\w{3,}/, `${prop} says what it is for`);
  }
  for (const spring of ['--spring-press', '--spring-snappy']) {
    const v = decls.get(spring)?.value ?? '';
    const stops = /^linear\((.*)\)$/.exec(v)?.[1].split(',').map(Number) ?? [];
    assert.ok(stops.length >= 10 && stops[0] === 0 && stops[stops.length - 1] === 1, `${spring} is a sampled spring from 0 to 1`);
    assert.match(decls.get(spring)?.comment ?? '', /\w{3,}/, `${spring} says what it is for`);
  }
  assert.ok(Math.max(...(decls.get('--spring-press')?.value.match(/[\d.]+/g) ?? []).map(Number)) > 1, 'the press spring overshoots');
  assert.ok(Math.max(...(decls.get('--spring-snappy')?.value.match(/[\d.]+/g) ?? []).map(Number)) <= 1, 'the snappy spring does not');
});

test('reduced motion ends every animation at once and runs it once, without touching transitions', () => {
  /** Declarations of `* , ::before, ::after` rules inside a prefers-reduced-motion: reduce query, in app.css order. */
  const found: Record<string, string>[] = [];
  postcss.parse(appCss()).walkAtRules('media', (at) => {
    if (!/prefers-reduced-motion:\s*reduce/.test(at.params)) return;
    at.walkRules((rule) => {
      const sels = rule.selectors.map((s) => s.trim());
      if (!(sels.includes('*') && sels.includes('::before') && sels.includes('::after'))) return;
      const decls: Record<string, string> = {};
      rule.walkDecls((d) => {
        decls[d.prop] = `${d.value}${d.important ? ' !important' : ''}`;
      });
      found.push(decls);
    });
  });
  assert.deepEqual(found, [{ 'animation-duration': '0.01ms !important', 'animation-iteration-count': '1 !important' }]);
});
