// The running step label's shimmer (src/styles/app/motion.css): the cadenced "Thinking" shimmer, the
// first sweep 600ms in, each sweep 1000ms, one every 4000ms, with its band travel and shape,
// drawn as a band the words' glyphs mask and a translate moves; still with reduced motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';

const css = postcss.parse(appCss());
const { decls } = cssRules(css);

/** A keyframes rule as `selector{prop:value;...}` per step. */
function keyframes(name: string): string {
  let out = '';
  css.walkAtRules('keyframes', (a) => {
    if (a.params !== name) return;
    a.walkRules((r) => {
      const d: string[] = [];
      r.walkDecls((x) => void d.push(`${x.prop}:${x.value}`));
      out += `${r.selectors.join(',')}{${d.join(';')}}`;
    });
  });
  return out;
}

const band = () => decls('.shimmer > .shimmer-band::after');

test('the shimmer sweeps first at 600ms, for 1000ms, then once every 4000ms', () => {
  assert.equal(band().animation, 'shimmer-cadence 4000ms linear var(--shimmer-resume, 600ms) infinite');
  assert.equal(keyframes('shimmer-cadence'), '0%{translate:-100%}25%,100%{translate:250%}');
  // the sweep is the first quarter of the cycle: 1000 of 4000ms
  assert.equal(0.25 * 4000, 1000);
});

test('the band travels with its centre from -25% to 150% of the text, 20% ramps around a 10% peak', () => {
  const b = band();
  // half the text wide, so translating it by p of its own width moves its centre to 0.5 * p + 0.25 of the text
  assert.equal(b.inset, '0 50% 0 0');
  assert.match(b['background-image'], /transparent 0%, var\(--shimmer-peak\) 40%, var\(--shimmer-peak\) 60%, transparent 100%/);
  assert.equal(decls('.shimmer')['--shimmer-peak'], 'var(--shimmer-contrast)');
  const centre = (p: number) => 0.5 * p + 0.25;
  assert.equal(centre(-1), -0.25);
  assert.equal(centre(2.5), 1.5);
});

test("the words' glyphs mask the band, which only the compositor moves", () => {
  let masked = false;
  css.walkAtRules('supports', (s) => {
    if (s.params !== '(-webkit-mask-clip: text)') return;
    s.walkRules((r) => {
      if (r.selector === ':is(.shimmer-text, .shimmer)')
        masked = r.nodes.some((n) => n.type === 'decl' && n.prop === '-webkit-mask-clip' && n.value === 'text');
    });
  });
  assert.ok(masked);
  // the band hides where the mask is not supported, so it never paints over the words
  assert.equal(decls('.shimmer-band').display, 'none');
  const shine = decls('.shimmer-band::after');
  assert.equal(shine.animation, 'shimmer-band 3s linear var(--shimmer-delay, 0s) infinite');
  assert.equal(
    keyframes('shimmer-band'),
    '0%,15%{translate:-62.5%;animation-timing-function:cubic-bezier(0.714, 0.121, 0.211, 0.888)}85%,100%{translate:-12.5%}',
  );
});

test('with reduced motion the label holds still', () => {
  let off = false;
  css.walkAtRules('media', (m) => {
    if (!m.params.includes('prefers-reduced-motion: reduce')) return;
    m.walkRules((r) => {
      // with no sweep the band rests past the words' edge, so they read in plain ink
      if (
        r.selectors.includes('.shimmer > .shimmer-band::after') &&
        r.nodes.some((n) => n.type === 'decl' && n.prop === 'animation' && n.value === 'none')
      )
        off = true;
    });
  });
  assert.ok(off);
});

test("a shimmering label whose own rule sets a color still reads in the shimmer's ink", () => {
  // .suggest-row-title (suggestCard.css) loads after motion.css and sets color: var(--text)
  assert.equal(decls('.shimmer-text').color, 'var(--shimmer-ink)');
  assert.equal(decls('.suggest-row-title.shimmer-text').color, 'var(--shimmer-ink)');
});
