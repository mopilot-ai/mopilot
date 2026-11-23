// Map canvas semantic tokens to MoPilot's preview colors without depending on Cursor's installed SDK.
const css = (name: string) => `var(--${name})`;
export const canvasTokens = {
  surface: { canvas: css('background') },
  bg: { editor: css('background'), chrome: css('muted'), elevated: css('card') },
  text: {
    primary: css('foreground'),
    secondary: css('muted-foreground'),
    tertiary: css('muted-foreground'),
    quaternary: css('muted-foreground'),
    link: css('blue'),
    onAccent: css('primary-foreground'),
  },
  stroke: { primary: css('border'), secondary: css('border'), tertiary: css('border'), focused: css('ring') },
  fill: { primary: css('secondary'), secondary: css('muted'), tertiary: css('muted'), quaternary: css('muted') },
  accent: { primary: css('primary'), control: css('primary'), controlHover: css('primary') },
  diff: { insertedLine: css('green'), removedLine: css('red'), stripAdded: css('green'), stripRemoved: css('red') },
  category: {
    gray: css('muted-foreground'),
    purple: css('purple'),
    green: css('green'),
    yellow: css('yellow'),
    cyan: css('blue'),
    pink: css('purple'),
    blue: css('blue'),
    orange: css('orange'),
    red: css('red'),
  },
};
export const canvasTokensLight = canvasTokens;
export const categoryPaletteDark = canvasTokens.category;
export const categoryPaletteLight = categoryPaletteDark;
export const colorPalette = categoryPaletteDark;
export const usageColorSequence = ['blue', 'green', 'purple', 'orange', 'yellow', 'red', 'cyan', 'pink', 'gray'] as const;
export const canvasPaletteDark = {
  foreground: canvasTokens.text.primary,
  foregroundSecondary: canvasTokens.text.secondary,
  foregroundTertiary: canvasTokens.text.tertiary,
  foregroundQuaternary: canvasTokens.text.quaternary,
  editor: canvasTokens.bg.editor,
  chrome: canvasTokens.bg.chrome,
  sidebar: canvasTokens.bg.chrome,
  elevated: canvasTokens.bg.elevated,
  fillPrimary: canvasTokens.fill.primary,
  fillSecondary: canvasTokens.fill.secondary,
  fillTertiary: canvasTokens.fill.tertiary,
  fillQuaternary: canvasTokens.fill.quaternary,
  strokePrimary: canvasTokens.stroke.primary,
  strokeSecondary: canvasTokens.stroke.secondary,
  strokeTertiary: canvasTokens.stroke.tertiary,
  strokeFocused: canvasTokens.stroke.focused,
  accent: canvasTokens.accent.primary,
  buttonBackground: canvasTokens.accent.control,
  buttonForeground: canvasTokens.text.onAccent,
  buttonHoverBackground: canvasTokens.accent.controlHover,
  link: canvasTokens.text.link,
  diffInsertedLine: canvasTokens.diff.insertedLine,
  diffRemovedLine: canvasTokens.diff.removedLine,
  diffStripAdded: canvasTokens.diff.stripAdded,
  diffStripRemoved: canvasTokens.diff.stripRemoved,
};
export const canvasPaletteLight = canvasPaletteDark;
export function toneColor(tone = 'neutral') {
  return (
    new Map([
      ['success', 'green'],
      ['added', 'green'],
      ['danger', 'red'],
      ['deleted', 'red'],
      ['warning', 'orange'],
      ['info', 'blue'],
      ['renamed', 'blue'],
    ]).get(tone) ?? 'muted-foreground'
  );
}
