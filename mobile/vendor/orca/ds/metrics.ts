// Orca's spacing, shape-radius and press-feedback scale (extracted from its theme file); the colours stay MoPilot's own, in src/theme.ts.

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

// Three shape types: one radius for what you tap, one for what holds content, and concentric nesting.
export const radii = {
  /** Everything you tap: buttons, icon buttons, text fields, pickers, segmented controls, key caps. */
  control: 12,
  /** Labels and round buttons: badges, chips, status pills, dots, avatars, and the composer's own buttons. */
  pill: 999,
  /** Everything that holds content: cards, groups, sheets, banners, code boxes, multi-line boxes, menus. */
  surface: 16,
  /** Layers floating over content: the composer box and dialogs. */
  floating: 24,
  /** Square icon tiles. */
  tile: 10,
  /** Inline code, check squares and tiny icons. */
  mark: 4,
} as const;

/** A shape inside another keeps its curve parallel to the parent's: the parent radius minus the gap between them. */
export function concentricRadius(parentRadius: number, inset: number): number {
  return Math.max(radii.mark, parentRadius - inset);
}

// One press and one disabled look for every control.
export const feedback = {
  pressedOpacity: 0.7,
  disabledOpacity: 0.4,
} as const;
