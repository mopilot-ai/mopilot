// The phone's motion scale and haptics, taken from the reference apps (designs/mopilot-phone-simplify/README.md §5).
import * as Haptics from 'expo-haptics';
import { hapticsOn } from './haptics';

/** Durations in ms; each is the Claude Design System value the desktop app also uses (src/styles/tokens.css). */
export const dur = Object.freeze({
  /** a press, a highlight leaving: Claude --cds-dur-fast */
  fast: 60,
  /** a small state change (a chip, a chevron): Claude --cds-dur-snap */
  snap: 120,
  /** an element entering, a row expanding: Claude --cds-dur-base */
  base: 200,
  /** a card or a non-native panel: Claude --cds-dur-sheet */
  sheet: 300,
  /** a release spring settling: Claude --cds-dur-slow */
  slow: 450,
  /** how long a progress placeholder waits before it shows: Claude --placeholder-reveal-delay */
  revealHold: 500,
  /** one turn of a spinner that says "working" (the spark, a session row's ring), measured on Claude for iOS */
  spin: 1100,
});

/**
 * Nothing on the phone passes its resting place and comes back: no timed curve leaves 0..1 and every spring is at least
 * critically damped (tests/phoneNoOvershoot.invariant.test.ts). The reference apps' springs bounce a little (damping
 * fraction 0.88, SwiftUI bounce 0.15); a sheet or a row that rises past its place and settles back reads as a glitch here.
 */

/** Cubic Bézier control points [x1, y1, x2, y2], as in the desktop tokens. */
export const ease = Object.freeze({
  /** a timed move with no overshoot: Claude --cds-ease-snap */
  snap: [0.32, 0.72, 0, 1] as const,
  /** content entering: Claude Desktop's enter curve */
  enter: [0.19, 1, 0.22, 1] as const,
  /** a sent message rising from the composer to the top: even over its 0.45 s, as measured on Claude for iOS (enter and snap cover most of the way in the first fifth) */
  rise: [0.4, 0, 0.2, 1] as const,
  /** content leaving: Claude Desktop's exit curve */
  exit: [0.8, 0, 0.4, 1] as const,
});

/** A spring that arrives as fast as its stiffness allows without passing its target: damping 2 · √(stiffness · mass). */
const critical = (stiffness: number, mass = 1) => ({ stiffness, damping: 2 * Math.sqrt(stiffness * mass), mass });

/** Reanimated spring configs, all without overshoot; the speeds are the references' (the stiffness of each). */
export const spring = Object.freeze({
  /** layout moves, list reorders: SwiftUI `.smooth` (duration 0.5 s, bounce 0) */
  smooth: { duration: 500, dampingRatio: 1 },
  /** expand and collapse, the composer pill growing into a sheet: SwiftUI `.snappy`'s speed (duration 0.5 s) without its bounce */
  snappy: { duration: 500, dampingRatio: 1 },
  /** the Codex app's pane spring (stiffness 287.7) without its bounce */
  pane: critical(287.7),
  /** Claude for iOS's sidebar, measured frame by frame (design/phone-on-orca/research/claude-ios-motion.md): damping ratio 0.97, ω 29.7 rad/s, so 90 % in 127 ms and 99 % in 210 ms; critically damped here, stiffness ω² */
  drawer: critical(880),
  /** Claude for iOS's sheets and folds (SwiftUI response 0.36 s): stiffness (2π / 0.36)², without the 0.88 damping fraction's overshoot */
  baseline: critical((2 * Math.PI) ** 2 / 0.36 ** 2),
});

/** How far a pressed control dims, and how far a primary button shrinks before its release spring. */
export const press = Object.freeze({ opacity: 0.6, scale: 0.97 });

/** A haptic that never throws: a device or build without the engine simply stays quiet. */
export const quiet = (fn: () => Promise<void>) => {
  // Settings › Haptic feedback is off
  if (!hapticsOn()) return;
  try {
    void fn().catch(() => undefined);
  } catch {
    // no haptics engine
  }
};

/** The haptic for each moment (README §5.4). */
export const haptic = Object.freeze({
  /** a message sent, a chat started */
  send: () => quiet(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** a request approved or a question answered */
  approve: () => quiet(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** a refusal, "Ask for changes" */
  deny: () => quiet(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  /** a picker or segment changed */
  select: () => quiet(() => Haptics.selectionAsync()),
  /** a send or action that failed */
  error: () => quiet(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
});
