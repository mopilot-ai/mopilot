// Control matrix, the in-app browser's layout beside the chat (docs/control-plane/matrix/I.md CM-I01 to CM-I06):
// the chat keeps a readable minimum width while a side pane (the browser, changes, files, a terminal tab or a side
// chat) shares its lane, whatever the saved sidebar width, the window size or the divider drag. Every panel beside
// the chat sizes through one clamp (src/lib/splitClamp.ts). The layout does not depend on the chat's harness, so the
// cases hold for Claude Code, Codex and switched chats alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { readFileSync } from 'node:fs';
import { CHAT_MIN_WIDTH, PANE_MIN_WIDTH, SHELL_WIDTH, SUMMARY_SLOT_WIDTH, clampSplit } from '../src/lib/splitClamp.ts';
import { besideWidth, dragPaneWidth, fitPaneWidth, initialPaneWidth } from '../src/lib/paneLayout.ts';
import { sidebarWidth } from '../src/lib/sidebarWidth.ts';
import { sidebarDragWidth, sidebarMaxWidth } from '../src/lib/sidebarSizing.ts';

export const GUARDS = ['src/'];

/** The chat and pane widths of a window: the sidebar at its clamped saved width, then the lane split. */
function layout(viewport: number, savedSidebar: unknown) {
  const sidebar = sidebarWidth(savedSidebar, viewport, besideWidth('thread', true, false, false));
  const lane = viewport - SHELL_WIDTH - sidebar;
  const pane = initialPaneWidth(lane);
  return { sidebar, lane, pane, chat: lane - pane };
}

test('CM-I01: the shared clamp: want within the minimums while the lane holds both, a proportional split when it cannot, unmeasured lanes untouched', () => {
  const split = { min: 400, keep: 440 };
  assert.equal(clampSplit(500, 1200, split), 500);
  assert.equal(clampSplit(100, 1200, split), 400, 'the panel keeps its minimum');
  assert.equal(clampSplit(1100, 1200, split), 760, 'the chat keeps its minimum');
  assert.equal(clampSplit(700, 1200, { ...split, max: 560 }), 560, 'and the panel its maximum');
  // a lane too small for both minimums: each gives up the same share instead of one collapsing
  assert.equal(clampSplit(700, 630, split), 300);
  assert.equal(clampSplit(0, 630, split), 300);
  // an unmeasured lane keeps the request; a request that is not a number asks for the minimum
  for (const lane of [0, -5, Number.NaN]) assert.equal(clampSplit(612.4, lane, split), 612);
  assert.equal(clampSplit(Number.NaN, 1200, split), 400);
  assert.equal(clampSplit(Number.NaN, 0, split), 400);
});

test('CM-I02: IAB×Claude, IAB×Codex, IAB×Switch: a pane opened at a 1440 window splits the lane evenly and the chat keeps at least 440 px, even with the widest saved sidebar', () => {
  const roomy = layout(1440, 288);
  assert.deepEqual(roomy, { sidebar: 288, lane: 1152, pane: 576, chat: 576 });
  // the reported bug: a sidebar saved at its 560 px maximum left the chat a narrow strip beside the browser (a
  // window just too narrow for all three at their widths)
  const wide = layout(1384, 560);
  assert.equal(wide.sidebar, 544, 'the saved width is clamped for this window without being rewritten');
  assert.ok(wide.chat >= CHAT_MIN_WIDTH, `chat ${wide.chat}`);
  assert.ok(wide.pane >= PANE_MIN_WIDTH, `pane ${wide.pane}`);
  // corrupt saved widths fall back to the default and still leave the chat its room
  for (const saved of [undefined, Number.NaN, '600', 10_000]) assert.ok(layout(1440, saved).chat >= CHAT_MIN_WIDTH);
  // the smallest window the app allows (760) cannot hold both minimums: neither collapses to a sliver
  const tiny = layout(760, 560);
  assert.equal(tiny.sidebar, 200);
  assert.ok(tiny.chat >= 250 && tiny.pane >= 220, JSON.stringify(tiny));
});

test('CM-I03: IAB×Claude, IAB×Codex, IAB×Switch: dragging the divider can never take the chat below 440 px or the pane below 400 px', () => {
  const lane = 1096;
  assert.equal(dragPaneWidth(548, 100, lane), 648);
  assert.equal(dragPaneWidth(548, 5000, lane), lane - CHAT_MIN_WIDTH);
  assert.equal(dragPaneWidth(548, -5000, lane), PANE_MIN_WIDTH);
  // dragging the sidebar wider with the pane open stops where the chat and the pane keep their minimums
  const sidebar = sidebarDragWidth(288, 5000, 1384, besideWidth('thread', true, false, false));
  assert.equal(1384 - SHELL_WIDTH - sidebar, CHAT_MIN_WIDTH + PANE_MIN_WIDTH);
});

test('CM-I04: IAB×Claude, IAB×Codex, IAB×Switch: a window made smaller re-clamps the pane and the saved sidebar, and a larger one gives the room back', () => {
  // a pane dragged wide in a big window, then the window shrinks: the pane gives way to the chat's minimum
  assert.equal(fitPaneWidth(900, 1000), 1000 - CHAT_MIN_WIDTH);
  // a pane squeezed in a tiny lane grows back to its minimum when the lane has room again
  assert.equal(fitPaneWidth(198, 1200), PANE_MIN_WIDTH);
  // the saved sidebar width is clamped to each window size from the same stored value
  assert.equal(sidebarWidth(560, 1200, PANE_MIN_WIDTH), 1200 - SHELL_WIDTH - CHAT_MIN_WIDTH - PANE_MIN_WIDTH);
  assert.equal(sidebarWidth(560, 1600, PANE_MIN_WIDTH), 560);
});

test('CM-I05: every panel beside the chat reserves its room through the same clamp: a side pane, full view and the summary island', () => {
  assert.equal(besideWidth('thread', true, false, true), PANE_MIN_WIDTH, 'the pane hides the summary');
  assert.equal(besideWidth('home', true, false, false), PANE_MIN_WIDTH);
  assert.equal(besideWidth('thread', true, true, false), 0, 'full view covers the chat: nothing shares the lane');
  assert.equal(besideWidth('thread', false, false, true), SUMMARY_SLOT_WIDTH);
  assert.equal(besideWidth('home', false, false, true), 0, 'home never shows the summary');
  assert.equal(besideWidth('settings', true, false, false), 0, 'pages without a pane');
  assert.equal(sidebarMaxWidth(1200, SUMMARY_SLOT_WIDTH), 1200 - SHELL_WIDTH - CHAT_MIN_WIDTH - SUMMARY_SLOT_WIDTH);
  // the summary's footprint follows its token
  const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
  assert.equal(Number(/--summary-w: (\d+)px/.exec(tokens)?.[1]) + 8, SUMMARY_SLOT_WIDTH);
  // the drag handles size through the clamp, not their own window arithmetic
  for (const file of ['src/components/panels/SidePane.tsx', 'src/components/panels/TerminalPanel.tsx']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /window\.inner(Width|Height) - \d+/, file);
  }
});

test('CM-I06: IAB×Claude, IAB×Codex, IAB×Switch: the Full access banner wraps its buttons under the text in a narrow chat instead of squeezing it to a word a line', () => {
  const css = postcss.parse(appCss());
  const decls = (selector: string) => {
    const out: Record<string, string> = {};
    css.walkRules(selector, (rule) => rule.walkDecls((d) => void (out[d.prop] = d.value)));
    return out;
  };
  assert.equal(decls('.fa-banner')['flex-wrap'], 'wrap');
  assert.match(decls('.fa-text').flex, /^1 1 \d+px$/);
});
