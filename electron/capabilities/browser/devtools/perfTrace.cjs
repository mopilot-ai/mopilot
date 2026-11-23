// browser_perf_trace: a Chrome performance trace of one tab (CDP Tracing, streamed to a .json file in the chat's upload folder, which DevTools' Performance panel and Perfetto open) and a short insight summary read from it: LCP, CLS, INP, FCP and long tasks.
//
// One trace per chat. It ends on stop, after MAX_MS (Chrome's own buffer would drop the start otherwise), or when the
// chat's turn ends (the debugger lets go then); a trace that ended on its own is saved and the next call says where.
const { fs } = require('../../../platform/ports/fs.cjs');
const { noteIgnored } = require('../../../ignored.cjs');
const { ToolError } = require('../../contract/registry.cjs');
const { rate } = require('./vitals.cjs');

const MAX_MS = 60_000;
/** The most of a trace that is read back (a busy page traces ~1 MB a second). */
const MAX_BYTES = 256 * 1024 * 1024;
const READ_CHUNK = 4 * 1024 * 1024;
const CATEGORIES = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'toplevel',
  'blink.user_timing',
  'loading',
  'latencyInfo',
  'v8.execute',
];

/**
 * What a trace says, from its events: LCP and FCP after the last navigation start, CLS as the largest session window,
 * INP from the longest interaction, long tasks (> 50 ms) of the page's main thread.
 * @param {any[]} events
 */
function insights(events) {
  const mainPid = new Set();
  const mainTid = new Set();
  for (const e of events)
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') {
      mainPid.add(e.pid);
      mainTid.add(`${e.pid}:${e.tid}`);
    }
  let navAt = -Infinity;
  for (const e of events)
    if (e.name === 'navigationStart' && (!mainPid.size || mainPid.has(e.pid)) && e.args?.data?.isLoadingMainFrame !== false && e.ts > navAt)
      navAt = e.ts;
  const since = (/** @type {number} */ ts) => (navAt === -Infinity ? null : Math.round((ts - navAt) / 1000));
  let lcp = /** @type {{ ts: number, size: number } | null} */ (null);
  let fcp = /** @type {number | null} */ (null);
  let shifts = [];
  /** interactionId -> longest duration (ms) */
  const inter = new Map();
  let longTasks = { count: 0, totalMs: 0, longestMs: 0 };
  for (const e of events) {
    if (e.name === 'largestContentfulPaint::Candidate' && e.ts >= navAt && (!lcp || e.ts >= lcp.ts))
      lcp = { ts: e.ts, size: e.args?.data?.size };
    else if (e.name === 'firstContentfulPaint' && e.ts >= navAt && fcp == null) fcp = e.ts;
    else if (e.name === 'LayoutShift' && !e.args?.data?.had_recent_input)
      shifts.push({ ts: e.ts, v: Number(e.args?.data?.weighted_score_delta ?? e.args?.data?.score ?? 0) });
    else if (e.name === 'EventTiming' && e.ph === 'b' && e.args?.data?.interactionId) {
      const d = e.args.data;
      inter.set(d.interactionId, Math.max(inter.get(d.interactionId) ?? 0, Number(d.duration) || 0));
    } else if (e.name === 'RunTask' && e.ph === 'X' && e.dur > 50_000 && (!mainTid.size || mainTid.has(`${e.pid}:${e.tid}`))) {
      const ms = Math.round(e.dur / 1000);
      longTasks = { count: longTasks.count + 1, totalMs: longTasks.totalMs + ms, longestMs: Math.max(longTasks.longestMs, ms) };
    }
  }
  shifts = shifts.sort((a, b) => a.ts - b.ts);
  let cls = 0;
  let win = { v: 0, first: 0, last: 0 };
  for (const s of shifts) {
    if (win.v && s.ts - win.last < 1e6 && s.ts - win.first < 5e6) win = { ...win, v: win.v + s.v, last: s.ts };
    else win = { v: s.v, first: s.ts, last: s.ts };
    cls = Math.max(cls, win.v);
  }
  const durations = [...inter.values()].sort((a, b) => b - a);
  const inp = durations.length ? Math.round(durations[Math.min(durations.length - 1, Math.floor(durations.length / 50))]) : null;
  return {
    lcp: lcp ? since(lcp.ts) : null,
    fcp: fcp == null ? null : since(fcp),
    cls: Math.round(cls * 1000) / 1000,
    inp,
    interactions: durations.length,
    longTasks,
    navigated: navAt !== -Infinity,
  };
}

/** The insight summary as the tool's text. */
function insightText(/** @type {ReturnType<typeof insights>} */ i) {
  const v = (/** @type {any} */ name, /** @type {number | null} */ value, unit = ' ms') =>
    value == null ? `${name.toUpperCase()} not measured` : `${name.toUpperCase()} ${value}${unit} (${rate(name, value)})`;
  return [
    `${v('lcp', i.lcp)}, ${v('fcp', i.fcp)}, ${v('cls', i.cls, '')}, ${v('inp', i.inp)}${i.inp == null ? ' (no interaction)' : ` over ${i.interactions} interactions`}.`,
    `Long tasks on the main thread: ${i.longTasks.count}${i.longTasks.count ? ` (${i.longTasks.totalMs} ms in all, longest ${i.longTasks.longestMs} ms)` : ''}.`,
    i.navigated ? '' : 'No navigation was traced: LCP and FCP need a reload or navigation while tracing.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** @typedef {{ tab: any, file: string, started: number, timer: any, done: Promise<any> | null, why: string | null }} Trace */

class PerfTraces {
  /** @param {{ now?: () => number, maxMs?: number, maxBytes?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} o */
  constructor({ now = Date.now, maxMs = MAX_MS, maxBytes = MAX_BYTES, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.now = now;
    this.maxMs = maxMs;
    this.maxBytes = maxBytes;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** @type {Map<string, Trace>} */
    this.chats = new Map();
    /** chat -> the result of a trace that ended on its own */
    this.ended = new Map();
  }

  /** Starts tracing `tab` into `file`. Refuses while the chat traces. */
  async start(/** @type {string} */ chatId, tab, /** @type {string} */ file) {
    if (this.chats.has(chatId)) throw new ToolError('A trace is already running in this chat. Stop it first (action "stop").', 'bad_args');
    this.ended.delete(chatId);
    await tab.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      streamFormat: 'json',
      traceConfig: { includedCategories: CATEGORIES, recordMode: 'recordUntilFull' },
    });
    /** @type {Trace} */
    const t = { tab, file, started: this.now(), timer: null, done: null, why: null };
    t.timer = this.setTimer(() => {
      t.why = 'it reached 60 seconds';
      const r = this.stop(chatId);
      this.ended.set(chatId, r);
      // the next call tells what happened; until then a failure is only noted
      r.catch((/** @type {unknown} */ error) => noteIgnored('save a trace that reached its cap', error));
    }, this.maxMs);
    this.chats.set(chatId, t);
  }

  /** Ends the chat's trace; resolves with { file, bytes, ms, insights }, or null when nothing traced. */
  stop(/** @type {string} */ chatId) {
    const t = this.chats.get(chatId);
    if (!t) return this.ended.get(chatId) ?? null;
    this.chats.delete(chatId);
    this.clearTimer(t.timer);
    t.done = this.#collect(t).catch((/** @type {unknown} */ e) => {
      // nothing usable was saved: neither the empty file nor a partial read stays
      fs.rmSync(t.file, { force: true });
      fs.rmSync(`${t.file}.part`, { force: true });
      throw e;
    });
    return t.done.then((r) => ({ ...r, why: t.why }));
  }

  endTurn(/** @type {string} */ chatId) {
    const t = this.chats.get(chatId);
    if (!t) return;
    t.why = 'the turn ended';
    const r = this.stop(chatId);
    this.ended.set(chatId, r);
    r.catch((/** @type {unknown} */ error) => noteIgnored('save a trace when its turn ended', error));
  }

  /** The result of a trace that ended on its own, once. */
  takeEnded(/** @type {string} */ chatId) {
    const r = this.ended.get(chatId) ?? null;
    this.ended.delete(chatId);
    return r;
  }

  /** Tracing.end, then the stream Chrome names in Tracing.tracingComplete, read into the file. */
  async #collect(/** @type {Trace} */ t) {
    const dbg = t.tab.backend?.debugger;
    /** @type {any} */
    let timer = null;
    /** @type {any} */
    let on = null;
    const off = () => {
      this.clearTimer(timer);
      dbg?.removeListener?.('message', on);
    };
    const complete = new Promise((resolve, reject) => {
      timer = this.setTimer(() => {
        off();
        reject(new ToolError('The trace did not finish in time.', 'failed'));
      }, 30_000);
      on = (/** @type {any} */ _e, /** @type {string} */ method, /** @type {any} */ p, /** @type {string} */ sessionId) => {
        if (method !== 'Tracing.tracingComplete' || sessionId) return;
        off();
        resolve(p);
      };
      if (typeof dbg?.on !== 'function') {
        off();
        reject(new ToolError('This tab has no debugger to trace.', 'failed'));
        return;
      }
      dbg.on('message', on);
    });
    /** @type {any} */
    let done;
    try {
      // both settle here: a Tracing.end that fails leaves no wait (or its timer) behind
      [, done] = await Promise.all([t.tab.send('Tracing.end'), complete]);
    } finally {
      off();
    }
    if (!done?.stream) throw new ToolError(`Chrome kept no trace${done?.dataLossOccurred ? ' (its buffer overflowed)' : ''}.`, 'failed');
    const fd = fs.openSync(`${t.file}.part`, 'w', 0o600);
    let bytes = 0;
    try {
      for (;;) {
        const r = await t.tab.send('IO.read', { handle: done.stream, size: READ_CHUNK });
        const chunk = r.base64Encoded ? Buffer.from(r.data, 'base64') : Buffer.from(String(r.data ?? ''), 'utf8');
        if (bytes + chunk.length > this.maxBytes) throw new ToolError('The trace is larger than 256 MB: trace a shorter span.', 'failed');
        fs.writeSync(fd, chunk);
        bytes += chunk.length;
        if (r.eof) break;
      }
    } finally {
      fs.closeSync(fd);
      t.tab.send('IO.close', { handle: done.stream }).catch((/** @type {unknown} */ error) => noteIgnored('close a trace stream', error));
    }
    const parsed = JSON.parse(fs.readFileSync(`${t.file}.part`, 'utf8'));
    const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
    fs.renameSync(`${t.file}.part`, t.file);
    return {
      file: t.file,
      bytes,
      ms: this.now() - t.started,
      events: events.length,
      insights: insights(events),
      lost: !!done.dataLossOccurred,
    };
  }
}

module.exports = { PerfTraces, insights, insightText, CATEGORIES, MAX_MS, MAX_BYTES };
