// Review-card E2E assertions must select a transcript or pane because both may render the same review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';
import { parseSync } from 'vite';

export const GUARDS = ['tests/e2e/'];

function unscopedReviewCards(source: string) {
  const parsed = parseSync('review-spec.ts', source);
  assert.deepEqual(parsed.errors, []);
  const found: number[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    const callee = node.callee;
    if (
      node.type === 'CallExpression' &&
      callee?.type === 'MemberExpression' &&
      callee.object?.type === 'Identifier' &&
      callee.object.name === 'page' &&
      callee.property?.name === 'locator' &&
      typeof node.arguments[0]?.value === 'string' &&
      /(?:^|,)\s*(?:[a-z][\w-]*)?\.review-result(?![\w-])/.test(node.arguments[0].value)
    )
      found.push(node.start);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(parsed.program);
  return found;
}

test('review locator guard catches page-wide cards without rejecting transcript or pane scopes', () => {
  assert.equal(unscopedReviewCards(`page.locator('.review-result')`).length, 1);
  assert.equal(unscopedReviewCards(`page.locator('.review-result').first()`).length, 1);
  assert.equal(unscopedReviewCards(`page.locator('.review-result h2')`).length, 1);
  assert.deepEqual(unscopedReviewCards(`transcript(page).locator('.review-result')`), []);
  assert.deepEqual(unscopedReviewCards(`page.locator('.side-pane').locator('.review-result')`), []);
  assert.deepEqual(unscopedReviewCards(`page.locator('.review-result-other')`), []);
  assert.deepEqual(unscopedReviewCards(`page.locator('.transcript .review-result')`), []);
});

test('every E2E review-card locator selects its transcript or pane rather than the whole page', () => {
  for (const file of treeFiles(new URL('./e2e/', import.meta.url).pathname, /\.spec\.ts$/))
    assert.deepEqual(unscopedReviewCards(readFileSync(file, 'utf8')), [], `${file}: scope review cards to their intended view`);
});
