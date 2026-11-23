// The surface ladder (src/lib/surfaces.ts), the one default palette (shared/defaultPalette.mjs) and the color guards
// (lint/rules/literal-color.grit, lint/rules/inline-color.grit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';
import { accentVars, alpha, brighten, mix, rgb, surfaceVars } from '../src/lib/surfaces.ts';
import { DEFAULT_PALETTE, defaultPalette } from '../shared/defaultPalette.mjs';
import { hexOf } from './support/palette.ts';

/** Relative luminance-ish brightness of an `rgb(r, g, b)` or hex value, enough to order surfaces. */
const level = (v: string) => {
  const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(v);
  const [r, g, b] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : rgb(v);
  return r + g + b;
};

test('colors parse from short and long hex, and an alpha pair is ignored', () => {
  assert.deepEqual(rgb('#abc'), [170, 187, 204]);
  assert.deepEqual(rgb('#102030'), [16, 32, 48]);
  assert.deepEqual(rgb('#10203080'), [16, 32, 48]);
  assert.equal(alpha('#102030', 0.5), 'rgba(16, 32, 48, 0.5)');
});

test('mix blends toward the foreground, steps away from it when negative, and clamps each channel', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), 'rgb(128, 128, 128)');
  assert.equal(mix('#808080', '#ffffff', -0.5), 'rgb(65, 65, 65)');
  assert.equal(mix('#fafafa', '#000000', -0.5), 'rgb(255, 255, 255)');
  assert.equal(mix('#050505', '#ffffff', -0.5), 'rgb(0, 0, 0)');
});

test('The surface ladder: the sidebar and composer rise above the chat, cards sit on it, menus are opaque', () => {
  for (const dark of [true, false]) {
    const { bg, fg } = defaultPalette(dark);
    const v = surfaceVars(bg, fg, dark);
    const mode = dark ? 'dark' : 'light';
    assert.equal(v['--main'], bg);
    assert.equal(v['--text'], fg);
    assert.equal(v['--bubble-text'], fg);
    assert.equal(v['--ink'], rgb(fg).join(', '));
    // raised: lighter in dark, whiter in light, for the sidebar and composer
    assert.ok(level(v['--sidebar']) > level(bg), `${mode} sidebar above the chat`);
    assert.ok(level(v['--composer-bg']) > level(bg), `${mode} composer above the chat`);
    // the window band and cards are the chat's own surface
    assert.equal(
      v['--frame'],
      v['--main'].replace(/^#(..)(..)(..)$/, (_, r, g, b) => `rgb(${[r, g, b].map((x) => parseInt(x, 16)).join(', ')})`),
    );
    assert.equal(v['--card-bg'], v['--frame']);
    // the user bubble stands out from the chat it sits in
    assert.notEqual(v['--bubble'], bg);
    assert.equal(v['--menu-bg'], v['--composer-bg'], `${mode} menus are opaque`);
  }
});

test('every tint of the accent follows it', () => {
  const v = accentVars('#d6764f', '#262522', '#f3f1ea', true);
  for (const name of ['--accent', '--send-bg', '--toggle-on', '--badge-text']) assert.equal(v[name], '#d6764f', name);
  assert.equal(v['--accent-soft'], 'rgba(214, 118, 79, 0.16)');
  assert.equal(accentVars('#d6764f', '#faf9f5', '#1f1e1b', false)['--accent-soft'], 'rgba(214, 118, 79, 0.12)');
  assert.equal(v['--focus-ring'], 'rgba(214, 118, 79, 0.6)');
  assert.equal(v['--diff-hunk'], 'rgba(214, 118, 79, 0.1)');
  // hover and strong turn lighter in both modes, as Claude's send button goes from clay-emphasized to clay
  assert.ok(level(v['--send-hover']) > level('#d6764f'));
  assert.ok(level(accentVars('#d6764f', '#faf9f5', '#1f1e1b', false)['--send-hover']) > level('#d6764f'));
  assert.equal(brighten('#c6613f', 0.084, 0.089), 'rgb(217, 120, 87)');
  assert.equal(brighten('#808080', 0, 0), 'rgb(128, 128, 128)', 'a gray keeps no hue');
  assert.equal(brighten('#ffffff', 0.5, 0.5), 'rgb(255, 255, 255)', 'clamped');
  for (const hex of ['#a0c040', '#40c040', '#40a0c0', '#4040c0', '#c040c0'])
    assert.equal(brighten(hex, 0, 0), `rgb(${rgb(hex).join(', ')})`, hex);
  // toggles and the focus ring take the interactive color when the palette has one
  const blue = accentVars('#c6613f', '#151515', '#f0efec', true, '#2a78d6');
  assert.equal(blue['--toggle-on'], '#2a78d6');
  assert.equal(blue['--focus-ring'], 'rgba(42, 120, 214, 0.6)');
  assert.equal(blue['--send-bg'], '#c6613f');
  assert.ok(level(v['--badge-bg']) > level('#262522') && level(v['--badge-bg']) < level('#d6764f'));
});

test('the default palette is one frozen copy per mode', () => {
  assert.equal(defaultPalette(true), DEFAULT_PALETTE.dark);
  assert.equal(defaultPalette(false), DEFAULT_PALETTE.light);
  assert.ok(Object.isFrozen(DEFAULT_PALETTE) && Object.isFrozen(DEFAULT_PALETTE.dark) && Object.isFrozen(DEFAULT_PALETTE.light));
  for (const pal of [DEFAULT_PALETTE.dark, DEFAULT_PALETTE.light])
    for (const value of Object.values(pal)) assert.match(value, /^#[0-9a-f]{6}$/);
});

/** Every source file under `dir` with one of `exts`. */
const sources = (dir: string, exts: RegExp): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p, exts);
    return exts.test(e.name) ? [p] : [];
  });

test('no source copies the default palette: each reads shared/defaultPalette.mjs', () => {
  const hexes = new Set(Object.values(DEFAULT_PALETTE).flatMap((p) => Object.values(p).map((h) => h.toLowerCase())));
  const offenders: string[] = [];
  for (const file of [...sources('src', /\.(?:tsx?|css)$/), ...sources('electron', /\.c?js$/)]) {
    if (file === path.join('src', 'styles', 'tokens.css')) continue; // the first paint, written from the ladder
    const text = fs.readFileSync(file, 'utf8').toLowerCase();
    for (const hex of hexes) if (text.includes(hex)) offenders.push(`${file}: ${hex}`);
  }
  assert.deepEqual(offenders, []);
});

test('tokens.css paints first with the values the ladder derives at runtime', () => {
  const css = fs.readFileSync('src/styles/tokens.css', 'utf8');
  const block = (selector: string) => {
    const start = css.indexOf(selector);
    return css.slice(start, css.indexOf('}', start));
  };
  const declared = (text: string, name: string) => new RegExp(`\\s${name}: ([^;]+);`).exec(text)?.[1];
  for (const [selector, dark] of [
    ["[data-theme='dark'] {", true],
    ["[data-theme='light'] {", false],
  ] as const) {
    const { bg, fg, accent, interactive } = defaultPalette(dark);
    const text = block(selector);
    for (const [name, value] of Object.entries({ ...surfaceVars(bg, fg, dark), ...accentVars(accent, bg, fg, dark, interactive) }))
      assert.equal(declared(text, name), hexOf(value), `${selector} ${name}`);
  }
});

/** The `[tag]` warnings Biome reports for each input, written as `<i><ext>` under src/styles in one run. */
const warnings = (tag: string, ext: string, inputs: readonly string[]) => {
  const files = Object.fromEntries(inputs.map((input, i) => [`src/styles/f${i}${ext}`, input]));
  const { diagnostics: found } = lintFixtures(files);
  return inputs.map(
    (_, i) =>
      found.filter((d) => {
        if (!d.message.includes(`[${tag}]`)) return false;
        assert.ok(d.location?.path, `Missing path for ${tag} diagnostic`);
        return d.location.path === `src/styles/f${i}${ext}`;
      }).length,
  );
};

/** Each input's expected warning count against what the rule reports. */
const expectWarnings = (tag: string, ext: string, cases: readonly (readonly [string, number])[]) => {
  const counts = warnings(
    tag,
    ext,
    cases.map(([input]) => input),
  );
  cases.forEach(([input, expected], i) => assert.equal(counts[i], expected, input));
};

test('a literal color in a stylesheet warns, while tokens and tints of them do not', () => {
  expectWarnings('literal-color', '.css', [
    ['.a { color: #fff; }', 1],
    ['.a { background: #26252280; }', 1],
    ['.a { background: rgba(0, 0, 0, 0.5); }', 1],
    ['.a { color: hsl(20 60% 50%); }', 1],
    ['.a { box-shadow: 0 1px 2px rgba(0,0,0,.2), inset 0 0 0 1px var(--divider); }', 1],
    ['.a { color: var(--accent); background: var(--surface); }', 0],
    ['.a { background: rgba(var(--ink), 0.08); }', 0],
    ['.a { background: color-mix(in srgb, var(--accent) 16%, transparent); }', 0],
    ['.a { color: transparent; fill: currentColor; }', 0],
    [".a::before { content: '#'; }", 0],
    ['.a { background: linear-gradient(#fff, transparent); }', 1],
    ['.a { mask: url(#fade); }', 0],
  ]);
});

test('a color string in renderer code warns, while variables and other strings do not', () => {
  expectWarnings('inline-color', '.tsx', [
    ["export const a = '#ffffff';", 1],
    ['export const b = "rgba(0, 0, 0, 0.4)";', 1],
    ['export const C = () => <svg><path fill="#d97757" /></svg>;', 1],
    ["export const D = () => <span style={{ color: '#abc' }} />;", 1],
    ["export const e = 'var(--accent)';", 0],
    ["export const f = 'PR #12 is open';", 0],
    ['export const G = () => <svg><path fill="currentColor" /></svg>;', 0],
  ]);
});

test('the color guards are registered, exempt the theme data, and are seeded in the ratchet', () => {
  const biome = JSON.parse(fs.readFileSync('biome.json', 'utf8'));
  const baseline = JSON.parse(fs.readFileSync('lint/baseline.json', 'utf8'));
  const override = (rule: string) => biome.overrides.find((o: { plugins?: string[] }) => o.plugins?.includes(`./lint/rules/${rule}.grit`));
  assert.deepEqual(override('literal-color')?.includes, ['src/**/*.css', '!src/styles/tokens.css']);
  assert.deepEqual(override('inline-color')?.includes, [
    'src/**',
    '!src/**/*.css',
    '!src/lib/themes.ts',
    '!src/lib/highlightEngine.ts',
    '!src/lib/brandColors.ts',
    // drawn into a web page's own document, where the app's tokens do not exist
    '!src/lib/annotateOverlay.ts',
  ]);
  // lintRatchet.test.ts checks every configured rule is in the baseline; these files must stay out of it
  assert.ok(!('src/styles/tokens.css' in baseline.rules['plugin/literal-color']));
  assert.ok(!('src/lib/appearance.ts' in baseline.rules['plugin/inline-color']), 'appearance.ts reads the palette and themes.ts');
});
