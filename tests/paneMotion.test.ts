// The side pane's open and close motion (src/lib/paneMotion.ts, src/styles/app/motion.css): the Codex app's
// right-panel spring (duration 0.5s, bounce 0.1) on the width only, the same spring both ways, started mid-way from
// the edge's width and speed, and the pane kept mounted for as long as its closing spring runs; and the agent tab's
// busy pulse (browser-pane.css). The hook that plays it is tested in paneSpring.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';
import {
  PANE_SPRING_MS,
  PANE_SPRING_STEPS,
  PANE_FADE_MS,
  paneCurve,
  paneExitMs,
  paneKeyframes,
  prefersReducedMotion,
  springFrequency,
} from '../src/lib/paneMotion.ts';

const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
const css = postcss.parse(appCss());
const { decls, keyframes } = cssRules(css);

/** Framer Motion's duration/bounce spring (its findSpring), from rest to 1. */
function framerSpring(duration: number, bounce: number) {
  const z = 1 - bounce;
  const angular = (u: number) => u * Math.sqrt(1 - z * z);
  const env = (u: number) => 0.001 - ((u * z) / angular(u)) * Math.exp(-u * z * duration);
  const der = (u: number) => {
    const e = z ** 2 * u ** 2 * duration;
    const factor = -env(u) + 0.001 > 0 ? -1 : 1;
    return (factor * (-e * Math.exp(-u * z * duration))) / angular(u ** 2);
  };
  let u = 5 / duration;
  for (let i = 1; i < 12; i++) u -= env(u) / der(u);
  const w0 = u;
  const wd = w0 * Math.sqrt(1 - z * z);
  return (t: number) => 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
}

test("the pane's spring is the Codex app's right panel (duration 0.5s, bounce 0.1), Framer's findSpring", () => {
  const x = framerSpring(0.5, 0.1);
  const c = paneCurve(0, 600);
  // from rest, every frame within 0.01px of Framer's spring, the slight overshoot kept, settled by 500ms
  for (let ms = 0; ms <= PANE_SPRING_MS; ms += 4) assert.ok(Math.abs(c.at(ms) - 600 * x(ms / 1000)) < 0.01, `${ms}ms`);
  assert.ok(Math.max(...Array.from({ length: 126 }, (_, i) => c.at(i * 4))) > 600);
  assert.ok(Math.abs(c.at(PANE_SPRING_MS) - 600) < 0.6);
  assert.equal(c.velocity(0), 0);
  // the stiffness and damping Framer resolves (287.7 and 30.53 for mass 1)
  const w0 = springFrequency(0.5, 0.1);
  assert.ok(Math.abs(w0 * w0 - 287.7) < 0.1);
  assert.ok(Math.abs(2 * 0.9 * w0 - 30.53) < 0.01);
});

test('a spring started mid-way keeps the edge where it is and as fast as it was moving', () => {
  const open = paneCurve(0, 600);
  const t = 120;
  const back = paneCurve(open.at(t), 0, open.velocity(t));
  assert.equal(back.at(0), open.at(t));
  assert.ok(Math.abs(back.velocity(0) - open.velocity(t)) < 1e-9);
  // the velocity is the curve's derivative
  for (const ms of [0, 30, 90, 200]) {
    const slope = ((back.at(ms + 0.01) - back.at(ms - 0.01)) / 0.02) * 1000;
    assert.ok(Math.abs(slope - back.velocity(ms)) < 0.5, `${ms}ms`);
  }
  // it overshoots the far end no further than a spring's swing, and settles there
  assert.ok(Math.abs(back.at(PANE_SPRING_MS)) < 1);
});

test('the keyframes sample the curve every 1/30 of 500ms and end exactly on the target', () => {
  const c = paneCurve(250, 0, 1800);
  const k = paneKeyframes(c);
  assert.equal(k.length, PANE_SPRING_STEPS + 1);
  k.slice(0, -1).forEach((w, i) => assert.equal(w, c.at((PANE_SPRING_MS * i) / PANE_SPRING_STEPS)));
  assert.equal(k.at(-1), 0);
  assert.equal(k[0], 250);
});

test('the side pane springs from script, with no fade; its CSS plays nothing but the full view fade', () => {
  assert.equal(decls('.side-pane').animation, undefined);
  assert.equal(decls('.side-pane.leaving:not(.full)').animation, 'none', 'outranks the shared leaving rule');
  assert.equal(keyframes('pane-open'), '');
  assert.equal(keyframes('pane-close'), '');
  assert.doesNotMatch(tokens, /--ease-pane-spring|--pane-spring-ms/);
  assert.equal(decls('.side-pane.full').animation, 'fade-in 250ms var(--ease-enter) backwards');
  assert.equal(decls('.side-pane.full.leaving')['animation-name'], 'panel-out-fade');
});

test('with reduced motion nothing moves, the full view and closing sidebar included, and the pane unmounts at once', () => {
  let off: string[] = [];
  css.walkAtRules('media', (m) => {
    if (!m.params.includes('prefers-reduced-motion: reduce')) return;
    m.walkRules((r) => {
      if (r.nodes.some((n) => n.type === 'decl' && n.prop === 'animation' && n.value === 'none')) off = off.concat(r.selectors);
    });
  });
  // each matches the rule it turns off in specificity, and comes later
  for (const s of ['.side-pane', '.side-pane.full', '.side-pane.leaving', '.sidebar', '.sidebar.leaving']) assert.ok(off.includes(s), s);
  assert.equal(paneExitMs(false, true), 0);
  assert.equal(paneExitMs(true, true), 0);
});

test('a closing pane stays mounted for its closing spring, or for the full view fade', () => {
  assert.equal(paneExitMs(false, false), PANE_SPRING_MS);
  assert.equal(paneExitMs(true, false), PANE_FADE_MS);
  // panel-out-fade runs for the leaving rule's 200ms
  assert.match(decls('.side-pane.leaving').animation, new RegExp(`^panel-out ${PANE_FADE_MS}ms `));
});

test('prefersReducedMotion reads the media query, and is false without matchMedia', (t) => {
  const g = globalThis as any;
  const had = 'window' in g;
  const prev = g.window;
  t.after(() => {
    if (had) g.window = prev;
    else delete g.window;
  });
  g.window = { matchMedia: (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' }) };
  assert.equal(prefersReducedMotion(), true);
  g.window = { matchMedia: () => ({ matches: false }) };
  assert.equal(prefersReducedMotion(), false);
  g.window = {};
  assert.equal(prefersReducedMotion(), false);
  delete g.window;
  assert.equal(prefersReducedMotion(), false);
});

test("the agent's tab icon pulses as Claude Desktop's busy tab does (Tailwind's animate-pulse)", () => {
  assert.equal(decls('.tb-tab.agent-active > svg:first-child').animation, 'agent-tab-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite');
  assert.equal(keyframes('agent-tab-pulse'), '50%{opacity:0.5}');
});
