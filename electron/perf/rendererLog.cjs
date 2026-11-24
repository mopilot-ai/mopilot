// The always-on renderer record (#5398, #5402): what a window could not do in time (a long task, a slow input event) and what the composer refused, as content-free lines in a bounded <userData>/perf/renderer.jsonl, so a report of lag or of keys that did nothing can be read after the fact. A window sends its own lines; this keeps only known kinds, numbers and short words, never text, ids or paths.
const path = require('node:path');
const { createBoundedLog } = require('./stalls.cjs');

/** Lines one window may add per minute; the rest are counted into the next line. */
const PER_MINUTE = 30;
const KINDS = new Set(['longtask', 'slowInput', 'composerRefused', 'composerComposition', 'composerBusyReleased']);
const WHY = new Set(['locked', 'preparing', 'starting']);
// Each word a line may carry comes from a fixed list, so a field that ever carried a chat title, a path or a tool name is dropped, not kept.
/** The app's routes (shared/model/window.d.ts Route; tests/rendererLog.test.ts keeps the two equal). */
const ROUTES = new Set(['cloud', 'home', 'momo', 'plugins', 'projects', 'review', 'scheduled', 'settings', 'thread']);
/** The event names the browser's Event Timing reports. */
const EVENTS = new Set(
  'auxclick click contextmenu dblclick mousedown mouseenter mouseleave mouseout mouseover mouseup pointerover pointerenter pointerdown pointerup pointercancel pointerout pointerleave gotpointercapture lostpointercapture touchstart touchend touchcancel keydown keypress keyup beforeinput input compositionstart compositionupdate compositionend dragstart dragend dragenter dragleave dragover drop'.split(
    ' ',
  ),
);
/** The input types a text editor reports (InputEvent.inputType), and `input` for an event with none. */
const INPUT_TYPES = new Set(
  'input insertText insertReplacementText insertLineBreak insertParagraph insertFromPaste insertFromDrop insertFromYank insertTranspose insertCompositionText insertFromComposition insertLink deleteWordBackward deleteWordForward deleteSoftLineBackward deleteSoftLineForward deleteEntireSoftLine deleteHardLineBackward deleteHardLineForward deleteByDrag deleteByCut deleteContent deleteContentBackward deleteContentForward historyUndo historyRedo'.split(
    ' ',
  ),
);
const WORDS = { route: ROUTES, name: EVENTS, inputType: INPUT_TYPES };
const COUNTS = ['ms', 'delay', 'processing', 'rows', 'messages', 'count'];
const MAX_COUNT = 10_000_000;

/** @type {{ log: { append(line: string): unknown }, now: () => number } | null} */
let active = null;
/** @type {Map<number, { minute: number, n: number, dropped: number }>} */
const windows = new Map();

/** The line a window may add for what it sent, or null for anything that is not one of the known kinds. @param {any} raw */
function clean(raw) {
  if (!raw || typeof raw !== 'object' || !KINDS.has(raw.what)) return null;
  /** @type {Record<string, unknown>} */
  const line = { what: raw.what };
  for (const key of COUNTS) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) line[key] = Math.min(MAX_COUNT, Math.round(v));
  }
  for (const [key, allowed] of Object.entries(WORDS)) if (typeof raw[key] === 'string' && allowed.has(raw[key])) line[key] = raw[key];
  if (WHY.has(raw.why)) line.why = raw.why;
  for (const key of ['focused', 'visible']) if (typeof raw[key] === 'boolean') line[key] = raw[key];
  return line;
}

/**
 * Starts the record in `dir` (the user data folder). Deps are for tests.
 * @param {{ dir: string, log?: { append(line: string): unknown }, now?: () => number, env?: Record<string, string | undefined> }} o
 */
function startRendererLog({ dir, log = createBoundedLog(path.join(dir, 'perf', 'renderer.jsonl')), now = Date.now, env = process.env }) {
  windows.clear();
  // the opt-out (docs/performance/measurement.md): set MOPILOT_NO_RENDERER_RECORD to anything but 0 or an empty text and nothing is written
  const off = !!env.MOPILOT_NO_RENDERER_RECORD && env.MOPILOT_NO_RENDERER_RECORD !== '0';
  active = off ? null : { log, now };
}

/** Forgets what window `windowId` sent: it closed. @param {number} windowId */
function forgetRendererWindow(windowId) {
  windows.delete(windowId);
}

/** Adds what window `windowId` sent, when it is a known kind and the window has not sent too many this minute. @param {number} windowId @param {unknown} raw */
function recordRenderer(windowId, raw) {
  if (!active) return false;
  const line = clean(raw);
  if (!line) return false;
  const t = active.now();
  const minute = Math.floor(t / 60_000);
  const seen = windows.get(windowId) ?? { minute, n: 0, dropped: 0 };
  if (seen.minute !== minute) Object.assign(seen, { minute, n: 0 });
  windows.set(windowId, seen);
  if (seen.n >= PER_MINUTE) {
    seen.dropped += 1;
    return false;
  }
  seen.n += 1;
  const dropped = seen.dropped;
  seen.dropped = 0;
  void active.log.append(JSON.stringify({ t, kind: 'renderer', window: windowId, ...line, ...(dropped ? { dropped } : {}) }));
  return true;
}

module.exports = { PER_MINUTE, ROUTES, startRendererLog, recordRenderer, forgetRendererWindow };
