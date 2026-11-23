// The settings pages' only doors to the design system and the string table: tokens, motion and copy are read here, so swapping in R2's tokens changes this file and nothing else.
import type { TOptions } from 'i18next';
import { t } from '../i18n';
import { dur, ease, radii, spacing, Switch, typo, useReducedMotionEnabled, useTokens } from '../ds';

/** The design system's parts this page draws with, through one door. */
export { Switch, typo, useReducedMotionEnabled, useTokens };

/** Where each of this page's words lives in the catalogue: R3's own keys where it has the line, else the `usagePage` group. */
const KEYS = {
  'usage.title': 'settings.usage',
  'usage.never': 'usage.notFetched',
  'usage.signin': 'usage.signInOnMac',
  'usage.offline': 'usagePage.offline',
  'usage.empty': 'usagePage.empty',
  'usage.refresh': 'usagePage.refresh',
  'usage.refreshing': 'usagePage.refreshing',
  'usage.scope': 'usagePage.scope',
  'usage.old': 'usagePage.old',
  'usage.unsupported': 'usagePage.unsupported',
  'usage.unavailable': 'usagePage.unavailable',
  'usage.lastKnown': 'usagePage.lastKnown',
  'usage.refreshNeeded': 'usagePage.refreshNeeded',
  'usage.resetPast': 'usagePage.resetPast',
  'usage.resetUnknown': 'usagePage.resetUnknown',
  'usage.resetUnder': 'usagePage.resetUnder',
  'usage.resetInMin': 'usagePage.resetInMin',
  'usage.resetInH': 'usagePage.resetInH',
  'usage.resetInHMin': 'usagePage.resetInHMin',
  'usage.resetAt': 'usagePage.resetAt',
  'usage.left': 'usagePage.left',
  'account.active': 'usagePage.active',
  'account.signedOut': 'usagePage.signedOut',
  'account.expired': 'usagePage.expired',
  'account.limited': 'usagePage.limited',
  'autoSwitch.title': 'usagePage.switchTitle',
  'autoSwitch.detail': 'usagePage.switchDetail',
  'autoSwitch.failed': 'usagePage.switchFailed',
} as const;
export type CopyKey = keyof typeof KEYS;
/** The line in the shown language, read when it is drawn (never at import, so a language change reaches it). */
export const text = (key: CopyKey, options?: TOptions): string => t(KEYS[key], options);

/** Motion of the meters and rows: the app's own scale (motion.ts), through one name each. */
export const motion = { fill: dur.sheet, enter: dur.base, curve: ease.enter } as const;

/** Meter height and gaps, in points, from the system's scale. */
export const metrics = { meter: 6, meterRadius: radii.mark - 1, gap: spacing.sm, pad: spacing.lg } as const;

/** A remaining share under which a meter turns amber, then red. */
export const thresholds = { low: 25, critical: 10 } as const;
