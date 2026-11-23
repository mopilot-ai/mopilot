// The type scale (src/styles/tokens.css) and its guard (lint/rules/type-scale.grit): every step resolves to a
// size at the default and at both ends of the Chat and Code font-size settings, the leading ratios keep their
// ratio at every size, and a literal pixel font-size or line-height in a stylesheet warns while the scale's
// tokens, a var() fallback and calc() do not. The `font` shorthand carries a size too, so it warns as well.
import { test } from 'node:test';
import { CHAT_FONT_SIZES } from '../shared/zoom.mjs';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';
import fs from 'node:fs';
import { appearanceVars } from '../src/lib/appearance.ts';
import { LINTED } from '../scripts/lint-ratchet.mjs';

const read = (rel: string) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** The custom properties `:root` declares in tokens.css (its first block; the theme blocks that follow hold colors). */
function rootTokens(): Map<string, string> {
  const css = read('src/styles/tokens.css');
  const start = css.indexOf(':root {');
  const block = css.slice(start, css.indexOf('\n}', start));
  return new Map([...block.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()] as [string, string]));
}

/** How a step is written: a fixed pixel size, or a ratio that multiplies --fs-chat itself. */
const STEP_FORM = /^calc\(var\(--fs-chat\) \* ([\d.]+)\)$/;

/** A size token as pixels: a step multiplies --fs-chat, so it is the same size wherever it lands. */
function px(value: string, chatPx: number): number {
  const fixed = /^([\d.]+)px$/.exec(value);
  if (fixed) return Number(fixed[1]);
  const ratio = STEP_FORM.exec(value);
  if (ratio) return Number(ratio[1]) * chatPx;
  throw new Error(`not a size: ${value}`);
}

/** The sizes an Appearance row offers, read from the row itself so this test moves with the setting. */
function options(title: string): number[] {
  const tsx = read('src/components/pages/settings/Appearance.tsx');
  const row = tsx.slice(tsx.indexOf(`title="${title}"`));
  const list = /options=\{\[([^\]]*)\]/.exec(row);
  assert.ok(list, `${title}: no options list in Appearance.tsx`);
  const sizes = [...list[1].matchAll(/'(\d+)'/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 1, `${title}: no sizes in Appearance.tsx`);
  return sizes;
}

/** The scale, smallest first; --fs-code is the monospace root beside it. */
const SCALE = ['--fs-micro', '--fs-small', '--fs-ui', '--fs-chat', '--fs-lg', '--fs-title', '--fs-display'];
/** What each step is today, hand-written in the stylesheets: the merge stays within half a pixel of it. */
const SHIPPING = [11.5, 12, 13, 14, 16, 22, 28];
const CHAT = options('Chat font size');
const CODE = options('Code font size');

test('the Chat and Code settings offer the ranges the scale is built for', () => {
  assert.deepEqual([CHAT.at(0), CHAT.at(-1)], [12, 18]);
  // the sizes the move from the old font size shortcuts leaves alone (shared/zoom.mjs legacyZoomPatch)
  assert.deepEqual(CHAT, CHAT_FONT_SIZES);
  assert.deepEqual([CODE.at(0), CODE.at(-1)], [11, 14]);
});

test('every step of the scale resolves to a size, in order, at the default and at both ends of the settings', () => {
  const declared = rootTokens();
  for (const name of [...SCALE, '--fs-code', '--lh-prose', '--lh-code']) assert.ok(declared.has(name), `${name} is not declared`);
  // only the two settings and the fixed display step are pixels; the steps are calc() ratios of --fs-chat
  assert.deepEqual(
    [...SCALE, '--fs-code'].filter((name) => /px$/.test(declared.get(name) ?? '')),
    ['--fs-chat', '--fs-display', '--fs-code'],
  );
  for (const chat of CHAT) {
    for (const code of CODE) {
      const vars = appearanceVars({ codeFontSize: code } as never, chat, false);
      assert.equal(vars['--fs-chat'], `${chat}px`);
      assert.equal(vars['--fs-code'], `${code}px`);
      const chatPx = px(vars['--fs-chat'], chat);
      const sizes = SCALE.map((name) => px(name === '--fs-chat' ? vars['--fs-chat'] : (declared.get(name) as string), chatPx));
      for (const [i, size] of sizes.entries()) assert.ok(Number.isFinite(size) && size > 0, `${SCALE[i]} at ${chat}px: ${size}`);
      // the body steps rise with the setting; --fs-display is fixed, so it is left out of the order
      const body = sizes.slice(0, -1);
      assert.deepEqual(
        [...body].sort((a, b) => a - b),
        body,
        `${chat}px: ${body.join(', ')}`,
      );
      assert.equal(px(declared.get('--fs-display') as string, chatPx), 28);
      assert.equal(px(vars['--fs-code'], chatPx), code);
      if (chat === 14)
        for (const [i, size] of sizes.entries()) assert.ok(Math.abs(size - SHIPPING[i]) <= 0.5, `${SCALE[i]}: ${size} vs ${SHIPPING[i]}`);
    }
  }
  assert.throws(() => px('1.6', 14), /not a size: 1\.6/);
});

test('every step multiplies --fs-chat itself, so steps do not multiply each other where they nest', () => {
  const declared = rootTokens();
  // `em` is a ratio of the *inherited* size, and the app nests sized elements (a .btn-pill inside a
  // .config-warning): two `em` steps inside each other would multiply, landing --fs-ui under --fs-small on
  // 11.1px instead of 13px. A calc() step resolves against the root's --fs-chat wherever it lands.
  for (const name of [...SCALE, '--fs-code']) {
    const value = declared.get(name) as string;
    assert.ok(
      /^[\d.]+px$/.test(value) || STEP_FORM.test(value),
      `${name} must be a fixed size or calc(var(--fs-chat) * <ratio>): ${value}`,
    );
    assert.doesNotMatch(value, /[\d.](?:em|ex|ch|rem|lh|%)/, `${name} must not be relative to the inherited size: ${value}`);
  }
  // a step is the same size however deeply it nests: 0.929 of 14px, not 0.929 of 0.857 of 14px
  const ratio = (name: string) => Number(STEP_FORM.exec(declared.get(name) as string)?.[1]);
  assert.equal(Math.round(ratio('--fs-ui') * 14 * 100) / 100, 13.01);
  assert.ok(Math.abs(ratio('--fs-ui') * ratio('--fs-small') * 14 - 13) > 1.5, 'the em form this replaces shifted by more than 1.5px');
});

/** The leading each ratio replaces, pinned in pixels on the surface the setting reaches today. */
const PINNED = {
  // .assistant-message (src/styles/app/thread-messages.css): var(--fs-chat) / 22.75px
  '--lh-prose': { px: 22.75, sizes: CHAT },
  // .term-box (src/styles/app/thread-tool-output.css): var(--fs-code) / 18px
  '--lh-code': { px: 18, sizes: CODE },
};
const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

test('the leading ratios are unitless, so the leading keeps its ratio across the whole setting range', () => {
  const declared = rootTokens();
  for (const [name, { px: pinned, sizes }] of Object.entries(PINNED)) {
    const value = declared.get(name) as string;
    assert.match(value, /^\d+(?:\.\d+)?$/, `${name} must be unitless: ${value}`);
    const ratio = Number(value);
    assert.ok(ratio > 1.2 && ratio <= 2, `${name}: ${ratio}`);
    assert.ok(spread(sizes.map((size) => (ratio * size) / size)) < 1e-9, `${name} must not depend on the size`);
    // the pixel leading it replaces loses the ratio as the size rises: 1.64 at 11px, 1.29 at 14px for code
    assert.ok(spread(sizes.map((size) => pinned / size)) > 0.2, `${name}: ${pinned}px holds its ratio across ${sizes.join('/')}`);
  }
});

/** The `[tag]` warnings Biome reports for `input`, written as `name` under src (where both rules apply). */
const warnings = (tag: string, name: string, input: string) => {
  const report = lintFixtures({ [`src/styles/${name}`]: input });
  return report.diagnostics.filter((d) => d.message.includes(`[${tag}]`)).length;
};
const hits = (input: string) => warnings('type-scale', 'type.css', input);
const inlineHits = (input: string) => warnings('inline-type-size', 'Inline.tsx', input);

test('a literal pixel size warns, in font-size, line-height or the font shorthand, while the tokens do not', () => {
  for (const [input, expected] of [
    ['.a { font-size: 13px; }', 1],
    ['.a { line-height: 18px; }', 1],
    ['.a { font-size: 12px; line-height: 19px; }', 2],
    ['@media (max-width: 600px) { .a { font-size: 11.5px; } }', 1],
    ['.a { font-size: var(--fs-ui); line-height: var(--lh-prose); }', 0],
    ['.a { font-size: var(--fs-code, 12px); }', 0],
    ['.a { font-size: calc(var(--fs-chat) - 1px); }', 0],
    ['.a { font-size: 0.857em; line-height: 1.55; }', 0],
    ['.a { padding: 12px 13px; width: 18px; min-height: 22px; }', 0],
    // the `font` shorthand carries a size and a leading past a font-size rule
    ['.a { font: 12px/1.6 var(--font-mono); }', 1],
    ['.a { font: var(--fs-ui)/var(--lh-prose) var(--font-mono); }', 0],
    ['.a { font: inherit; font-family: var(--font-mono); font-weight: 500; }', 0],
  ] as const)
    assert.equal(hits(input), expected, input);
});

test('a pixel type size in a JSX style object warns, while a token, a unitless leading and a prefs value do not', () => {
  for (const [input, expected] of [
    ['export const A = () => <p style={{ fontSize: 13 }}>x</p>;', 1],
    ["export const B = () => <p style={{ fontSize: '13px' }}>x</p>;", 1],
    ["export const C = () => <p style={{ lineHeight: '18px' }}>x</p>;", 1],
    ["export const D = () => <p style={{ color: 'red', fontSize: 11.5 }}>x</p>;", 1],
    ["export const E = () => <p style={{ fontSize: 'var(--fs-ui)' }}>x</p>;", 0],
    // React leaves a numeric lineHeight unitless, so it already follows the size it lands on
    ['export const F = () => <p style={{ lineHeight: 1.45 }}>x</p>;', 0],
    ['export const G = () => <p style={{ flex: 1, padding: 12 }}>x</p>;', 0],
    // the Chat and Code settings themselves are numbers, not type sizes in a style object
    ['export const H = { fontSize: 14, codeFontSize: 12 };', 0],
    ['export const I = (set: (p: unknown) => void) => set({ fontSize: 14 });', 0],
    // a glyph sized from its own box, not from the Chat setting (src/components/accounts/presentation.tsx)
    ['export const J = ({ size }: { size: number }) => <span style={{ fontSize: size * 0.44 }}>x</span>;', 0],
  ] as const)
    assert.equal(inlineHits(input), expected, input);
});

test('the guard covers the stylesheets and exempts tokens.css, where the scale itself is written', () => {
  const biome = JSON.parse(read('biome.json'));
  const baseline = JSON.parse(read('lint/baseline.json'));
  const override = biome.overrides.find((o: { plugins?: string[] }) => o.plugins?.includes('./lint/rules/type-scale.grit'));
  assert.ok(override, 'register lint/rules/type-scale.grit in biome.json');
  // every stylesheet under src, not only src/styles: a component may keep its own (src/components/thread/prMonitor.module.css)
  assert.deepEqual(override.includes, ['src/**/*.css', '!src/styles/tokens.css']);
  assert.ok(LINTED.test('src/components/thread/prMonitor.module.css'));
  // the rule reads CSS, which Biome lints only with its CSS linter on (its own rules stay off: `preset: "none"`)
  assert.equal(biome.css.linter.enabled, true);
  // the ratchet counts a stylesheet's warnings, so the pre-commit hook reports a new one
  assert.ok(LINTED.test('src/styles/app/thread-messages.css'));
  assert.ok(baseline.rules['plugin/type-scale'], 'seed the rule in lint/baseline.json: npm run lint:ratchet -- --update');
  assert.ok(!('src/styles/tokens.css' in baseline.rules['plugin/type-scale']));
  // the TSX guard: a pixel type size a stylesheet cannot see. It starts at zero, so its entry is `{}`
  const inline = biome.overrides.find((o: { plugins?: string[] }) => o.plugins?.includes('./lint/rules/inline-type-size.grit'));
  assert.ok(inline, 'register lint/rules/inline-type-size.grit in biome.json');
  assert.deepEqual(inline.includes, ['src/**']);
  assert.deepEqual(baseline.rules['plugin/inline-type-size'], {});
});
