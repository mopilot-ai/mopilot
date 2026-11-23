// Boxes a stylesheet pins in pixels around text whose size follows the Chat font-size setting:
// measures each rule's line box, padding and borders against its pinned height, and finds a shared
// min-height that clamps a narrower rule. Read by tests/styles.test.ts; see docs/code-quality.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { appCssParts, readAppCssPart } from './app-css.ts';

const parse = (name: string, text: string) => postcss.parse(text, { from: name });

/* ------------------------------------------------------------------------------------------------
   A box pinned in pixels around text whose size follows the Chat font-size setting.
   The type scale made every font-size and leading answer Settings -> Appearance -> Advanced -> Chat
   font size, so a rule that also pins `height` keeps a box that no longer matches its text: at Chat
   18 the line box outgrows it and the text spills out of the background. A rule may keep a pinned
   height, but only where the box still holds its own line box at every size the setting offers.
   ------------------------------------------------------------------------------------------------ */

/** The sizes an Appearance row offers, read from the row itself so this moves with the setting. */
function sizeOptions(title: string): number[] {
  const tsx = readFileSync(new URL('../../src/components/pages/settings/Appearance.tsx', import.meta.url), 'utf8');
  const list = /options=\{\[([^\]]*)\]/.exec(tsx.slice(tsx.indexOf(`title="${title}"`)));
  assert.ok(list, `${title}: no options list in Appearance.tsx`);
  const sizes = [...list[1].matchAll(/'(\d+)'/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 1, `${title}: no sizes in Appearance.tsx`);
  return sizes;
}

export const CHAT_SIZES = sizeOptions('Chat font size');
const CODE_SIZES = sizeOptions('Code font size');

/** The type scale's steps and leading tokens, read from tokens.css where the scale is written. */
const SCALE_TOKENS = (() => {
  const css = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
  return new Map([...root.matchAll(/^\s*(--(?:fs|lh)-[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
})();

/** A font-size as pixels at a Chat and Code size, or null when it is not a size this can measure. */
function fontPx(value: string, chat: number, code: number): number | null {
  const token = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!token) {
    const px = /^([\d.]+)px$/.exec(value.trim());
    return px ? Number(px[1]) : null;
  }
  if (token[1] === '--fs-chat') return chat;
  if (token[1] === '--fs-code') return code;
  const declared = SCALE_TOKENS.get(token[1]) ?? '';
  const step = /^calc\(var\(--fs-chat\)\s*\*\s*([\d.]+)\)$/.exec(declared);
  if (step) return Number(step[1]) * chat;
  const fixed = /^([\d.]+)px$/.exec(declared);
  return fixed ? Number(fixed[1]) : null;
}

/** A leading as a ratio of the font size or a pixel line box, or null when it is not measurable. */
function leading(value: string): { ratio?: number; px?: number } | null {
  const token = /^var\((--lh-[\w-]+)\)$/.exec(value.trim());
  const raw = token ? (SCALE_TOKENS.get(token[1]) ?? '') : value.trim();
  if (/^[\d.]+$/.test(raw)) return { ratio: Number(raw) };
  const px = /^([\d.]+)px$/.exec(raw);
  if (px) return { px: Number(px[1]) };
  // `normal` is the font's own line box, which is smaller than the em box this compares against
  return raw === 'normal' ? { ratio: 1 } : null;
}

/** The leading an element inherits with no rule of its own: the app's own (src/styles/app/base.css). */
const INHERITED_LEADING = '1.5';

/**
 * The compounds of a selector, keeping ::before/::after apart: a pseudo-element is its own box, which
 * its originating element's rule never sizes or clamps. It does inherit that element's type, so a box
 * on one falls back to the inherited default here rather than to the originating rule -- the stricter
 * of the two, which asks the pseudo-element's own rule to state the size it holds. A pseudo-class only
 * narrows the same box, so it is dropped.
 */
const compounds = (selector: string) =>
  selector
    .split(/\s+|>|\+|~/)
    .filter(Boolean)
    .map((part) => part.replace(/(?<!:):[\w-]+(\([^)]*\))?/g, ''));

/** Whether `outer` matches every element `inner` matches: its compounds in the same order. */
const reaches = (outer: string[], inner: string[]) => {
  if (outer.at(-1) !== inner.at(-1)) return false;
  let at = 0;
  for (const compound of outer) {
    at = inner.indexOf(compound, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
};

type Block = { sheet: string; selector: string; at: string; decls: [string, string][] };

/** The at-rules a rule sits inside, outermost first: '' at the top level, where it always applies. */
function context(rule: postcss.Rule): string {
  const at: string[] = [];
  for (let node = rule.parent; node?.type === 'atrule'; node = node.parent)
    at.unshift(`@${(node as postcss.AtRule).name} ${(node as postcss.AtRule).params}`.trim());
  return at.join(' && ');
}

/** Every rule block of `sheets`, in cascade order, with its declarations in source order. */
function blocksOf(sheets: [string, string][]): Block[] {
  return sheets.flatMap(([sheet, text]) => {
    const blocks: Block[] = [];
    parse(sheet, text).walkRules((rule) => {
      const decls: [string, string][] = [];
      rule.walkDecls((decl) => {
        decls.push([decl.prop, decl.value]);
      });
      const at = context(rule);
      for (const selector of rule.selectors) blocks.push({ sheet, selector, at, decls });
    });
    return blocks;
  });
}

/**
 * A block's own last value for `prop`. The `font` shorthand carries a size and a leading, so a later
 * `font: inherit` throws away a font-size or line-height written earlier in the same block.
 */
function ownValue(block: Block, prop: 'font-size' | 'line-height'): string | null {
  let value: string | null = null;
  for (const [p, v] of block.decls) {
    if (p === prop) value = v;
    else if (p === 'font') {
      const parts = /(?:^|\s)([\d.]+px|var\(--[\w-]+\))(?:\s*\/\s*(\S+))?(?:\s|$)/.exec(v);
      value = prop === 'font-size' ? (parts?.[1] ?? null) : (parts?.[2] ?? null);
    }
  }
  return value;
}

/**
 * `prop` for the element this block matches: its own rule, else the last rule that reaches the same
 * element whenever this one does. A rule is only read where it applies on both axes, because a value
 * read from a rule that does not apply clears a box that overflows:
 *  - the selector: a sibling sharing nothing but the rightmost tag styles another element, and
 *    `.selection-toolbar-bar button`'s 1.385 hid `.segmented button`'s 24px box, which 1.5 overflows;
 *  - the condition: a declaration inside `@media`, `@container` or `@keyframes` holds only while that
 *    at-rule does, so only an unconditional rule, or one under this block's own at-rules, is read.
 */
function resolved(block: Block, blocks: Block[], prop: 'font-size' | 'line-height'): string | null {
  const own = ownValue(block, prop);
  if (own != null) return own;
  const mine = compounds(block.selector);
  let value: string | null = null;
  for (const other of blocks) {
    if (other.at !== '' && other.at !== block.at) continue;
    if (!reaches(compounds(other.selector), mine)) continue;
    value = ownValue(other, prop) ?? value;
  }
  return value;
}

/** The vertical padding or border a pinned height also has to hold, or null when it is not measurable. */
function verticalEdge(block: Block, kind: 'padding' | 'border'): number | null {
  const sides = { top: 0, bottom: 0 };
  const width = (value: string) => {
    const v = value.trim();
    if (v === 'none' || v === '0') return 0;
    const px = /(?:^|\s)([\d.]+)px(?:\s|$)/.exec(v);
    return px ? Number(px[1]) : /^[\d.]+$/.test(v) ? Number(v) : null;
  };
  for (const [prop, value] of block.decls) {
    const box = new RegExp(`^${kind}(?:-(top|bottom|left|right|inline|block))?(?:-width)?$`).exec(prop);
    if (!box) continue;
    if (box[1] === 'left' || box[1] === 'right' || box[1] === 'inline') continue;
    if (box[1] === 'top' || box[1] === 'bottom') {
      const w = width(value);
      if (w == null) return null;
      sides[box[1]] = w;
      continue;
    }
    if (kind === 'border' || box[1] === 'block') {
      const w = width(value);
      if (w == null) return null;
      sides.top = w;
      sides.bottom = w;
      continue;
    }
    // the padding shorthand's first value is the top and its third (or first) the bottom
    const list = value.trim().split(/\s+/);
    const top = width(list[0] ?? '0');
    const bottom = width(list[2] ?? list[0] ?? '0');
    if (top == null || bottom == null) return null;
    sides.top = top;
    sides.bottom = bottom;
  }
  return sides.top + sides.bottom;
}

/**
 * Every rule of `sheets` that pins a pixel `height` its own text outgrows, at any Chat size the
 * setting offers. Only rules that size their own type are read: a bare height is a decorative box
 * (a rule, a dot, a bar), and a box whose padding, border or leading is not a plain length is left
 * alone rather than guessed at. box-sizing is border-box here, so the height holds all three.
 */
export function boxesOverTheirText(sheets: [string, string][]): string[] {
  const blocks = blocksOf(sheets);
  const over: string[] = [];
  for (const block of blocks) {
    const pinned = block.decls.findLast(([p]) => p === 'height')?.[1]?.trim();
    if (!pinned || !/^[\d.]+px$/.test(pinned)) continue;
    if (!block.decls.some(([p]) => p === 'font-size' || p === 'line-height' || p === 'font')) continue;
    const height = Number.parseFloat(pinned);
    const lineHeight = resolved(block, blocks, 'line-height') ?? INHERITED_LEADING;
    const fontSize = resolved(block, blocks, 'font-size') ?? 'var(--fs-chat)';
    const lead = leading(lineHeight);
    const padding = verticalEdge(block, 'padding');
    const border = verticalEdge(block, 'border');
    if (!lead || padding == null || border == null) continue;
    for (const chat of CHAT_SIZES) {
      // --fs-code answers the Code row, so its largest size is the worst case for the box
      const size = fontPx(fontSize, chat, Math.max(...CODE_SIZES));
      if (size == null) continue;
      const needs = (lead.px ?? lead.ratio! * size) + padding + border;
      if (needs <= height + 0.01) continue;
      over.push(
        `${block.sheet} ${block.selector}: height ${height}px holds ${needs.toFixed(2)}px at Chat ${chat}` +
          ` (font-size ${fontSize}, line-height ${lineHeight}` +
          `${padding ? `, padding ${padding}px` : ''}${border ? `, border ${border}px` : ''})`,
      );
      break;
    }
  }
  return over;
}

/** Every stylesheet the app loads: app.css's areas, the task sheets, and the ones a module imports. */
const TASK_SHEETS: [string, string][] = [
  ...[...readFileSync(new URL('../../src/styles/tasks.css', import.meta.url), 'utf8').matchAll(/^@import '\.\/([\w/-]+\.css)';$/gm)].map(
    (m): [string, string] => [`src/styles/${m[1]}`, readFileSync(new URL(`../../src/styles/${m[1]}`, import.meta.url), 'utf8')],
  ),
];

export const ALL_SHEETS: [string, string][] = [
  ...appCssParts().map((part): [string, string] => [`src/styles/${part}`, readAppCssPart(part)]),
  ...TASK_SHEETS,
  ...['src/styles/agents.css', 'src/components/thread/prMonitor.module.css'].map((rel): [string, string] => [
    rel,
    readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'),
  ]),
];

/**
 * Where a rule narrows a shared box, both rules have to say the same thing: a `min-height` on the
 * shared rule clamps a `height` on the narrower one upwards, whatever its specificity, so the
 * narrower box silently grows to the shared floor (.btn-pill's 28px over a 26px action pill).
 */
export function boxesClampedByASharedFloor(sheets: [string, string][]): string[] {
  const blocks = blocksOf(sheets);
  const px = (block: Block, prop: 'height' | 'min-height') => {
    const value = block.decls.findLast(([p]) => p === prop)?.[1]?.trim();
    return value && /^[\d.]+px$/.test(value) ? Number.parseFloat(value) : null;
  };
  const clamped: string[] = [];
  for (const floor of blocks) {
    const min = px(floor, 'min-height');
    if (min == null) continue;
    for (const narrower of blocks) {
      const height = px(narrower, 'height');
      if (height == null || height >= min) continue;
      if (!reaches(compounds(floor.selector), compounds(narrower.selector))) continue;
      clamped.push(
        `${narrower.sheet} ${narrower.selector}: height ${height}px is clamped to ${min}px by ` +
          `${floor.selector} (${floor.sheet}); state a min-height here too`,
      );
    }
  }
  return clamped;
}
