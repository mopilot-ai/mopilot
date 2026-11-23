// The default palette's derived tokens as tokens.css writes them (hex for opaque colors), for tests that read computed styles.
import { accentVars, surfaceVars } from '../../src/lib/surfaces.ts';
import { defaultPalette } from '../../shared/defaultPalette.mjs';

/** An `rgb(r, g, b)` value as `#rrggbb`; anything else as it is. */
export const hexOf = (value: string) => {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(value);
  return m ? `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}` : value;
};

/** Token `name` (e.g. '--surface', '--accent') for the default palette in `theme`, as tokens.css declares it. */
export function paletteToken(theme: 'dark' | 'light' | string, name: string): string {
  const dark = theme === 'dark';
  const { bg, fg, accent, interactive } = defaultPalette(dark);
  const value = { ...surfaceVars(bg, fg, dark), ...accentVars(accent, bg, fg, dark, interactive) }[name];
  if (value === undefined) throw new Error(`no derived token ${name}`);
  return hexOf(value);
}
