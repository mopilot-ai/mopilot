// Motion capture over CDP (#1511): the Animation domain's events reduced to each running animation's exact timing (duration, delay, easing, iterations, keyframes, the element it ran on), per-element summaries, and the screencast frames' timeline for the frame metrics.

/**
 * One animation as the page ran it.
 * @typedef {{ id: string, type: string, name: string, startMs: number | null, durationMs: number, delayMs: number,
 *   endDelayMs: number, iterations: number | null, easing: string, direction: string, fill: string,
 *   keyframes: { offset: string, easing: string }[], backendNodeId: number | null, label: string | null,
 *   canceled: boolean }} AnimationRecord
 * @typedef {{ label: string, type: string, name: string, count: number, durations: number[], delays: number[],
 *   easings: string[], firstMs: number }} AnimationGroup
 */

const num = (/** @type {unknown} */ v, /** @type {number} */ fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * An Animation domain `Animation` object as a record, with its start relative to `originMs` (ms of the page's
 * timeline the capture started at). An infinite iteration count is null.
 * @param {any} a @param {number} originMs
 * @returns {AnimationRecord}
 */
export function animationRecord(a, originMs) {
  const s = a?.source ?? {};
  const start = typeof a?.startTime === 'number' && a.startTime > 0 ? Math.round(a.startTime - originMs) : null;
  return {
    id: String(a?.id ?? ''),
    type: String(a?.type ?? 'unknown'),
    name: String(a?.name ?? ''),
    startMs: start,
    durationMs: num(s.duration, 0),
    delayMs: num(s.delay, 0),
    endDelayMs: num(s.endDelay, 0),
    iterations: s.iterations === null || s.iterations === Number.POSITIVE_INFINITY ? null : num(s.iterations, 1),
    easing: String(s.easing ?? 'linear'),
    direction: String(s.direction ?? 'normal'),
    fill: String(s.fill ?? 'none'),
    keyframes: Array.isArray(s.keyframesRule?.keyframes)
      ? s.keyframesRule.keyframes.map((/** @type {any} */ k) => ({ offset: String(k.offset), easing: String(k.easing) }))
      : [],
    backendNodeId: typeof s.backendNodeId === 'number' ? s.backendNodeId : null,
    label: null,
    canceled: false,
  };
}

/**
 * Collects Animation domain events: `Animation.animationStarted` records an animation (a later start of the same id
 * replaces it), `Animation.animationCanceled` marks it. `originMs` is set from the first event's page time unless
 * given.
 */
export function animationLog(/** @type {number | null} */ originMs = null) {
  /** @type {Map<string, AnimationRecord>} */
  const byId = new Map();
  let origin = originMs;
  return {
    /** Handles one CDP event; returns whether it was an Animation domain event this log keeps. */
    onEvent(/** @type {string} */ method, /** @type {any} */ params) {
      if (method === 'Animation.animationStarted') {
        const a = params?.animation;
        if (!a?.id) return false;
        if (origin === null) origin = num(a.startTime, 0);
        byId.set(String(a.id), animationRecord(a, origin));
        return true;
      }
      if (method === 'Animation.animationCanceled') {
        const r = byId.get(String(params?.id));
        if (r) r.canceled = true;
        return !!r;
      }
      return false;
    },
    /** The backend node ids still to label. */
    unlabeled() {
      return [
        ...new Set(
          [...byId.values()]
            .filter((r) => r.label === null && r.backendNodeId !== null)
            .map((r) => /** @type {number} */ (r.backendNodeId)),
        ),
      ];
    },
    /** Gives every record on `backendNodeId` its element label. */
    label(/** @type {number} */ backendNodeId, /** @type {string} */ text) {
      for (const r of byId.values()) if (r.backendNodeId === backendNodeId) r.label = text;
    },
    /** The records in start order (unstarted last). */
    records() {
      return [...byId.values()].sort(
        (a, b) => (a.startMs ?? Number.POSITIVE_INFINITY) - (b.startMs ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id),
      );
    },
  };
}

/** Attributes worth naming an element by: its role in the UI, not its content. */
const LABEL_ATTRS = /^(?:role|aria-label|data-[\w-]+)$/;

/**
 * An element as a short label from a `DOM.describeNode` node: tag, id, up to three classes and the attributes that
 * name its role (`div.approval-card[data-state]`). Text content is never part of it.
 */
export function labelOf(/** @type {any} */ node) {
  if (!node || typeof node.nodeName !== 'string') return 'unknown';
  const attrs = Array.isArray(node.attributes) ? node.attributes : [];
  /** @type {Record<string, string>} */
  const map = {};
  for (let i = 0; i + 1 < attrs.length; i += 2) map[attrs[i]] = attrs[i + 1];
  let out = node.nodeName.toLowerCase();
  if (node.pseudoType) out = `${out}::${node.pseudoType}`;
  if (map.id) out += `#${map.id}`;
  for (const c of (map.class ?? '').split(/\s+/).filter(Boolean).slice(0, 3)) out += `.${c}`;
  for (const k of Object.keys(map)
    .filter((k) => LABEL_ATTRS.test(k))
    .sort())
    out += k === 'aria-label' || k === 'role' ? `[${k}=${map[k]}]` : `[${k}]`;
  return out;
}

const uniqNumbers = (/** @type {number[]} */ xs) => [...new Set(xs)].sort((a, b) => a - b);
const uniqTexts = (/** @type {string[]} */ xs) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));

/** Animations grouped by element label, type and name: how often each ran and with which timings, first seen first. */
export function summarize(/** @type {AnimationRecord[]} */ records) {
  /** @type {Map<string, AnimationGroup>} */
  const groups = new Map();
  for (const r of records) {
    const label = r.label ?? 'unlabeled';
    const key = `${label}\0${r.type}\0${r.name}`;
    const g = groups.get(key) ?? {
      label,
      type: r.type,
      name: r.name,
      count: 0,
      durations: [],
      delays: [],
      easings: [],
      firstMs: r.startMs ?? Number.POSITIVE_INFINITY,
    };
    g.count += 1;
    g.durations.push(r.durationMs);
    g.delays.push(r.delayMs);
    g.easings.push(r.easing);
    g.firstMs = Math.min(g.firstMs, r.startMs ?? Number.POSITIVE_INFINITY);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, durations: uniqNumbers(g.durations), delays: uniqNumbers(g.delays), easings: uniqTexts(g.easings) }))
    .sort((a, b) => a.firstMs - b.firstMs || a.label.localeCompare(b.label));
}

/** The summary as a markdown table. */
export function summaryTable(/** @type {AnimationGroup[]} */ groups) {
  const cell = (/** @type {string} */ s) => s.replace(/\|/g, '\\|');
  const out = [
    '| First (ms) | Element | Type | Name | Runs | Duration (ms) | Delay (ms) | Easing |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const g of groups) {
    const first = Number.isFinite(g.firstMs) ? String(g.firstMs) : '–';
    out.push(
      `| ${first} | \`${cell(g.label)}\` | ${g.type} | ${cell(g.name) || '–'} | ${g.count} | ${g.durations.join(', ')} | ${g.delays.join(', ')} | \`${cell(g.easings.join(' / '))}\` |`,
    );
  }
  return `${out.join('\n')}\n`;
}

/**
 * Screencast frames kept as files: `Page.screencastFrame` gives each frame's wall-clock time in seconds; frames.json
 * lists them for bench/motion/decode.swift, with times relative to the first frame.
 */
export function screencastLog() {
  /** @type {{ file: string, wall: number }[]} */
  const frames = [];
  return {
    /** Records one frame; returns the file name to save its image under. */
    add(/** @type {{ metadata?: { timestamp?: number } }} */ params, /** @type {number} */ fallbackWallMs) {
      const wall = typeof params?.metadata?.timestamp === 'number' ? params.metadata.timestamp * 1000 : fallbackWallMs;
      const file = `${String(frames.length).padStart(6, '0')}.jpg`;
      frames.push({ file, wall });
      return file;
    },
    /** The first frame's wall-clock ms, or null before any. */
    origin() {
      return frames.length ? frames[0].wall : null;
    },
    /** decode.swift's frames.json: each file and its time in seconds from the first frame. */
    index() {
      const o = frames.length ? frames[0].wall : 0;
      return frames.map((f) => ({ file: f.file, t: Math.round(f.wall - o) / 1000 }));
    },
  };
}
