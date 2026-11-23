// Pane layout sizing and the active split-pane animation contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appCss } from './support/app-css.ts';
import postcss from 'postcss';
import { fitPaneWidth, initialPaneWidth, paneLane, paneOpensFull } from '../src/lib/paneLayout.ts';
import { paneCurve, paneKeyframes } from '../src/lib/paneMotion.ts';

test('opening a browser preserves chat even with full view enabled or inherited', () => {
  for (const open of [false, true])
    for (const full of [false, true])
      for (const defaultFull of [false, true]) assert.equal(paneOpensFull('browser', open, full, defaultFull), false);
});

test('skill, side-chat and artifact tabs also keep the main conversation visible', () => {
  for (const kind of ['skill', 'chat', 'artifact', 'plan'] as const) assert.equal(paneOpensFull(kind, true, true, true), false);
});

test('file previews always keep the chat visible, regardless of full-view defaults', () => {
  for (const open of [false, true])
    for (const full of [false, true])
      for (const defaultFull of [false, true]) assert.equal(paneOpensFull('file', open, full, defaultFull), false);
});

test('a terminal stays in the side pane, even with Expand panels on or a full-view tab in front', () => {
  for (const open of [false, true])
    for (const full of [false, true])
      for (const defaultFull of [false, true]) assert.equal(paneOpensFull('terminal', open, full, defaultFull), false);
});

test('files and changes retain their explicit full-view preference', () => {
  for (const kind of ['files', 'changes'] as const) {
    assert.equal(paneOpensFull(kind, false, false, true), true);
    assert.equal(paneOpensFull(kind, false, true, false), false);
    assert.equal(paneOpensFull(kind, true, true, false), true);
    assert.equal(paneOpensFull(kind, true, false, true), false);
  }
});

test('the initial pane takes half the content lane; a lane too small for both minimums splits in proportion to them', () => {
  for (const available of [1000, 1400]) {
    const pane = initialPaneWidth(available);
    assert.equal(pane, available / 2);
    assert.ok(available - pane >= pane);
  }
  // 440 for the chat and 400 for the pane do not fit: both give up the same share
  assert.equal(initialPaneWidth(600), 286);
  assert.equal(initialPaneWidth(800), 381);
  assert.equal(initialPaneWidth(2000), 860);
  assert.equal(initialPaneWidth(0), 0);
});

const css = postcss.parse(appCss());
test('split panes animate their width from zero instead of fading in a full-page replacement', () => {
  // the split pane fades in no CSS animation: script springs its width (usePaneSpring.ts, paneSpring.test.ts)
  let animation: string | undefined;
  css.walkRules('.side-pane', (rule) =>
    rule.walkDecls('animation', (decl) => {
      animation = decl.value;
    }),
  );
  assert.equal(animation, undefined);
  // and the opening spring's first keyframe is a width of 0
  const open = paneKeyframes(paneCurve(0, 600));
  assert.equal(open[0], 0);
  assert.equal(open.at(-1), 600);
});

test('a pane follows a lane that changed: the chat keeps 440 px and the pane 400 px; an unmeasured lane changes nothing', () => {
  // roomy lanes leave a dragged pane alone up to lane - 440
  assert.equal(fitPaneWidth(500, 1600), 500);
  assert.equal(fitPaneWidth(1500, 1600), 1160);
  // a pane under its minimum grows back to it once the lane has room
  assert.equal(fitPaneWidth(300, 1000), 400);
  // narrow lanes split in proportion to the two minimums
  assert.equal(fitPaneWidth(683, 416), 198);
  assert.equal(fitPaneWidth(100, 416), 198);
  assert.equal(fitPaneWidth(683, 0), 683);
});

test("the pane's lane is its parent's width, or the window's when it is not in one", () => {
  const was = (globalThis as any).window;
  (globalThis as any).window = { innerWidth: 1500 };
  try {
    assert.equal(paneLane({ parentElement: { clientWidth: 900 } } as any), 900);
    assert.equal(paneLane({ parentElement: null } as any), 1500);
    assert.equal(paneLane({ parentElement: { clientWidth: 0 } } as any), 1500, 'an unmeasured lane falls back too');
  } finally {
    (globalThis as any).window = was;
  }
});

test('remembered widths: a share per group, read only when it is a share; forgetting one keeps the other', async () => {
  const { paneWidthGroup, openingPaneWidth, rememberPaneWidth } = await import('../src/lib/paneLayout.ts');
  for (const kind of ['chat', 'tasks', 'terminal', 'skill'] as const) assert.equal(paneWidthGroup(kind), 'narrow');
  for (const kind of ['browser', 'changes', 'files', 'file', undefined] as const) assert.equal(paneWidthGroup(kind), 'wide');
  // nothing saved, or something that is not a share of the lane: the default half
  for (const saved of [undefined, null, 'x', {}, { wide: 0 }, { wide: 1 }, { wide: '0.6' }, { wide: Number.NaN }])
    assert.equal(openingPaneWidth(1000, saved, 'wide'), 500);
  assert.equal(openingPaneWidth(1000, { wide: 0.3, narrow: 0.45 }, 'narrow'), 450);
  assert.equal(openingPaneWidth(1000, { wide: 0.3 }, 'wide'), 400, 'kept at the pane minimum');
  // saving rounds to a thousandth and drops what is not a share; null forgets the group
  assert.deepEqual(rememberPaneWidth({ narrow: 0.4, wide: 'bad' }, 'wide', 623.4, 1000), { narrow: 0.4, wide: 0.623 });
  assert.deepEqual(rememberPaneWidth({ narrow: 0.4, wide: 0.6 }, 'wide', null, 1000), { narrow: 0.4 });
  assert.deepEqual(rememberPaneWidth(null, 'narrow', 500, 0), {}, 'an unmeasured lane saves nothing');
  assert.deepEqual(rememberPaneWidth('junk', 'narrow', 1200, 1000), {}, 'wider than the lane is no share');
});
