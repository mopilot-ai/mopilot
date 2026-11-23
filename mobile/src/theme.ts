// Phone app colour tokens (light and dark) from designs/mopilot-ios-baseline (Claude for iOS's warm neutrals); the one place a colour is written.
import { useColorScheme } from 'react-native';

export type Theme = {
  bg: string;
  surface: string;
  sunken: string;
  /** the selected segment of a segmented control, raised on the sunken track (Claude's white pill; a lighter grey in dark) */
  segment: string;
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
  btn: string;
  btnInk: string;
  warn: string;
  warnSoft: string;
  ok: string;
  okSoft: string;
  bad: string;
  badSoft: string;
  info: string;
  infoSoft: string;
  claude: string;
  claudeSoft: string;
  codex: string;
  codexSoft: string;
  addBg: string;
  delBg: string;
  termBg: string;
  termInk: string;
  termBar: string;
  termKey: string;
  termMuted: string;
  /** the drawer behind the page, one step darker than bg */
  drawer: string;
  /** a pressed row, a second fill step */
  fill2: string;
  /** the hairline around glass circles, capsules and chips */
  glassLine: string;
  /** Claude's spark and the working mark only: a graphic colour, never text */
  orange: string;
  /** the waiting hand only: a graphic colour, never text (text uses warn) */
  amber: string;
};

// Claude's baseline: warm neutrals, ink buttons, blue only for links and checks, orange and amber only as graphics. Where a design value missed 4.5:1 for small text (ink2, ink3 and the status colours on light), the token is moved just enough to pass.
export const light: Theme = {
  bg: '#fafaf8',
  surface: '#ffffff',
  sunken: '#efeeea',
  segment: '#ffffff',
  ink: '#1a1a18',
  ink2: '#6c6b64',
  ink3: '#6c6a62',
  line: '#e8e7e2',
  accent: '#1864df',
  accentInk: '#ffffff',
  accentSoft: '#e7effc',
  btn: '#1a1a18',
  btnInk: '#fafaf8',
  warn: '#945e01',
  warnSoft: '#f7ecd6',
  ok: '#1a7a3b',
  okSoft: '#e3f1e7',
  bad: '#bf3227',
  badSoft: '#f9e3e1',
  info: '#1864df',
  infoSoft: '#e7effc',
  claude: '#ac4a2a',
  claudeSoft: '#f8e7df',
  codex: '#3a3a36',
  codexSoft: '#ecebe6',
  addBg: '#e3f1e7',
  delBg: '#fceae8',
  termBg: '#1c1c1b',
  termInk: '#e9e7df',
  termBar: '#232322',
  termKey: '#2e2e2c',
  termMuted: '#9c9a93',
  drawer: '#f4f4f2',
  fill2: '#e6e5e0',
  glassLine: '#e3e2dc',
  orange: '#d97757',
  amber: '#c08a2d',
};

export const dark: Theme = {
  bg: '#151515',
  surface: '#202020',
  sunken: '#2a2a29',
  segment: '#4a4a47',
  ink: '#eeede8',
  ink2: '#9c9a93',
  ink3: '#94928b',
  line: '#2e2e2c',
  accent: '#4e91f9',
  accentInk: '#0b0b0b',
  accentSoft: '#1b2a40',
  btn: '#eeede8',
  btnInk: '#151515',
  warn: '#d9a24a',
  warnSoft: '#352a17',
  ok: '#5bb57a',
  okSoft: '#1c2f22',
  bad: '#ec6a60',
  badSoft: '#3a1f1d',
  info: '#4e91f9',
  infoSoft: '#1b2a40',
  claude: '#e58c6c',
  claudeSoft: '#3a251d',
  codex: '#d2d0c9',
  codexSoft: '#2e2e2c',
  addBg: '#17301f',
  delBg: '#3a1f1d',
  termBg: '#0b0b0b',
  termInk: '#e9e7df',
  termBar: '#161616',
  termKey: '#262625',
  termMuted: '#9c9a93',
  drawer: '#111111',
  fill2: '#333331',
  glassLine: '#343432',
  orange: '#d97757',
  amber: '#d9a24a',
};

/** Both palettes by scheme name, for a check that text on a tinted row stays readable. */
export const themes = { light, dark };

/** The palette for the device's current colour scheme. */
export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);
