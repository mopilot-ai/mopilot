// A turn's working placeholder (#1511 PR 4d): it waits --reveal-hold before fading in over 150ms ease-out, as Claude Desktop's placeholders do, and reduced motion shows it at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { readAppCssPart } from './support/app-css.ts';

test('the placeholder holds, then fades in; reduced motion shows it at once', () => {
  const found: [boolean, string][] = [];
  postcss.parse(readAppCssPart('app/thread-messages.css')).walkRules((rule) => {
    if (!rule.selectors.map((s) => s.trim()).includes('.placeholder-reveal')) return;
    const reduced = rule.parent?.type === 'atrule' && /prefers-reduced-motion:\s*reduce/.test((rule.parent as postcss.AtRule).params);
    rule.walkDecls('animation', (d) => {
      found.push([reduced, d.value]);
    });
  });
  assert.deepEqual(found, [
    [false, 'fade-in 150ms ease-out var(--reveal-hold) backwards'],
    [true, 'none'],
  ]);
});
