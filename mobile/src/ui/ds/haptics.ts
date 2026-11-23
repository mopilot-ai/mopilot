// The one haptic the design system's own controls play; it goes through the app's haptics gate, so Settings › Haptic feedback silences it.
import { haptic } from '../../motion';

/** A picker, segment or switch changed. */
export const selectionHaptic = (): void => haptic.select();
