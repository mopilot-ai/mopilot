// Looping animations a stylesheet declares with no way for the reduced-motion setting to stop them:
// finds each `infinite` animation and the `prefers-reduced-motion` rule that answers it. Read by
// tests/styles.test.ts.
import postcss from 'postcss';

/** The `prefers-reduced-motion` preference the media queries around `rule` ask for, innermost or not. */
function motionQuery(rule: postcss.Rule): { noPreference: boolean; reduce: boolean } {
  let noPreference = false;
  let reduce = false;
  for (let node: postcss.Node | undefined = rule.parent; node; node = node.parent) {
    if (node.type !== 'atrule' || (node as postcss.AtRule).name !== 'media') continue;
    const params = (node as postcss.AtRule).params;
    noPreference ||= params.includes('prefers-reduced-motion: no-preference');
    reduce ||= params.includes('prefers-reduced-motion: reduce');
  }
  return { noPreference, reduce };
}

/** Whether a block that names `animation`/`animation-name` repeats for ever: in the shorthand, or its own count. */
function loops(rule: postcss.Rule, decl: postcss.Declaration): boolean {
  if (/\binfinite\b/.test(decl.value)) return true;
  let count = false;
  rule.walkDecls('animation-iteration-count', (d) => void (count ||= /\binfinite\b/.test(d.value)));
  return count;
}

/**
 * Every looping animation in `sheets` that the reduced-motion setting cannot stop. An animation answers the
 * setting either way round: declared only inside a `prefers-reduced-motion: no-preference` block, or switched
 * off with `animation: none` for the same selector inside a `reduce` one. A one-shot animation plays once and
 * stops, so it is left alone; `@keyframes` are not rules and never carry the opt-out themselves. Selectors are
 * compared as postcss splits them, which keeps a comma inside `:is(…)` out of it. Two things this does not
 * judge, both of which only let a case through rather than reporting a sound one: whether the opt-out follows
 * its rule in the cascade (a media query adds no specificity, so an opt-out written first would lose), and
 * whether a shorthand reset between them brings the animation back.
 */
export function loopsWithNoMotionOptOut(sheets: [string, string][]): string[] {
  const found: { sheet: string; selectors: string[]; written: string }[] = [];
  const off = new Set<string>();
  for (const [sheet, text] of sheets) {
    postcss.parse(text, { from: sheet }).walkRules((rule) => {
      if (rule.parent?.type === 'atrule' && (rule.parent as postcss.AtRule).name === 'keyframes') return;
      const query = motionQuery(rule);
      rule.walkDecls(/^animation(-name)?$/, (decl) => {
        // an opt-out turns the animation off for the whole selector, wherever else the sheets declare it
        if (query.reduce && /\bnone\b/.test(decl.value)) {
          for (const selector of rule.selectors) off.add(selector);
          return;
        }
        if (query.noPreference || !loops(rule, decl)) return;
        found.push({ sheet, selectors: rule.selectors, written: `${decl.prop}: ${decl.value}` });
      });
    });
  }
  return found
    .filter(({ selectors }) => !selectors.every((one) => off.has(one)))
    .map(({ sheet, selectors, written }) => `${sheet} ${selectors.join(', ')}: ${written}`);
}
