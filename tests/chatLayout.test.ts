import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appCss } from './support/app-css.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss from 'postcss';
import { SummarySlot } from '../src/components/panels/SummarySlot.ts';

function render(routeName: Parameters<typeof SummarySlot>[0]['routeName'], summaryOpen = true, diffOpen = false) {
  return renderToStaticMarkup(
    createElement(SummarySlot, {
      routeName,
      summaryOpen,
      diffOpen,
      children: createElement('aside', null, 'Summary'),
    }),
  );
}

test('a chat shows the summary in its lane', () => {
  assert.equal(render('thread'), '<div class="summary-slot"><aside>Summary</aside></div>');
});

test('home reserves no summary lane, so its hero and composer center on the whole main area', () => {
  assert.equal(render('home'), '');
  assert.equal(render('home', false), '');
  assert.equal(render('home', true, true), '');
});

test('home never mounts summary contents', () => {
  function UnexpectedSummary(): never {
    throw new Error('Summary mounted on home');
  }
  assert.doesNotThrow(() =>
    renderToStaticMarkup(
      createElement(SummarySlot, {
        routeName: 'home',
        summaryOpen: true,
        diffOpen: false,
        children: createElement(UnexpectedSummary),
      }),
    ),
  );
});

test('hiding summary releases the lane on a chat', () => {
  assert.equal(render('thread', false), '');
});

test('an open side pane replaces the summary lane on a chat', () => {
  assert.equal(render('thread', true, true), '');
});

test('settings and other non-chat routes do not reserve a summary lane', () => {
  for (const route of ['settings', 'plugins', 'scheduled', 'review', 'projects', 'cloud'] as const) {
    assert.equal(render(route), '', route);
  }
});

const css = postcss.parse(appCss());
function declarations(selector: string) {
  const result: Record<string, string> = {};
  css.walkRules(selector, (rule) => {
    rule.walkDecls((decl) => {
      result[decl.prop] = decl.value;
    });
  });
  return result;
}

test('the lane reserves the complete panel footprint and cannot shrink', () => {
  const lane = declarations('.summary-slot');
  const panel = declarations('.summary-panel');
  const rightMargin = panel.margin.split(/\s+/)[1];
  assert.equal(lane.width, `calc(${panel.width} + ${rightMargin})`);
  assert.equal(lane.flex, 'none');
});

test('the transcript stays scrollable without a visible scrollbar or reserved gutter', () => {
  const scroll = declarations('.thread-scroll');
  assert.equal(scroll['overflow-y'], 'auto');
  assert.equal(scroll['overflow-x'], 'hidden');
  assert.equal(scroll['scrollbar-width'], 'none');
  assert.equal(scroll['scrollbar-gutter'] ?? 'auto', 'auto');
  assert.equal(declarations('.thread-scroll::-webkit-scrollbar').display, 'none');
});
