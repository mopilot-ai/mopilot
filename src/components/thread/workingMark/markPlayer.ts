// The working mark's playhead: which stage plays from when, as the activity it should show changes; and the marks
// other lines show or just left, so a new line picks one up mid-motion.
import { earlyExit, nextStage, sheetKey, sheetOf, stageDuration, stageRange, type MarkActivity, type MarkStage } from './markStages';

/** A line that mounts this soon after another one left picks up its mark instead of starting over. */
export const RESUME_MS = 500;
/** The frame a tail cut away from is dropped this long after the cut (Claude keeps it 360ms). */
export const GHOST_MS = 360;

/** A frame a cut left behind, under the stage that fades in over it. */
export interface MarkGhost {
  sheet: string;
  index: number;
  start: number;
}

/** What the mark plays now: a stage of a sheet from `start` (its current lap, for a loop), and its frame at the time asked. */
export interface MarkFrame {
  stage: MarkStage;
  sheet: string;
  start: number;
  /** the frame showing now */
  index: number;
  /** the loop goes on lapping: nothing else is wanted */
  looping: boolean;
  ghost: MarkGhost | null;
}

interface Snapshot {
  stage: MarkStage;
  start: number;
}

/** Marks on screen that others may pick up (never a standalone one), the latest last. */
const live = new Set<MarkPlayer>();
let left: (Snapshot & { leftAt: number }) | null = null;

/** The clock the mark plays by, and how it waits for its next change (a test sets its own). */
export const markClock = {
  now: () => performance.now(),
  /** Run `fn` on the first animation frame at least `ms` from now; returns its cancel. */
  after(ms: number, fn: () => void): () => void {
    let raf = 0;
    const timer = setTimeout(() => {
      raf = requestAnimationFrame(fn);
    }, ms);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  },
};

/**
 * The mark a new one picks up: the latest on screen, else the one that left within `RESUME_MS`. A loop still wanted
 * laps on its own without its player asking, so the one on screen first catches up to `now`: its lap is where the new
 * mark starts, never a lap long gone that a new activity would count as time spent waiting.
 */
function pickUp(now: number): Snapshot | null {
  const shown = [...live].at(-1);
  if (shown) {
    const { stage, start } = shown.frame(now);
    return { stage, start };
  }
  return left && now - left.leftAt <= RESUME_MS ? left : null;
}

export class MarkPlayer {
  stage: MarkStage;
  start: number;
  wanted: MarkActivity;
  /** it started from a dot (nothing to pick up), so its first frames may need one under them */
  readonly fresh: boolean;
  private readonly standalone: boolean;
  private plan: { atMs: number; to: MarkStage } | null = null;
  private planFor = '';
  private ghost: MarkGhost | null = null;

  /**
   * `resume` picks up a mark on screen or one just left; a `standalone` mark (one that stands apart from the activity
   * line, such as the scroll button's) still picks one up, but is never picked up itself.
   */
  constructor(activity: MarkActivity, now: number, { resume = true, standalone = false } = {}) {
    this.wanted = activity;
    this.standalone = standalone;
    const prior = resume ? pickUp(now) : null;
    this.fresh = !prior;
    this.stage = prior?.stage ?? { kind: 'grow' };
    this.start = prior?.start ?? now;
    if (!standalone) live.add(this);
  }

  /**
   * Want another activity from `now`. The playhead first catches up to `now` with what was wanted until then: a loop
   * laps on its own without asking, and its laps must not count as time the new activity was waiting.
   */
  want(activity: MarkActivity, now: number): void {
    if (activity === this.wanted) return;
    this.frame(now);
    this.wanted = activity;
  }

  /** What plays at `now`, after taking every stage change due by then. */
  frame(now: number): MarkFrame {
    for (;;) {
      const played = now - this.start;
      if (this.stage.kind === 'loop' && this.stage.body !== this.wanted) {
        const key = `${this.start}|${this.wanted}`;
        if (this.planFor !== key) {
          this.planFor = key;
          this.plan = earlyExit(this.stage, this.wanted, Math.max(0, played));
        }
        if (this.plan && played >= this.plan.atMs) {
          const cut = this.start + this.plan.atMs;
          if (this.plan.to.kind === 'tail')
            this.ghost = { sheet: sheetKey(this.stage), index: this.frameIndex(this.plan.atMs), start: cut };
          this.enter(this.plan.to, cut);
          continue;
        }
      }
      const duration = stageDuration(this.stage);
      if (played < duration) break;
      const next = nextStage(this.stage, this.wanted);
      // a loop that keeps going skips whole laps at once (a window that was hidden for a while)
      const laps = next === this.stage ? Math.floor(played / duration) : 1;
      this.enter(next, this.start + laps * duration);
    }
    if (this.ghost && now - this.ghost.start >= GHOST_MS) this.ghost = null;
    return {
      stage: this.stage,
      sheet: sheetKey(this.stage),
      start: this.start,
      index: this.frameIndex(now - this.start),
      looping: this.stage.kind === 'loop' && this.stage.body === this.wanted,
      ghost: this.ghost,
    };
  }

  /**
   * How long after `now` what plays changes: the stage ends, a planned cut comes, or a cut's frame is dropped. A loop
   * that goes on lapping changes only when another activity is wanted, so it waits for that (`Infinity`).
   */
  nextChangeMs(now: number): number {
    const played = now - this.start;
    let at = Infinity;
    if (this.stage.kind !== 'loop' || this.stage.body !== this.wanted) at = this.plan ? this.plan.atMs : stageDuration(this.stage);
    if (this.ghost) at = Math.min(at, this.ghost.start + GHOST_MS - this.start);
    return Math.max(0, at - played);
  }

  /** The mark goes: keep where it is, for a line that mounts right after this one goes. */
  leave(now: number): void {
    if (this.standalone) return;
    live.delete(this);
    // caught up first, for the same reason as pickUp
    this.frame(now);
    left = { stage: this.stage, start: this.start, leftAt: now };
  }

  private enter(stage: MarkStage, start: number): void {
    this.stage = stage;
    this.start = start;
    this.plan = null;
    this.planFor = '';
  }

  private frameIndex(played: number): number {
    const [from, to] = stageRange(this.stage);
    return Math.min(to - 1, from + Math.max(0, Math.floor(played / sheetOf(this.stage).speed)));
  }
}

/** Forget the marks on screen and the last one left (tests). */
export function forgetLeftMark(): void {
  live.clear();
  left = null;
}
