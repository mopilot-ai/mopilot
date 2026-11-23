// The "working in" stack's geometry (src/styles/app/control-cards.css): its right edge on the composer's, a fixed
// width, the composer's surface and ring, and a 16:10 thumbnail whose radius nests inside the card's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';

const css = postcss.parse(appCss());
const { decls } = cssRules(css);

const px = (v: string) => Number(/^(\d+(?:\.\d+)?)px$/.exec(v)?.[1] ?? Number.NaN);

/**
 * The stack's `right` and the composer's width at an area `area` px wide, by substituting the shipped
 * --composer-w into each and evaluating the min/max/calc arithmetic (all in px once 100% is known).
 */
function resolve(expr: string, area: number, composerW = 736): number {
  const js = expr
    .replaceAll('var(--composer-w)', `${composerW}`)
    .replaceAll('100%', `${area}`)
    .replaceAll('px', '')
    .replaceAll('calc', '')
    .replaceAll('min(', 'Math.min(')
    .replaceAll('max(', 'Math.max(');
  assert.match(js, /^[\d\s.+\-*/(),Mathminax]+$/, `only arithmetic left in ${js}`);
  return Function(`return ${js}`)() as number;
}

test("the stack's right edge is the composer's at any width, and 16px from the area's edge at the least", () => {
  const right = decls('.working-in-stack').right;
  const composer = decls('.composer-wrap').width;
  for (const area of [1600, 1200, 900, 784, 600, 400]) {
    const gutter = (area - resolve(composer, area)) / 2;
    assert.equal(resolve(right, area), Math.max(16, gutter), `area ${area}px`);
  }
  // MoMo's narrower composer moves the edge with it
  assert.equal(resolve(right, 1200, 640), (1200 - 640) / 2);
});

test('the stack has a fixed width (wider with a live view open), so its left edge holds still as the step changes', () => {
  assert.equal(decls('.working-in-stack').width, 'min(288px, calc(100% - 32px))');
  assert.equal(decls('.working-in-stack')['max-width'], undefined);
  // open, it is never wider than the composer, so its left edge stays inside the composer's
  const open = decls('.working-in-stack[data-open]').width;
  const composer = decls('.composer-wrap').width;
  for (const area of [1600, 784, 500, 360]) assert.equal(resolve(open, area), Math.min(480, resolve(composer, area)), `area ${area}px`);
});

test("in the quick chat, which has no composer column, the stack keeps to the compose box's 12px edge", () => {
  assert.equal(decls('.quick-chat .working-in-stack').right, '12px');
  assert.equal(decls('.quick-chat .thread-composer-area')['padding'], '0 12px');
});

test("the card wears the composer's surface and ring; the thumbnail is 16:10 and its radius nests in the card's", () => {
  const card = decls('.working-in-card');
  assert.equal(card.background, 'var(--composer-bg)');
  assert.match(card['box-shadow'], /^inset 0 0 0 1px var\(--composer-border\),/);
  const thumb = decls('.working-in-thumb');
  assert.equal(px(thumb.width) / px(thumb.height), 16 / 10);
  assert.equal(thumb['object-position'], 'top center');
  assert.equal(px(thumb['border-radius']), px(card['border-radius']) - px(card.padding));
  assert.equal(decls('.working-in-live')['border-radius'], thumb['border-radius']);
  // the strip's live thumbnail is the same window shape
  const strip = decls('.cu-app-thumb');
  assert.equal(px(strip.width) / px(strip.height), 16 / 10);
});

test("the status slot is as wide as the app's icon above it, so both lines' text starts together", () => {
  assert.equal(decls('.working-in-badge').width, decls('.working-in-app-icon').width);
  assert.equal(decls('.working-in-app').gap, decls('.working-in-step').gap);
});
