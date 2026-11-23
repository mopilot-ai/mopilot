// The phone colour tokens: both palettes carry the same keys, every text pair is readable, and the hook follows the device scheme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const themePath = '../mobile/src/theme';
const uiPath = '../mobile/src/components/ui';
const { light, dark, themes, useTheme } = await import(themePath);
const { Heading } = await import(uiPath);

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('light and dark define the same tokens, each a #rrggbb colour', () => {
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort());
  assert.equal(themes.light, light);
  assert.equal(themes.dark, dark);
  for (const palette of [light, dark]) for (const value of Object.values(palette)) assert.match(value as string, /^#[0-9a-f]{6}$/);
});

// text on the surface it is drawn on, at the small sizes the phone uses (AA, 4.5:1)
const pairs: Array<[string, string]> = [
  ['ink', 'bg'],
  ['ink', 'surface'],
  ['ink', 'sunken'],
  ['ink', 'segment'],
  ['ink2', 'bg'],
  ['ink2', 'surface'],
  ['ink2', 'sunken'],
  ['ink3', 'bg'],
  ['ink3', 'surface'],
  ['ink3', 'sunken'],
  ['bad', 'bg'],
  ['surface', 'bad'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent', 'sunken'],
  ['accent', 'accentSoft'],
  ['accentInk', 'accent'],
  ['bad', 'surface'],
  ['bad', 'badSoft'],
  ['warn', 'warnSoft'],
  ['ok', 'okSoft'],
  ['info', 'infoSoft'],
  ['claude', 'claudeSoft'],
  ['codex', 'codexSoft'],
  ['ink', 'addBg'],
  ['ink', 'delBg'],
  ['ink2', 'addBg'],
  ['ink2', 'delBg'],
  ['termInk', 'termBg'],
  ['termInk', 'termBar'],
  ['termInk', 'termKey'],
  ['termMuted', 'termBg'],
];
for (const scheme of ['light', 'dark'] as const) {
  test(`every text pair has at least AA contrast (${scheme})`, () => {
    const palette = themes[scheme];
    for (const [fg, bg] of pairs)
      assert.ok(contrast(palette[fg], palette[bg]) >= 4.5, `${scheme} ${fg} on ${bg} ${contrast(palette[fg], palette[bg]).toFixed(2)}`);
  });
}

test('useTheme returns the palette of the device colour scheme', async () => {
  const seen: unknown[] = [];
  const Probe = () => {
    seen.push(useTheme());
    return createElement(Heading, null, 'x');
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const heading = () => JSON.parse(host.querySelector<HTMLElement>('[data-style]')!.dataset.style!).color;
    const colours: string[] = [];
    for (const isDark of [false, true]) {
      (globalThis as any).__phoneDark = isDark;
      await act(async () => root.render(createElement(Probe, { key: String(isDark) })));
      colours.push(heading());
    }
    assert.deepEqual(colours, [light.ink, dark.ink]);
    assert.equal(seen[0], light);
    assert.equal(seen.at(-1), dark);
  } finally {
    delete (globalThis as any).__phoneDark;
    await act(async () => root.unmount());
    host.remove();
  }
});
