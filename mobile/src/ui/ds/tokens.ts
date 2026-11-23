// The design tokens every new screen shares: MoPilot's two palettes and type scale, Orca's spacing and shape scale, and the rules for a touch target and a switch.
import { themes, useTheme, type Theme } from '../../theme';
export { spacing, radii, concentricRadius, feedback } from '../../../vendor/orca/ds/metrics';
export { typo, typoEyebrow, typoScale, typoWeight } from '../../typography';
export { useLargeText, LARGE_TEXT } from '../../useLargeText';
export type { Theme };

export type Scheme = 'light' | 'dark';

/** The smallest touch target on the phone, in points (Apple's 44 pt). */
export const MIN_TARGET = 44;

/** The palette of a scheme; both palettes come from the one source in `src/theme.ts`. */
export const tokensFor = (scheme: Scheme): Theme => themes[scheme];

/** The palette of the device's current scheme; a change of the system setting repaints the caller without a restart. */
export const useTokens = (): Theme => useTheme();

/** The track colours of a switch: a quiet fill when off, the accent when on. */
export const switchColors = (tokens: Theme): { off: string; on: string } => ({ off: tokens.fill2, on: tokens.accent });
