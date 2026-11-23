// Motion bench command lines: the recorder's, the metrics tool's and the report's arguments, the recording's clock sync from a visible cursor move, the cursor moments' analysis joined with their page events, and the self-check against the synthetic recording.
import path from 'node:path';
import { ARMS, BENCH_DIR } from '../config.mjs';
import { detectCursor, findMoves, flatBackground } from './cursor.mjs';
import { analyzeCursor } from './cursorBench.mjs';
import { changeSeries } from './frames.mjs';
import { jankSummary } from './jank.mjs';
import { measure } from './measure.mjs';
import { firstChange } from './metrics.mjs';
import { momentById, recordingSpec, SURFACES } from './moments.mjs';
import { fitMove } from './skyFit.mjs';
import { taskCost } from './taskCost.mjs';
import { actionStats } from './toolTimes.mjs';

/** @typedef {import('./frames.mjs').Video} Video */

export const RECORD_USAGE =
  'usage: node bench/motion-record.mjs --arm <arm> --moment <id> [--surface cu|iab|bu] [--recorder sck|screencapture] [--fps <n>] ' +
  '[--run <name>] [--seconds <n>] [--results <dir>] [--cdp <port> [--cdp-target <url part>]]; ' +
  `arms: ${Object.keys(ARMS).join(', ')}`;
export const METRICS_USAGE =
  'usage: node bench/motion-metrics.mjs <recording.json>... [--palette <inventory.json>,...] [--scale <n>] [--records <mgb run dir>] | --mgb <run dir> [--scale <n>] | --self-check';
export const REPORT_USAGE =
  'usage: node bench/motion-report.mjs --vendor <label>=<arm dir> --ours <label>=<arm dir> [--moments <id>,...] [--out <dir>] ' +
  '[--path-rms <px>] [--duration <share>] [--frame-error <px>] [--offset <frames>]';

/** `--name value` pairs and positional arguments; a flag with no value is an error. */
function split(/** @type {string[]} */ argv, /** @type {string} */ usage, /** @type {string[]} */ flags = []) {
  /** @type {Record<string, string>} */
  const o = {};
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (flags.includes(a)) o[a.slice(2)] = 'yes';
    else if (a.startsWith('--')) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value\n${usage}`);
      o[a.slice(2)] = argv[(i += 1)];
    } else rest.push(a);
  }
  return { o, rest };
}

/** The recorder's arguments: a known arm and moment, a plain run name, the recording length. */
export function parseRecordArgs(/** @type {string[]} */ argv) {
  const { o } = split(argv, RECORD_USAGE);
  const arm = o.arm && Object.hasOwn(ARMS, o.arm) ? o.arm : null;
  if (!arm) throw new Error(`unknown or missing --arm\n${RECORD_USAGE}`);
  const moment = momentById(o.moment ?? '');
  const run = o.run ?? 'local';
  if (!/^[\w.-]+$/.test(run)) throw new Error(`--run must be a plain name\n${RECORD_USAGE}`);
  const seconds = o.seconds === undefined ? moment.seconds : Number(o.seconds);
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > 600) throw new Error(`--seconds must be 2–600\n${RECORD_USAGE}`);
  const results = o.results ?? path.join(BENCH_DIR, 'results', 'motion');
  // a cursor moment is driven on one agent surface; the surface sets the prompt and how the fixture page is opened
  const surface = o.surface ?? null;
  if (surface !== null && !Object.hasOwn(SURFACES, surface))
    throw new Error(`--surface must be ${Object.keys(SURFACES).join(', ')}\n${RECORD_USAGE}`);
  if (moment.cursor?.task && surface === null)
    throw new Error(`${moment.id} needs --surface ${Object.keys(SURFACES).join('|')}\n${RECORD_USAGE}`);
  const recorder = o.recorder ?? 'sck';
  if (recorder !== 'sck' && recorder !== 'screencapture') throw new Error(`--recorder must be sck or screencapture\n${RECORD_USAGE}`);
  // the frame rate asked of ScreenCaptureKit: the VM display may deliver less (bench/README.md)
  const fps = o.fps === undefined ? 120 : Number(o.fps);
  if (!Number.isInteger(fps) || fps < 15 || fps > 240) throw new Error(`--fps must be 15–240\n${RECORD_USAGE}`);
  // the app's debugging port, to capture its Animation domain alongside the recording (ChatGPT; Claude Desktop quits with one)
  const cdp = o.cdp === undefined ? null : Number(o.cdp);
  if (cdp !== null && !(Number.isInteger(cdp) && cdp > 0 && cdp < 65536)) throw new Error(`--cdp must be a port\n${RECORD_USAGE}`);
  return { arm, moment, run, seconds, surface, recorder, fps, dir: path.join(results, run, arm), cdp, cdpTarget: o['cdp-target'] ?? '' };
}

/** The metrics tool's arguments: recordings to measure, inventories whose easing tokens name fitted curves. */
export function parseMetricsArgs(/** @type {string[]} */ argv) {
  const { o, rest } = split(argv, METRICS_USAGE, ['--self-check']);
  const selfCheck = o['self-check'] === 'yes';
  // a 12-Grid Bench run folder (#1381): every task run's screen recording, scored for the scorecard
  const mgb = o.mgb ?? null;
  if (!selfCheck && !mgb && !rest.length) throw new Error(METRICS_USAGE);
  // 4: a 40 s recording of a 1200x800 window stays near 150 MB of frames; 2 for small, fine motion
  const scale = o.scale === undefined ? 4 : Number(o.scale);
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) throw new Error(`--scale must be 1–16\n${METRICS_USAGE}`);
  return {
    recordings: rest,
    palettes: o.palette ? o.palette.split(',').filter(Boolean) : [],
    scale,
    scaleGiven: o.scale !== undefined,
    selfCheck,
    mgb,
    records: o.records ?? null,
  };
}

/** The report's arguments: the vendor's and our arm folders (`label=dir`), the moments to report, the output folder, the tolerance overrides. */
export function parseReportArgs(/** @type {string[]} */ argv) {
  const { o } = split(argv, REPORT_USAGE);
  const side = (/** @type {string} */ name) => {
    const m = /^([^=]+)=(.+)$/.exec(o[name] ?? '');
    if (!m) throw new Error(`--${name} needs <label>=<arm dir>\n${REPORT_USAGE}`);
    return { label: m[1], dir: m[2] };
  };
  /** @type {Record<string, number>} */
  const tolerance = {};
  for (const [flag, key] of /** @type {const} */ ([
    ['path-rms', 'pathRmsPx'],
    ['duration', 'durationShare'],
    ['frame-error', 'frameErrorP95Px'],
    ['offset', 'offsetFrames'],
  ])) {
    if (o[flag] === undefined) continue;
    const v = Number(o[flag]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`--${flag} must be a number of at least 0\n${REPORT_USAGE}`);
    tolerance[key] = v;
  }
  return {
    vendor: side('vendor'),
    ours: side('ours'),
    moments: o.moments ? o.moments.split(',').filter(Boolean) : null,
    out: o.out ?? null,
    tolerance,
  };
}

/**
 * The recorder's marks in the recording's own time. Before its steps the recorder moves the cursor into a corner of
 * the window (captured with the recording) and notes the wall clock: the first change there gives the offset between
 * the two clocks, which places every mark. Null when the move never showed.
 * @param {Video} video @param {import('./frames.mjs').Rect} syncRect
 * @param {{ syncAt: number, spawnAt?: number, marks: Record<string, number> }} wall wall-clock ms
 */
export function videoMarks(video, syncRect, wall) {
  // the recording started after the recorder spawned it, so the move cannot show earlier than `syncAt - spawnAt` less
  // the recorder's start-up (allowed a second): a change in the corner before that is not the move
  const earliest = wall.spawnAt === undefined ? undefined : wall.syncAt - wall.spawnAt - 1000;
  const seen = firstChange(changeSeries(video, syncRect), earliest);
  if (seen === null) return null;
  /** @type {Record<string, number>} */
  const out = {};
  for (const [name, at] of Object.entries(wall.marks)) out[name] = Math.round(at - wall.syncAt + seen);
  return out;
}

/** A screencast's marks: its frames carry wall-clock times, so a mark is its wall time less the first frame's. */
export function wallMarks(/** @type {Record<string, number>} */ marks, /** @type {number} */ originMs) {
  return Object.fromEntries(Object.entries(marks).map(([name, at]) => [name, Math.round(at - originMs)]));
}

/** A screen recording's marks, placed by the cursor move the recorder made (videoMarks). */
function cursorMarks(/** @type {any} */ rec, /** @type {Video} */ video, /** @type {number} */ pxPerPoint) {
  const sync = /** @type {[number, number, number, number]} */ (rec.sync.region.map((/** @type {number} */ v) => v * pxPerPoint));
  return videoMarks(video, sync, { syncAt: rec.sync.syncAt, spawnAt: rec.sync.spawnAt, marks: rec.marks });
}

/**
 * The recording's clock for page events: a wall-clock ms to the recording's ms. A screencast or ScreenCaptureKit
 * recording carries wall-clock origins; a screen recording is placed by the recorder's cursor move. Null when that move never showed.
 * @param {any} rec @param {Video} video @param {number} pxPerPoint
 */
export function videoClock(rec, video, pxPerPoint) {
  if (rec.sync.clock === 'wall') return (/** @type {number} */ wall) => wall - rec.sync.originMs;
  const placed = cursorMarks({ ...rec, marks: { sync: rec.sync.syncAt } }, video, pxPerPoint);
  return placed ? (/** @type {number} */ wall) => wall - rec.sync.syncAt + placed.sync : null;
}

/**
 * Measures one recording (a screen recording or a CDP screencast): its moment's spec moved into the recording's
 * pixels (the window in points or CSS px over the decoded source width), the marks placed by the clock sync (the
 * cursor move, or a screencast's wall clock), and the moment's metrics. The moment is read from the catalog,
 * so a recording is measured with the current spec. A cursor moment also gets the cursor analysis, joined with the
 * fixture page's `events`; `jank` (renderer long-task entries), `calls` (the transcript's tool calls) and `records`
 * (12-Grid Bench run records, for steps, tokens and pass rate) add their columns when given.
 * @param {any} rec the recorder's JSON @param {Video} video @param {Record<string, import('./fit.mjs').Curve>} [palette]
 * @param {{ events?: any[], planner?: { planner: import('./skyFit.mjs').Planner, source: string }, jank?: any[], calls?: import('./toolTimes.mjs').ToolCall[], records?: any[] }} [extra]
 */
export function measureRecording(rec, video, palette, extra = {}) {
  const moment = momentById(rec.moment);
  // a recording at 1x names its scale (a cropped one's width is not the window's)
  const pxPerPoint = rec.pxPerPoint ?? video.source[0] / rec.window[2];
  const spec = recordingSpec(moment, rec.regions, rec.window, pxPerPoint);
  const marks = rec.sync.clock === 'wall' ? wallMarks(rec.marks, rec.sync.originMs) : cursorMarks(rec, video, pxPerPoint);
  const results = measure(video, spec, { marks: marks ?? {}, palette });
  const base = {
    arm: rec.arm,
    family: rec.family,
    version: rec.version,
    moment: rec.moment,
    surface: rec.surface ?? null,
    synced: marks !== null,
    marks,
    frames: video.frames.length,
    results,
  };
  if (!moment.cursor || !extra.planner) return base;
  const analysis = analyzeCursor({
    video,
    events: extra.events ?? [],
    toVideo: videoClock(rec, video, pxPerPoint),
    pxPerPoint,
    marks: marks ?? {},
    planner: extra.planner,
    results,
    labelled: typeof rec.arm === 'string' && rec.arm.startsWith('mp-'),
  });
  const window = { from: rec.marks.send ?? rec.sync.syncAt, to: rec.marks.end ?? Date.parse(rec.recordedAt) };
  return {
    ...base,
    analysis: {
      ...analysis,
      jank: extra.jank ? jankSummary(extra.jank, window) : null,
      actions: extra.calls ? actionStats(extra.calls) : null,
      cost: extra.records ? taskCost(extra.records) : null,
    },
  };
}

/**
 * Where the recorder moves the cursor to sync clocks, in points from the window's top left, and the region around it
 * that sees it.
 */
export function syncSpot(/** @type {[number, number, number, number]} */ window) {
  // the middle of the title bar: hovering there does nothing (the corner holds the traffic lights, close first)
  const x = Math.round(window[2] / 2);
  return {
    point: /** @type {[number, number]} */ ([x, 12]),
    region: /** @type {[number, number, number, number]} */ ([x - 24, 0, 48, 32]),
  };
}

/** bench/motion/synth.swift's timeline as a spec (640x400 px): what each band does, and when. */
export const SYNTH_SPEC = /** @type {import('./measure.mjs').Spec} */ ({
  id: 'synth',
  regions: {
    trigger: [0, 0, 640, 80],
    fade: [0, 100, 640, 80],
    slide: [0, 200, 640, 60],
    reveal: [0, 280, 640, 40],
    content: [0, 330, 640, 70],
    all: [0, 0, 640, 400],
  },
  measure: [
    { kind: 'feedback', trigger: 'trigger', response: 'fade' },
    { kind: 'transition', region: 'fade' },
    { kind: 'transition', region: 'slide', mode: 'x' },
    { kind: 'cadence', region: 'reveal' },
    { kind: 'deadAir', region: 'all', from: 1500 },
    { kind: 'dropped', region: 'slide' },
    { kind: 'layoutShift', region: 'content' },
  ],
});
/** The two curves synth.swift animates with. */
export const SYNTH_PALETTE = /** @type {Record<string, import('./fit.mjs').Curve>} */ ({ fade: [0, 0, 0.2, 1], slide: [0.32, 0.72, 0, 1] });

/**
 * What the synthetic recording must measure, each as [description, ok]. Durations are allowed to fall short by up
 * to a fifth: the last sub-pixel steps of an eased tail are below what a downscaled frame can show.
 * @param {any[]} r the results of measure() on the synthetic recording with SYNTH_SPEC and SYNTH_PALETTE
 */
export function checkSynth(r) {
  const [fb, fade, slide, cad, air, drop, shift] = r;
  const near = (/** @type {number} */ v, /** @type {number} */ want, /** @type {number} */ tol) => Math.abs(v - want) <= tol;
  return /** @type {[string, boolean][]} */ ([
    ['feedback 100–120 ms after the trigger', fb.ms >= 100 && fb.ms <= 120],
    [
      'fade ≈ 200 ms, closest to its curve',
      !!fade.result && near(fade.result.durationMs, 180, 30) && fade.result.nearest[0]?.name === 'fade',
    ],
    [
      'slide ≈ 300 ms, closest to its curve, no overshoot',
      !!slide.result &&
        near(slide.result.durationMs, 270, 40) &&
        slide.result.nearest[0]?.name === 'slide' &&
        slide.result.overshoot < 0.05,
    ],
    ['slide drops 2 frames', drop.dropped === 2],
    ['reveal: 10 updates 100 ms apart', cad.updates === 10 && cad.medianMs === 100],
    ['1.6 s of dead air after the reveal', air.gaps.length === 1 && air.gaps[0].from === 2400 && near(air.longestMs, 1600, 20)],
    ['one 20 px layout shift', shift.shifts.length === 1 && shift.totalPx === 20],
  ]);
}

/**
 * What the synthetic cursor recording (synth.swift with `cursor`: a square moving (100,120) to (520,280) from 0.5 s and
 * back from 2.0 s on a spring of response 0.3 s, damping 0.9) must measure, each as [description, ok].
 * @param {Video} video
 */
export function cursorSynthChecks(video) {
  const rect = /** @type {import('./frames.mjs').Rect} */ ([0, 0, video.source[0], video.source[1]]);
  // the page is a flat 235: a cursor that rests for half the recording must not become the background
  const track = detectCursor(video, { rect, background: flatBackground(video, rect, 235) });
  const moves = findMoves(track);
  const near = (/** @type {number | undefined} */ v, /** @type {number} */ want, /** @type {number} */ tol) =>
    v !== undefined && Math.abs(v - want) <= tol;
  const fit = moves[0] ? fitMove(moves[0]) : null;
  return /** @type {[string, boolean][]} */ ([
    ['the cursor is found in 90% of the frames', track.filter((f) => f.found).length >= 0.9 * track.length],
    ['two moves', moves.length === 2],
    ['the first starts about 0.5 s in', near(moves[0]?.t0, 500, 80)],
    ['the second starts about 2.0 s in', near(moves[1]?.t0, 2000, 80)],
    ['each covers 449 px', moves.length === 2 && moves.every((m) => near(m.distance, 449.4, 6))],
    ['the spring fits a response near 0.3 s', !!fit && near(fit.response, 0.3, 0.1)],
  ]);
}
