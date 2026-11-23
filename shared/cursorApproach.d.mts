// shared/cursorApproach.d.mts: types for cursorApproach.mjs (the observed Sky cursor plan).

import type { Point, Rect } from './cursorMotionPlan.mjs';

export interface ApproachSample {
  t: number;
  x: number;
  y: number;
  progress: number;
  state: 'arrow' | 'disc' | 'hidden';
}
export interface ApproachPlan {
  start: Point;
  to: Point;
  durationMs: number;
  hoverMs: number;
  pressAtMs: number;
  hideAfterClickMs: number;
  totalMs: number;
  distance: number;
  samples: ApproachSample[];
  timeline: { t: number; state: ApproachSample['state'] }[];
}
export declare const OBSERVED: Readonly<{
  startClip: number;
  response: number;
  settleDistance: number;
  hoverMs: number;
  hideAfterClickMs: number;
  defaultOffset: Readonly<Point>;
}>;
/** The default cursor plan: the observed Sky approach, glide, press and vanish. */
export interface ApproachProfile {
  startClip?: number;
  response?: number;
  hoverMs?: number;
  hideAfterClickMs?: number;
}
/** The Codex app's in-app browser cursor (VM recording): pass as `profile` for the in-app browser and the user's Chrome. */
export declare const OBSERVED_CODEX_IAB: Readonly<Required<ApproachProfile>>;
export declare function planApproach(input: {
  from?: Point | null;
  to: Point;
  bounds?: Rect;
  reducedMotion?: boolean;
  profile?: ApproachProfile | null;
}): ApproachPlan;
