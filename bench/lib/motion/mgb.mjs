// Motion bench for the 12-Grid Bench (#1381, #1511): one task run's screen recording parts summarized for the scorecard (the longest still stretch during the turn, still stretches over 3 s, dropped frames per minute of motion).
import { changeSeries } from './frames.mjs';
import { deadAir, droppedFrames, runs } from './metrics.mjs';

/** @typedef {import('./frames.mjs').Video} Video */

/** A still stretch longer than this during a turn is dead air the scorecard counts. */
export const STILL_LIMIT_MS = 3000;

/**
 * One task run's motion from its recording parts (each a loader for its decoded video, and the epoch ms it was started
 * at) and the turn's own times. Parts are loaded one at a time: a whole run's frames would not fit in memory. Each part is measured on its own over the whole screen, within the turn: the short gap between
 * two parts is never a still stretch, and neither is the time before the prompt was sent or after the turn ended.
 * A part's start is noted before the recorder starts, so its frames are up to about a second later than the clock says;
 * a 3 s still limit tolerates that.
 * @param {{ load: () => Video, startedAt: number }[]} parts
 * @param {{ turnStartedAt: number | null, turnEndedAt: number | null }} turn
 */
export function taskMotion(parts, { turnStartedAt, turnEndedAt }) {
  let longest = 0;
  let stills = 0;
  let dropped = 0;
  let motionMs = 0;
  let measured = 0;
  if (turnStartedAt === null || turnEndedAt === null) return unscored();
  for (const { load, startedAt } of parts) {
    // a part started after the turn ended holds none of it
    if (startedAt >= turnEndedAt) continue;
    const video = load();
    const frames = video.frames;
    if (frames.length < 2) continue;
    const from = Math.max(frames[0].t, turnStartedAt - startedAt);
    const to = Math.min(frames[frames.length - 1].t, turnEndedAt - startedAt);
    if (to <= from) continue;
    measured += 1;
    const region = /** @type {import('./frames.mjs').Rect} */ ([0, 0, video.source[0], video.source[1]]);
    const series = changeSeries(video, region);
    const air = deadAir(series, from, to, STILL_LIMIT_MS);
    longest = Math.max(longest, air.longestMs);
    stills += air.gaps.length;
    const motion = runs(series).filter((r) => r.end >= from && r.start <= to);
    dropped += droppedFrames(video, motion).dropped;
    motionMs += motion.reduce((s, r) => s + (r.end - r.start), 0);
  }
  if (!measured) return unscored();
  return {
    schema: 1,
    parts: measured,
    longestStillMs: Math.round(longest),
    stillsOver3s: stills,
    droppedPerMin: motionMs > 0 ? Math.round((dropped / (motionMs / 60000)) * 10) / 10 : 0,
    motionSeconds: Math.round(motionMs / 100) / 10,
  };
}

/** Nothing of the turn was recorded: no score, rather than a perfect one. */
const unscored = () => ({ schema: 1, parts: 0, longestStillMs: null, stillsOver3s: null, droppedPerMin: null, motionSeconds: 0 });

/**
 * A task run's motion from its recording manifest (`<task>.rec.json`: each part's file and start, the turn's start and
 * end), loading each part's video by its file name.
 * @param {{ parts?: { file: string, startedAt: number }[], turnStartedAt?: number | null, turnEndedAt?: number | null }} rec
 * @param {(file: string) => Video} load
 */
export function manifestMotion(rec, load) {
  return taskMotion(
    (rec.parts ?? []).map((p) => ({ load: () => load(p.file), startedAt: p.startedAt })),
    { turnStartedAt: rec.turnStartedAt ?? null, turnEndedAt: rec.turnEndedAt ?? null },
  );
}
