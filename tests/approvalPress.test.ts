// Approval buttons' press (#1511 PR 4b): a press squeezes to .975 over --dur-fast, the release springs back over --dur-slow on --spring-press, the browser and computer-use cards keep their colour transitions next to it, and reduced motion drops the motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { readAppCssPart } from './support/app-css.ts';

/** Every rule for `selector` in approvals.css, with whether it sits in a reduced-motion query, as prop → value. */
function rules(selector: string) {
  const out: { reduced: boolean; decls: Record<string, string> }[] = [];
  postcss.parse(readAppCssPart('app/approvals.css')).walkRules((rule) => {
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    const parent = rule.parent;
    const reduced = parent?.type === 'atrule' && /prefers-reduced-motion:\s*reduce/.test((parent as postcss.AtRule).params);
    const decls: Record<string, string> = {};
    rule.walkDecls((d) => {
      decls[d.prop] = d.value.replace(/\s+/g, ' ').trim();
    });
    out.push({ reduced, decls });
  });
  return out;
}

const transitionOf = (selector: string, reduced: boolean) =>
  rules(selector)
    .filter((r) => r.reduced === reduced && r.decls.transition)
    .map((r) => r.decls.transition);

test('a press squeezes the button fast; the release springs back on the press spring', () => {
  assert.deepEqual(transitionOf('.ap-btn', false), ['transform var(--dur-slow) var(--spring-press)']);
  const active = rules('.ap-btn:not(:disabled):active').find((r) => !r.reduced);
  assert.equal(active?.decls.transform, 'scale(0.975)');
  assert.equal(active?.decls.transition, 'transform var(--dur-fast) ease-out');
});

test("MoPilot's own cards (site, app, page permission, dev server) take the same press: no transition of their own overrides it", () => {
  assert.deepEqual(transitionOf('.sage-approval .ap-btn', false), []);
  assert.deepEqual(transitionOf('.sage-approval .ap-btn:not(:disabled):active', false), []);
});

test('reduced motion drops the press motion', () => {
  assert.deepEqual(transitionOf('.ap-btn', true), ['none']);
  assert.deepEqual(transitionOf('.ap-btn:not(:disabled):active', true), ['none']);
  assert.deepEqual(transitionOf('.sage-approval .ap-btn', true), []);
});
