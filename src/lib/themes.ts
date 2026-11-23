// The Codex theme presets (each theme's dark and light palettes, measured from the official app) and the named accents.

/** UI palettes for the Codex themes (background, foreground, accent), measured from the official app. */
export interface Palette {
  bg: string;
  fg: string;
  accent: string;
}
export interface ThemePreset {
  id: string;
  label: string;
  dark?: Palette;
  light?: Palette;
}
export const THEMES: ThemePreset[] = [
  {
    id: 'absolutely',
    label: 'Absolutely',
    dark: { bg: '#2D2D2B', fg: '#F9F9F7', accent: '#CC7D5E' },
    light: { bg: '#F9F9F7', fg: '#2D2D2B', accent: '#CC7D5E' },
  },
  { id: 'ayu', label: 'Ayu', dark: { bg: '#10141C', fg: '#BFBDB6', accent: '#E6B450' } },
  {
    id: 'catppuccin',
    label: 'Catppuccin',
    dark: { bg: '#1E1E2E', fg: '#CDD6F4', accent: '#CBA6F7' },
    light: { bg: '#EFF1F5', fg: '#4C4F69', accent: '#8839EF' },
  },
  { id: 'dracula', label: 'Dracula', dark: { bg: '#282A36', fg: '#F8F8F2', accent: '#FF79C6' } },
  {
    id: 'everforest',
    label: 'Everforest',
    dark: { bg: '#2D353B', fg: '#D3C6AA', accent: '#A7C080' },
    light: { bg: '#FDF6E3', fg: '#5C6A72', accent: '#93B259' },
  },
  {
    id: 'github',
    label: 'GitHub',
    dark: { bg: '#0D1117', fg: '#E6EDF3', accent: '#1F6FEB' },
    light: { bg: '#FFFFFF', fg: '#1F2328', accent: '#0969DA' },
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox',
    dark: { bg: '#282828', fg: '#EBDBB2', accent: '#458588' },
    light: { bg: '#FBF1C7', fg: '#3C3836', accent: '#458588' },
  },
  {
    id: 'linear',
    label: 'Linear',
    dark: { bg: '#0F0F11', fg: '#E3E4E6', accent: '#606ACC' },
    light: { bg: '#FCFCFD', fg: '#1B1B1B', accent: '#5E6AD2' },
  },
  { id: 'lobster', label: 'Lobster', dark: { bg: '#111827', fg: '#E4E4E7', accent: '#FF5C5C' } },
  { id: 'material', label: 'Material', dark: { bg: '#212121', fg: '#EEFFFF', accent: '#80CBC4' } },
  { id: 'matrix', label: 'Matrix', dark: { bg: '#040805', fg: '#B8FFCA', accent: '#1EFF5A' } },
  { id: 'monokai', label: 'Monokai', dark: { bg: '#272822', fg: '#F8F8F2', accent: '#99947C' } },
  { id: 'night-owl', label: 'Night Owl', dark: { bg: '#011627', fg: '#D6DEEB', accent: '#44596B' } },
  { id: 'nord', label: 'Nord', dark: { bg: '#2E3440', fg: '#D8DEE9', accent: '#88C0D0' } },
  {
    id: 'notion',
    label: 'Notion',
    dark: { bg: '#191919', fg: '#D9D9D8', accent: '#3183D8' },
    light: { bg: '#FFFFFF', fg: '#37352F', accent: '#3183D8' },
  },
  { id: 'og', label: 'OG', dark: { bg: '#343541', fg: '#D1D5DB', accent: '#10A37F' } },
  {
    id: 'one',
    label: 'One',
    dark: { bg: '#282C34', fg: '#ABB2BF', accent: '#4D78CC' },
    light: { bg: '#FAFAFA', fg: '#383A42', accent: '#526FFF' },
  },
  { id: 'oscurange', label: 'Oscurange', dark: { bg: '#0B0B0F', fg: '#E6E6E6', accent: '#F9B98C' } },
  { id: 'proof', label: 'Proof', light: { bg: '#F5F3ED', fg: '#2F312D', accent: '#3D755D' } },
  {
    id: 'raycast',
    label: 'Raycast',
    dark: { bg: '#101010', fg: '#FEFEFE', accent: '#FF6363' },
    light: { bg: '#FFFFFF', fg: '#030303', accent: '#FF6363' },
  },
  {
    id: 'rose-pine',
    label: 'Rose Pine',
    dark: { bg: '#232136', fg: '#E0DEF4', accent: '#EA9A97' },
    light: { bg: '#FAF4ED', fg: '#575279', accent: '#D7827E' },
  },
  { id: 'sentry', label: 'Sentry', dark: { bg: '#2D2935', fg: '#E6DFF9', accent: '#7055F6' } },
  {
    id: 'solarized',
    label: 'Solarized',
    dark: { bg: '#002B36', fg: '#839496', accent: '#D30102' },
    light: { bg: '#FDF6E3', fg: '#657B83', accent: '#B58900' },
  },
  { id: 'temple', label: 'Temple', dark: { bg: '#02120C', fg: '#C7E6DA', accent: '#E4F222' } },
  { id: 'tokyo-night', label: 'Tokyo Night', dark: { bg: '#1A1B26', fg: '#A9B1D6', accent: '#3D59A1' } },
  {
    id: 'vercel',
    label: 'Vercel',
    dark: { bg: '#000000', fg: '#EDEDED', accent: '#006EFE' },
    light: { bg: '#FFFFFF', fg: '#171717', accent: '#006AFF' },
  },
  {
    id: 'vs-code-plus',
    label: 'VS Code Plus',
    dark: { bg: '#1E1E1E', fg: '#D4D4D4', accent: '#007ACC' },
    light: { bg: '#FFFFFF', fg: '#000000', accent: '#007ACC' },
  },
  {
    id: 'xcode',
    label: 'Xcode',
    dark: { bg: '#1F1F24', fg: '#FFFFFF', accent: '#5482FF' },
    light: { bg: '#FFFFFF', fg: '#000000', accent: '#0E0EFF' },
  },
];
export const themeById = (id: string | null | undefined) => THEMES.find((t) => t.id === id) ?? null;

/** The named accents besides the default (the palette's clay, shared/defaultPalette.mjs). */
export const ACCENT_CHOICES: readonly { value: string; label: string; color: string }[] = [
  { value: 'purple', label: 'Purple', color: '#9b6dff' },
  { value: 'green', label: 'Green', color: '#2fb36b' },
  { value: 'orange', label: 'Orange', color: '#f0883e' },
  { value: 'pink', label: 'Pink', color: '#e5609d' },
];
