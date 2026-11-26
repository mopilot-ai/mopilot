// The arithmetic of a chat's keyboard lift, run on the UI thread every frame (#5686): how much room the keyboard has taken, and where the offset of a reader at the end goes with it.
import { REST_END } from './followMath';

/** A lift whose height has not changed for this long (ms) is over: the next change is a new one (a candidate bar, the keyboard closing). */
export const LIFT_QUIET = 80;

/** What the JS thread says about the chat, as it last heard it: where the view stands, how big it and its content are, and whose the view is. */
export type LiftInput = { y: number; content: number; view: number; following: boolean; pinned: boolean; touching: boolean; seq: number };
/** What the UI thread keeps between frames: the lift so far (`p`), and for one in progress where it began. */
export type LiftMotion = {
  p: number;
  active: boolean;
  engaged: boolean;
  y0: number;
  p0: number;
  view0: number;
  changed: number;
  /** Where the last frame of the lift took the view, and what the JS thread had said (`seq`) when it ended: a lift begun before the view has reported where it stands starts from there. */
  last: number | null;
  seq: number;
  endedAt: number;
};
export const NO_INPUT: LiftInput = { y: 0, content: 0, view: 0, following: true, pinned: false, touching: false, seq: 0 };
export const NO_MOTION: LiftMotion = {
  p: 0,
  active: false,
  engaged: false,
  y0: 0,
  p0: 0,
  view0: 0,
  changed: 0,
  last: null,
  seq: 0,
  endedAt: 0,
};
/** A lift that ended this recently, with nothing heard of the view since, is where the next one starts. */
export const LIFT_RECENT = 1000;

/**
 * How much of the screen the keyboard has taken from the app's frame, in points: the keyboard's own height less the home indicator's, which the screens already keep clear
 * at their bottom (the same lift the app's frame puts under the content).
 */
export const lifted = (keyboard: number, inset: number) => {
  'worklet';
  return Math.max(0, keyboard - inset);
};

/**
 * Where the offset of a reader who stood at the end goes when the frame has lifted by `dp` more points (less, when negative): the end the view has with its new height, and never
 * past it, so a chat whose content fits stays at the top and nothing is left blank under the last row.
 */
export const liftTarget = (y0: number, content: number, view0: number, dp: number) => {
  'worklet';
  return Math.min(Math.max(0, y0 + dp), Math.max(0, content - view0 + dp));
};

/**
 * One frame of the lift: the keyboard's lift now (`p`) against the last frame's. A change begins a lift (or goes on with the one in progress) and says where the offset goes,
 * `to`; a lift is over once it has been quiet for LIFT_QUIET. Only a reader at the end who follows, whose view is not held by a finger or a pinned message, is moved, and that is decided where the lift begins.
 */
export function stepLift(m: LiftMotion, input: LiftInput, p: number, now: number): { motion: LiftMotion; to: number | null } {
  'worklet';
  if (p !== m.p) {
    let begun = m;
    if (!m.active) {
      // the view reports where it stands a moment after the last frame moved it: a lift that begins before that starts from where the last one took it
      const y0 = m.last !== null && input.seq === m.seq && now - m.endedAt < LIFT_RECENT ? m.last : input.y;
      // a view that has not reported its size (a chat that opens with the keyboard already up) is nobody's to move
      const engaged = input.view > 0 && input.following && !input.pinned && !input.touching && y0 >= input.content - input.view - REST_END;
      begun = { ...m, active: true, engaged, y0, p0: m.p, view0: input.view, last: null };
    }
    const motion = { ...begun, p, changed: now };
    // a finger that lands mid-lift or a pin that begins takes the view back from it
    const moves = motion.engaged && !input.pinned && !input.touching;
    const to = moves ? liftTarget(motion.y0, input.content, motion.view0, p - motion.p0) : null;
    return { motion: to === null ? motion : { ...motion, last: to }, to };
  }
  if (m.active && now - m.changed > LIFT_QUIET)
    return { motion: { ...m, active: false, engaged: false, seq: input.seq, endedAt: now }, to: null };
  return { motion: m, to: null };
}
