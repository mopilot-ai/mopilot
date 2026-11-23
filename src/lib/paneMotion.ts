// The side pane's open and close motion: the Codex app's right-panel spring, and how long a closing pane stays mounted.

/** The spring's length (Framer Motion spring, duration 0.5s, bounce 0.1): each open or close plays this long. */
export const PANE_SPRING_MS = 500;
/** Closing from full view fades out (panel-out-fade, 200ms). */
export const PANE_FADE_MS = 200;
/** Keyframes per spring: one every 1/30 of its 500ms, about one per frame at 60fps. */
export const PANE_SPRING_STEPS = 30;

/**
 * How long a closing pane stays mounted: its closing spring, the full view's fade, or nothing when the user asks
 * for reduced motion (the pane then goes at once, as nothing animates).
 */
export function paneExitMs(full: boolean, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  return full ? PANE_FADE_MS : PANE_SPRING_MS;
}

/** Whether the user asks for reduced motion (false where there is no matchMedia). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The natural frequency of Framer Motion's duration/bounce spring: its findSpring, 11 Newton steps on the envelope
 * from 5/duration (app-shared-8bd9d0399038.js:61067-61104, :61215-61235). Damping ratio is 1 - bounce.
 */
export function springFrequency(duration: number, bounce: number): number {
  const z = 1 - bounce;
  const angular = (u: number) => u * Math.sqrt(1 - z * z);
  const envelope = (u: number) => 0.001 - ((u * z) / angular(u)) * Math.exp(-u * z * duration);
  // Framer's derivative, its sign factor folded in (the envelope's decay term is always positive)
  const derivative = (u: number) => (z * z * u * u * duration * Math.exp(-u * z * duration)) / angular(u * u);
  let u = 5 / duration;
  for (let i = 1; i < 12; i++) u -= envelope(u) / derivative(u);
  return u;
}

/** The pane's spring: Codex's right panel, {type: 'spring', duration: 0.5, bounce: 0.1} (app-initial:64245). */
const ZETA = 0.9;
const OMEGA = springFrequency(0.5, 0.1);
const OMEGA_D = OMEGA * Math.sqrt(1 - ZETA * ZETA);

/** A width moving on the pane's spring from `from` to `to`, starting at `velocity` px/s: where and how fast at t ms. */
export interface PaneCurve {
  from: number;
  to: number;
  at: (ms: number) => number;
  velocity: (ms: number) => number;
}

/**
 * The underdamped spring from `from` to `to` with a starting velocity, as Framer integrates it in closed form: a
 * reversal mid-way starts where the edge is, moving as fast as it was, so the pane never jumps.
 */
export function paneCurve(from: number, to: number, velocity = 0): PaneCurve {
  const a = from - to;
  const b = (velocity + ZETA * OMEGA * a) / OMEGA_D;
  const decay = (t: number) => Math.exp(-ZETA * OMEGA * t);
  return {
    from,
    to,
    at: (ms) => {
      const t = ms / 1000;
      return to + decay(t) * (a * Math.cos(OMEGA_D * t) + b * Math.sin(OMEGA_D * t));
    },
    velocity: (ms) => {
      const t = ms / 1000;
      const c = Math.cos(OMEGA_D * t);
      const s = Math.sin(OMEGA_D * t);
      return decay(t) * ((b * OMEGA_D - ZETA * OMEGA * a) * c - (a * OMEGA_D + ZETA * OMEGA * b) * s);
    },
  };
}

/** The curve's widths every 1/PANE_SPRING_STEPS of PANE_SPRING_MS, ending exactly on its target. */
export function paneKeyframes(curve: PaneCurve): number[] {
  const out: number[] = [];
  for (let i = 0; i < PANE_SPRING_STEPS; i++) out.push(curve.at((PANE_SPRING_MS * i) / PANE_SPRING_STEPS));
  out.push(curve.to);
  return out;
}
