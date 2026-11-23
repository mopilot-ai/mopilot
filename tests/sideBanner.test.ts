// The sidebar card (src/components/sidebar/SideBanner.tsx): icon beside the title, an optional detail line, the actions on their own trailing row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';
import './support/dom.ts';

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SideBanner } = await import('../src/components/sidebar/SideBanner.tsx');

async function render(props: Record<string, unknown>) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(() =>
    root.render(createElement(SideBanner, props as any, createElement('button', null, 'No'), createElement('button', null, 'Yes'))),
  );
  const slot = host.firstElementChild as HTMLElement;
  assert.equal(slot.className, 'slot');
  return { card: slot.firstElementChild as HTMLElement, root };
}

test('icon, title and detail in their own columns, the actions in a row of their own', async () => {
  const { card, root } = await render({ tone: 'ask', icon: createElement('svg'), title: 'Allow this?', detail: 'It asked.', testId: 't' });
  assert.equal(card.dataset.tone, 'ask');
  assert.equal(card.dataset.testid, 't');
  assert.equal(card.getAttribute('role'), 'alert');
  assert.deepEqual(
    [...card.children].map((c) => c.className),
    ['icon', 'text', 'actions'],
  );
  assert.ok(card.querySelector('.icon > svg'));
  assert.equal(card.querySelector('.title')?.textContent, 'Allow this?');
  assert.equal(card.querySelector('.detail')?.textContent, 'It asked.');
  assert.deepEqual(
    [...card.querySelectorAll('.actions > button')].map((b) => b.textContent),
    ['No', 'Yes'],
  );
  await act(() => root.unmount());
});

test('no detail line without a detail', async () => {
  const { card, root } = await render({ tone: 'warn', icon: null, title: 'Failed', testId: 't' });
  assert.equal(card.dataset.tone, 'warn');
  assert.equal(card.querySelector('.detail'), null);
  assert.equal(card.querySelector('.text')?.children.length, 1);
  await act(() => root.unmount());
});

/** prop → value of the rule for `selector` in the card's stylesheet. */
function rule(selector: string) {
  const css = fs.readFileSync(new URL('../src/components/sideBanner.module.css', import.meta.url), 'utf8');
  const out: Record<string, string> = {};
  postcss.parse(css).walkRules((r) => {
    if (r.selector === selector) r.walkDecls((d) => void (out[d.prop] = d.value));
  });
  return out;
}

test('the layout keeps the icon beside the title and the actions on their own trailing row', () => {
  // a wrapping flex row put the icon alone on the first line and the buttons under the text (the bug this replaced)
  const banner = rule('.banner');
  assert.equal(banner.display, 'grid');
  assert.equal(banner['grid-template-columns'], '16px minmax(0, 1fr)');
  assert.equal(banner['flex-wrap'], undefined);
  // the sidebar gives each child its full width, so a margin on the card would push it past the edge
  assert.equal(banner.margin, undefined);
  assert.equal(rule('.slot').padding, '8px 8px 0');
  const actions = rule('.actions');
  assert.equal(actions['grid-column'], '1 / -1');
  assert.equal(actions['justify-content'], 'flex-end');
  assert.equal(rule('.text')['min-width'], '0');
});
