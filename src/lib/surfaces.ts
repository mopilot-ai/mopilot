// The surface ladder: every themed surface derived from a background, a foreground and an accent, per mode.

/** Hex "#rgb" or "#rrggbb" (an alpha pair is ignored) → [r, g, b]. */
export function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const f =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * The foreground blended over the background at `a`. A negative `a` steps away from the foreground: a dark
 * theme's sidebar goes darker than its chat, a light theme's composer whiter. Channels clamp to 0-255.
 */
export function mix(bg: string, fg: string, a: number) {
  const [r1, g1, b1] = rgb(bg);
  const [r2, g2, b2] = rgb(fg);
  const m = (x: number, y: number) => Math.min(255, Math.max(0, Math.round(x + (y - x) * a)));
  return `rgb(${m(r1, r2)}, ${m(g1, g2)}, ${m(b1, b2)})`;
}

/** A hex color at opacity `a`. */
export function alpha(hex: string, a: number) {
  return `rgba(${rgb(hex).join(', ')}, ${a})`;
}

/**
 * MoPilot's surface hierarchy as steps from the chat background toward the foreground, [dark, light].
 * The sidebar and composer rise above the chat; borders, icons and placeholders step toward the text.
 * A negative step moves away from the text, making a light surface whiter.
 */
const LADDER: Record<string, readonly [number, number]> = {
  '--sidebar': [0.078, -0.017],
  '--sidebar-inactive': [0.078, -0.017],
  '--frame': [0, 0],
  '--frame-inactive': [0, 0],
  '--card-bg': [0, 0],
  '--code-bg': [0.05, 0.05],
  '--ctxbar-bg': [0.05, 0.035],
  '--surface': [0.05, 0.05],
  '--surface-2': [0.1, 0.1],
  '--surface-3': [0.14, 0.2],
  '--surface-border': [0.1, 0.1],
  '--composer-bg': [0.05, -0.017],
  '--composer-border': [0.15, 0.087],
  '--search-bg': [0.05, -0.006],
  '--row-active': [0.228, 0.087],
  '--control-active': [0.15, 0.1],
  '--control-hover': [0.075, 0.05],
  '--placeholder': [0.53, 0.477],
  '--icon': [0.795, 0.705],
  '--divider': [0.1, 0.1],
  '--card-border': [0.1, 0.1],
  '--bubble': [0.05, 0.05],
};

/** Secondary and muted text as the text color over the chat, [dark, light]. */
const TEXT_2: readonly [number, number] = [0.795, 0.705];
const TEXT_3: readonly [number, number] = [0.53, 0.477];

/** The surfaces, text steps and user bubble for a background and foreground in one mode. */
export function surfaceVars(bg: string, fg: string, dark: boolean): Record<string, string> {
  const ink = rgb(fg).join(', ');
  const step = (pair: readonly [number, number]) => (dark ? pair[0] : pair[1]);
  const v: Record<string, string> = {
    '--main': bg,
    '--text': fg,
    '--ink': ink,
    '--text-ui': `rgba(${ink}, 0.85)`,
    '--text-2': `rgba(${ink}, ${step(TEXT_2)})`,
    '--text-3': `rgba(${ink}, ${step(TEXT_3)})`,
    '--text-4': `rgba(${ink}, 0.35)`,
    '--text-step': `rgba(${ink}, 0.6)`,
    '--bubble-text': fg,
  };
  for (const [name, pair] of Object.entries(LADDER)) v[name] = mix(bg, fg, step(pair));
  // menus are opaque, the composer's surface (Claude's surface-popover)
  v['--menu-bg'] = v['--composer-bg'];
  return v;
}

/** `hex` with its HSL lightness and saturation raised by `dl` and `ds` (0-1), clamped. */
export function brighten(hex: string, dl: number, ds: number) {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l0 = (max + min) / 2;
  const d = max - min;
  const s0 = d === 0 ? 0 : d / (1 - Math.abs(2 * l0 - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const l = Math.min(1, l0 + dl);
  const s = Math.min(1, s0 + ds);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return `rgb(${[r1, g1, b1].map((v) => Math.round((v + m) * 255)).join(', ')})`;
}

/**
 * The accent and everything tinted by it. The brand accent fills the send button, which turns lighter on hover
 * (Claude's clay-emphasized to its clay: +8.4% lightness, +8.9% saturation). `interactive` colors toggles
 * and the focus ring (Claude's blue-450); it is the accent itself unless the palette names another.
 */
export function accentVars(accent: string, bg: string, fg: string, dark: boolean, interactive = accent): Record<string, string> {
  const hover = brighten(accent, 0.084, 0.089);
  return {
    '--accent': accent,
    '--accent-strong': hover,
    '--accent-soft': alpha(accent, dark ? 0.16 : 0.12),
    '--send-bg': accent,
    '--send-hover': hover,
    '--toggle-on': interactive,
    '--focus-ring': alpha(interactive, 0.6),
    '--badge-bg': mix(bg, accent, 0.14),
    '--badge-text': accent,
    '--diff-hunk': alpha(accent, 0.1),
  };
}
