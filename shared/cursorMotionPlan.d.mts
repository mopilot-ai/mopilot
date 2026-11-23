export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type CursorMotionKind = 'move' | 'click' | 'drag' | 'type' | 'scroll' | 'hide';
export interface MotionSample {
  t: number;
  x: number;
  y: number;
  progress: number;
  scaleX: number;
  scaleY: number;
  pivotX: number;
  tiltDeg: number;
}
export interface MotionPlan {
  mode: 'jump' | 'straight' | 'scoot' | 'arc';
  kind: string;
  durationMs: number;
  samples: MotionSample[];
  arrivalIndex: number;
  response: number;
  selection: { index: number; count: number; score: number } | null;
}
export interface CursorMotionEvent {
  v: number;
  host: string;
  chatId: string;
  target: string;
  generation: number;
  seq: number;
  kind: CursorMotionKind;
  from?: Point;
  to: Point;
  geometryVersion: number;
  durationMs: number;
  seed: number;
  confirmed: boolean;
}
export interface EventState {
  generation: number | null;
  seq: number;
  position: Point | null;
}
export interface AcceptOptions {
  reduceMotion?: boolean;
  geometryVersion?: number;
  receivedAtMs?: number;
  bounds?: Rect;
}
export type EventAction =
  | { type: 'drop'; reason: string }
  | { type: 'hide' | 'hold'; cancel: boolean }
  | { type: 'jump' | 'snap'; to: Point; cancel: boolean }
  | { type: 'play'; plan: MotionPlan; startOffsetMs: number; cancel: boolean };
export interface Path {
  segments: Point[][];
  isStraight: boolean;
}
export interface PathStats {
  points: Point[];
  L: number;
  S2: number;
  Smax: number;
  Sabs: number;
  inBounds: boolean;
  backtrack?: number;
}
export type MotionConfig = Readonly<Record<string, number>>;

export declare const SAMPLE_HZ: number;
export declare const PLAN_EVENT_VERSION: number;
export declare const EVENT_KINDS: readonly CursorMotionKind[];
export declare const MOTION_CONFIG: MotionConfig;
export declare const CANDIDATE_TABLES: Readonly<Record<string, number | readonly number[]>>;
export declare const SCORE_WEIGHTS: Readonly<Record<string, number>>;
export declare const RESPONSE_TERMS: Readonly<Record<string, number>>;
export declare const TIMING: Readonly<Record<string, number>>;
export declare const SCOOT_ENVELOPE: Readonly<Record<string, number>>;

/** The straight single-cubic path. */
export declare function straightPath(from: Point, to: Point): Path;
/** The 20 candidate arc paths between two points. */
export declare function generateCandidates(from: Point, to: Point, config?: MotionConfig): Path[];
/** A path flattened at 24 samples per cubic with length and heading-change statistics. */
export declare function pathStats(path: Path, bounds?: Rect, config?: MotionConfig): PathStats;
/** Candidate score; lower is better. */
export declare function scorePath(stats: PathStats, D: number, startDir: Point, config?: MotionConfig): number;
/** The best candidate by score among those inside the bounds. */
export declare function choosePath(
  from: Point,
  to: Point,
  bounds?: Rect,
  config?: MotionConfig,
): { index: number; score: number; path: Path; stats: PathStats; count: number };
/** Spring response in seconds for a path, clamped to the configured range. */
export declare function springResponse(
  stats: Pick<PathStats, 'L' | 'S2' | 'Smax' | 'Sabs' | 'backtrack'>,
  D: number,
  isStraight: boolean,
  config?: MotionConfig,
): number;
/** Plans a whole move once as a deterministic 120 Hz trajectory. */
export declare function planMove(input: { from: Point; to: Point; bounds?: Rect; kind?: string }, config?: MotionConfig): MotionPlan;
/** The plan's state at tMs, interpolated between samples (a label such as the press state is the earlier sample's). */
export declare function sampleAt<S extends { t: number }>(plan: { samples: S[] }, tMs: number): S;
/** Validates a cursorMotion event. */
export declare function validateCursorMotionEvent(e: unknown): { ok: true } | { ok: false; reason: string };
/** The client's event state before any event. */
export declare function initialEventState(): EventState;
/** What a client does with an event: the next state and an action. */
export declare function acceptEvent(
  state: EventState,
  event: unknown,
  nowMs: number,
  opts?: AcceptOptions,
): { state: EventState; action: EventAction };
