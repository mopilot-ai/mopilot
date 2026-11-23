// The error card's entrance (#1511 PR 4i): Claude Desktop's reveal-in, a 4px rise over --dur-base on --ease-out, off under reduced motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { readAppCssPart } from './support/app-css.ts';

test('reveal-in rises 4px over --dur-base on --ease-out, and reduced motion turns it off', () => {
  const root = postcss.parse(readAppCssPart('app/thread-results.css'));
  const found: [boolean, string][] = [];
  root.walkRules((rule) => {
    if (rule.selector.trim() !== '.reveal-in') return;
    const reduced = rule.parent?.type === 'atrule' && /prefers-reduced-motion:\s*reduce/.test((rule.parent as postcss.AtRule).params);
    rule.walkDecls('animation', (d) => {
      found.push([reduced, d.value]);
    });
  });
  assert.deepEqual(found, [
    [false, 'reveal-in var(--dur-base) var(--ease-out) backwards'],
    [true, 'none'],
  ]);
  let from = '';
  root.walkAtRules('keyframes', (at) => {
    if (at.params === 'reveal-in') at.walkDecls((d) => void (from += `${d.prop}:${d.value};`));
  });
  assert.equal(from, 'opacity:0;transform:translateY(4px);');
});
