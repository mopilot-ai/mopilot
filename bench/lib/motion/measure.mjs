// Motion bench: a moment's measurement spec (named regions and the metrics to take over them) checked and run against one decoded recording, with easing palettes from an easing-token file.
import { changeSeries } from './frames.mjs';
import { cadence, deadAir, droppedFrames, feedback, layoutShift, runs, transition } from './metrics.mjs';

/** @typedef {import('./frames.mjs').Video} Video */
/** @typedef {import('./frames.mjs').Rect} Rect */
/** @typedef {import('./fit.mjs').Curve} Curve */
/**
 * A time in a spec: ms from the recording's start, or the name of a mark the recorder wrote.
 * @typedef {number | string} When
 * @typedef {{ kind: 'feedback', trigger: string | When, response: string, after?: When }
 *   | { kind: 'transition', region: string, mode?: 'blend' | 'x' | 'y', after?: When }
 *   | { kind: 'cadence', region: string, from?: When, to?: When }
 *   | { kind: 'deadAir', region: string, from?: When, to?: When, limitMs?: number }
 *   | { kind: 'dropped', region: string }
 *   | { kind: 'layoutShift', region: string, maxPx?: number }} Measure
 * @typedef {{ id: string, regions: Record<string, Rect>, measure: Measure[], minMass?: number }} Spec
 */

/** The CSS easing keywords, as curves. */
export const CSS_EASINGS = /** @type {Record<string, Curve>} */ ({
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
});

const KINDS = new Set(['feedback', 'transition', 'cadence', 'deadAir', 'dropped', 'layoutShift']);
const isRect = (/** @type {unknown} */ r) =>
  Array.isArray(r) && r.length === 4 && r.every((v) => Number.isFinite(v)) && r[2] > 0 && r[3] > 0;

/** Checks a spec's shape and that every region it names exists; throws saying what is wrong. */
export function checkSpec(/** @type {any} */ spec) {
  if (!spec || typeof spec.id !== 'string' || !spec.id) throw new Error('a motion spec needs an id');
  if (!spec.regions || typeof spec.regions !== 'object') throw new Error(`${spec.id}: regions must be an object`);
  for (const [name, rect] of Object.entries(spec.regions))
    if (!isRect(rect)) throw new Error(`${spec.id}: region ${name} must be [x, y, w, h]`);
  if (!Array.isArray(spec.measure) || !spec.measure.length) throw new Error(`${spec.id}: measure must list at least one metric`);
  for (const m of spec.measure) {
    if (!KINDS.has(m?.kind)) throw new Error(`${spec.id}: unknown metric ${m?.kind}`);
    for (const key of m.kind === 'feedback' ? ['response'] : ['region']) {
      if (!Object.hasOwn(spec.regions, m[key])) throw new Error(`${spec.id}: ${m.kind} names no region ${m[key]}`);
    }
  }
  return /** @type {Spec} */ (spec);
}

/** A spec time as ms: a number as is, a mark name looked up (throws when missing), nothing as `fallback`. */
export function when(/** @type {When | undefined} */ value, /** @type {Record<string, number>} */ marks, /** @type {number} */ fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  if (!Object.hasOwn(marks, value)) throw new Error(`no mark ${value} in this recording`);
  return marks[value];
}

/**
 * Runs every metric of a spec on one recording. `marks` are the recorder's named times (ms from the recording's
 * start); `palette` names the curves a fitted transition is compared with.
 * @param {Video} video @param {Spec} spec @param {{ marks?: Record<string, number>, palette?: Record<string, Curve> }} [o]
 */
export function measure(video, spec, { marks = {}, palette = CSS_EASINGS } = {}) {
  const first = video.frames[0]?.t ?? 0;
  const last = video.frames[video.frames.length - 1]?.t ?? 0;
  const minMass = spec.minMass;
  /** A region the spec names, or a clear error when the recording has none by that name. */
  const regionOf = (/** @type {string} */ name, /** @type {string} */ kind) => {
    if (!Object.hasOwn(spec.regions, name)) throw new Error(`${kind} names no region ${name} in this recording`);
    return spec.regions[name];
  };
  return spec.measure.map((m) => {
    try {
      return one(m);
    } catch (error) {
      // one metric that cannot be taken (a mark the recording lacks, a region outside it) leaves the others standing
      return { kind: m.kind, error: /** @type {Error} */ (error).message };
    }
  });
  /** @param {Measure} m */
  function one(m) {
    if (m.kind === 'feedback') {
      const trigger =
        typeof m.trigger === 'string' && Object.hasOwn(spec.regions, m.trigger) ? spec.regions[m.trigger] : when(m.trigger, marks, first);
      const after = when(m.after, marks, first);
      return { kind: m.kind, region: m.response, ...feedback(video, { trigger, response: regionOf(m.response, m.kind), after, minMass }) };
    }
    const region = regionOf(m.region, m.kind);
    if (m.kind === 'transition')
      return {
        kind: m.kind,
        region: m.region,
        result: transition(video, { region, mode: m.mode, after: when(m.after, marks, first), palette, minMass }),
      };
    const series = changeSeries(video, region);
    if (m.kind === 'cadence')
      return { kind: m.kind, region: m.region, ...cadence(series, when(m.from, marks, first), when(m.to, marks, last), minMass) };
    if (m.kind === 'deadAir')
      return {
        kind: m.kind,
        region: m.region,
        ...deadAir(series, when(m.from, marks, first), when(m.to, marks, last), m.limitMs, minMass),
      };
    if (m.kind === 'dropped') return { kind: m.kind, region: m.region, ...droppedFrames(video, runs(series, { minMass })) };
    return { kind: m.kind, region: m.region, ...layoutShift(video, region, m.maxPx) };
  }
}

/**
 * The easing tokens of an easing-token file's motion record (`var:` keys whose value is one cubic-bezier) as a
 * palette, named `<vendor>:<token>`, plus the CSS keywords.
 * @param {{ vendor: string, motion?: Record<string, { value: string }> }} inv
 */
export function paletteFrom(inv) {
  /** @type {Record<string, Curve>} */
  const out = { ...CSS_EASINGS };
  for (const [key, { value }] of Object.entries(inv.motion ?? {})) {
    const m = /^cubic-bezier\(\s*([^,()]+),([^,()]+),([^,()]+),([^,()]+)\)$/.exec(value);
    if (!key.startsWith('var:') || !m) continue;
    const curve = m.slice(1).map(Number);
    if (curve.every(Number.isFinite)) out[`${inv.vendor}:${key.slice(4)}`] = /** @type {Curve} */ (curve);
  }
  return out;
}
