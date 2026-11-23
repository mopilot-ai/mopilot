// Settings → Appearance as CSS variables: accent colors, fonts and theme surfaces derived from a palette.

import { ownTable } from '../../shared/ownTable.mjs';
import { defaultPalette } from '../../shared/defaultPalette.mjs';
import { ACCENT_CHOICES, themeById } from './themes';
import { accentVars, surfaceVars } from './surfaces';
import { normalizeZoomLevel, zoomFactorOf } from '../../shared/zoom.mjs';
import type { Prefs } from '../../shared/model/store';

const ACCENT_COLORS: Record<string, string> = ownTable(Object.fromEntries(ACCENT_CHOICES.map((a) => [a.value, a.color])));
const FONTS: Record<string, string> = ownTable({
  serif: 'ui-serif, "New York", Georgia, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
});
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function appearanceVars(
  p: Pick<Prefs, 'codeFontSize' | 'themePreset' | 'bgOverride' | 'fgOverride' | 'accent' | 'fontFamily' | 'zoomLevel'>,
  fontSize: number,
  dark: boolean,
): Record<string, string> {
  const v: Record<string, string> = { '--fs-chat': `${fontSize}px`, '--fs-code': `${p.codeFontSize}px` };
  // the page zoom main applies (electron/app/zoom.cjs), for the title bar to keep clear of the window buttons, which don't zoom
  v['--zoom'] = String(zoomFactorOf(normalizeZoomLevel(p.zoomLevel)));
  const preset = themeById(p.themePreset);
  // a preset without this mode's palette falls back to the default one, as a mode with no preset does
  const pal = (preset ? (dark ? preset.dark : preset.light) : null) ?? defaultPalette(dark);
  const bg = p.bgOverride ?? pal.bg;
  const fg = p.fgOverride ?? pal.fg;
  // a named accent or a custom hex; anything else (a name this build lacks) keeps the palette's, as the tints derive from it
  const picked = p.accent ? (ACCENT_COLORS[p.accent] ?? p.accent) : null;
  const accent = picked && HEX.test(picked) ? picked : pal.accent;
  // toggles and focus rings follow a picked accent; otherwise the palette's own interactive color, if it has one
  const own = 'interactive' in pal ? pal.interactive : undefined;
  const interactive = accent === pal.accent && own ? own : accent;
  Object.assign(v, surfaceVars(bg, fg, dark), accentVars(accent, bg, fg, dark, interactive));
  if (p.fontFamily) v['--font-sans'] = FONTS[p.fontFamily] ?? `"${p.fontFamily}", -apple-system, BlinkMacSystemFont, sans-serif`;
  return v;
}
