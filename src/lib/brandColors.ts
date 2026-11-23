// Colors that are data, not theme: other products' marks, language badges, the avatar and sketch-pen palettes.
// They keep their values under every theme preset and mode on purpose, so they live here, exempt from the color
// guards (lint/rules/inline-color.grit, docs/code-quality.md#colors), instead of scattered through components.

/** A language's badge color and its short label, as the official file lists draw them. */
export const LANG_BADGES: Readonly<Record<string, readonly [color: string, label: string]>> = {
  python: ['#4b8bbe', 'py'],
  typescript: ['#3178c6', 'ts'],
  tsx: ['#3178c6', 'tsx'],
  javascript: ['#e8c32b', 'js'],
  jsx: ['#e8c32b', 'jsx'],
  json: ['#a1a1a1', '{}'],
  markdown: ['#7a9cc6', 'md'],
  rust: ['#dea584', 'rs'],
  go: ['#00add8', 'go'],
  css: ['#563d7c', 'css'],
  html: ['#e34c26', '<>'],
  bash: ['#89e051', 'sh'],
  yaml: ['#cb171e', 'yml'],
  toml: ['#9c4221', 'tml'],
  swift: ['#f05138', 'sw'],
  java: ['#b07219', 'jv'],
};

/** The Python logo's two blues and yellows. */
export const PYTHON_LOGO = { blue: '#3776ab', yellow: '#ffd43b' } as const;

/** Profile avatars without a picture: one of these, picked from the email so a person keeps their color. */
export const AVATAR_COLORS: readonly string[] = ['#3e7d68', '#5b6fd6', '#b0569a', '#c27a2c', '#4a8db7', '#8a6bd1'];

/** The sketch pad's paper and pens: it draws an image to attach, so its colors are the image's, not the theme's. */
export const SKETCH = { paper: '#ffffff', ink: '#111111', pens: ['#111111', '#e5534b', '#3a7ff7', '#2fb36b'] } as const;

/** The harness marks: Claude Code's rounded square and asterisk, MoPilot's own >_ tile. */
export const MARKS = {
  claude: { tile: '#d97757', glyph: '#ffffff' },
  mopilot: { tile: '#1f1f1f', edge: '#ffffff', glyph: '#ef8b57' },
} as const;

/** The Skills catalog's gem: a fixed gradient and its facet lines. */
export const SKILL_GEM = { stops: ['#ffb86b', '#f472b6', '#818cf8'], facets: 'rgba(255,255,255,.55)' } as const;
