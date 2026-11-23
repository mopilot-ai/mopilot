// browser_vitals: the page's Core Web Vitals (LCP, CLS, INP) and FCP, TTFB and long tasks, read in an isolated world from the page's performance timeline, with Google's good / needs-improvement / poor thresholds.

/**
 * Runs in the page (serialized: no outer names). Observes the buffered timeline for `waitMs`, then resolves with the metrics.
 * @param {{ waitMs?: number }} opts
 */
function pageVitals(opts) {
  const waitMs = Math.max(0, Math.min(5000, Number(opts?.waitMs ?? 250)));
  const out = {
    // no query or fragment: either may carry a token
    url: `${location.origin}${location.pathname}`,
    lcp: /** @type {any} */ (null),
    cls: 0,
    inp: /** @type {any} */ (null),
    fcp: /** @type {number | null} */ (null),
    ttfb: /** @type {number | null} */ (null),
    load: /** @type {number | null} */ (null),
    longTasks: { count: 0, totalMs: 0, longestMs: 0 },
    interactions: 0,
  };
  const describe = (/** @type {any} */ el) => {
    if (!el || !el.tagName) return '';
    const id = el.id ? `#${el.id}` : '';
    const cls = !id && typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  // CLS: the largest session window (shifts less than 1 s apart, at most 5 s long)
  let win = { value: 0, first: 0, last: 0 };
  /** interactionId -> its longest event */
  const inter = new Map();
  /** @type {PerformanceObserver[]} */
  const observers = [];
  const take = (/** @type {string} */ type, /** @type {(e: any) => void} */ fn, extra = {}) => {
    try {
      const o = new PerformanceObserver((list) => list.getEntries().forEach(fn));
      o.observe({ type, buffered: true, ...extra });
      observers.push(o);
      return true;
    } catch {
      // an entry type this browser doesn't have
      return false;
    }
  };
  take('largest-contentful-paint', (e) => {
    out.lcp = { ms: Math.round(e.startTime), element: describe(e.element), size: e.size };
  });
  take('layout-shift', (e) => {
    if (e.hadRecentInput) return;
    if (win.value && e.startTime - win.last < 1000 && e.startTime - win.first < 5000) {
      win.value += e.value;
      win.last = e.startTime;
    } else win = { value: e.value, first: e.startTime, last: e.startTime };
    out.cls = Math.max(out.cls, win.value);
  });
  take(
    'event',
    (e) => {
      if (!e.interactionId) return;
      const was = inter.get(e.interactionId);
      if (!was || e.duration > was.duration) inter.set(e.interactionId, { duration: e.duration, name: e.name, target: describe(e.target) });
    },
    { durationThreshold: 16 },
  );
  take('paint', (e) => {
    if (e.name === 'first-contentful-paint') out.fcp = Math.round(e.startTime);
  });
  const long = (/** @type {any} */ e) => {
    if (e.duration < 50) return;
    out.longTasks.count++;
    out.longTasks.totalMs += Math.round(e.duration);
    out.longTasks.longestMs = Math.max(out.longTasks.longestMs, Math.round(e.duration));
  };
  // long animation frames are buffered from the page's start; long tasks only where those are missing
  if (!take('long-animation-frame', long)) take('longtask', long);
  const nav = /** @type {any} */ (performance.getEntriesByType('navigation')[0]);
  if (nav) {
    out.ttfb = Math.round(nav.responseStart);
    out.load = nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd) : null;
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      for (const o of observers) o.disconnect();
      // INP: the longest interaction, or with many the 98th percentile (one left out per 50)
      const all = [...inter.values()].sort((a, b) => b.duration - a.duration);
      out.interactions = all.length;
      const pick = all[Math.min(all.length - 1, Math.floor(all.length / 50))];
      if (pick) out.inp = { ms: Math.round(pick.duration), event: pick.name, target: pick.target };
      out.cls = Math.round(out.cls * 1000) / 1000;
      resolve(out);
    }, waitMs);
  });
}

const VITALS_SOURCE = `(${pageVitals.toString()})`;

/** Google's thresholds: [good at most, poor above]. */
const THRESHOLDS = Object.freeze({ lcp: [2500, 4000], cls: [0.1, 0.25], inp: [200, 500], fcp: [1800, 3000], ttfb: [800, 1800] });

/** 'good', 'needs improvement' or 'poor' for a metric's value. */
function rate(/** @type {keyof typeof THRESHOLDS} */ metric, /** @type {number} */ value) {
  const [good, poor] = THRESHOLDS[metric];
  return value <= good ? 'good' : value > poor ? 'poor' : 'needs improvement';
}

/** The metrics as the tool's text. */
function vitalsText(/** @type {any} */ v) {
  const line = (/** @type {any} */ name, /** @type {number | null} */ value, /** @type {string} */ unit, extra = '') =>
    value == null ? `${name.toUpperCase()}: not measured${extra}` : `${name.toUpperCase()}: ${value}${unit} (${rate(name, value)})${extra}`;
  return [
    `Web Vitals of ${v.url}:`,
    line('lcp', v.lcp?.ms ?? null, ' ms', v.lcp?.element ? `, ${v.lcp.element}` : ''),
    line('cls', v.cls, ''),
    line(
      'inp',
      v.inp?.ms ?? null,
      ' ms',
      v.inp ? `, ${v.inp.event}${v.inp.target ? ` on ${v.inp.target}` : ''} (${v.interactions} interactions)` : ' (no interaction yet)',
    ),
    line('fcp', v.fcp, ' ms'),
    line('ttfb', v.ttfb, ' ms'),
    `Load: ${v.load == null ? 'not finished' : `${v.load} ms`}. Long tasks: ${v.longTasks.count}${v.longTasks.count ? ` (${v.longTasks.totalMs} ms in all, longest ${v.longTasks.longestMs} ms)` : ''}.`,
  ].join('\n');
}

module.exports = { pageVitals, VITALS_SOURCE, THRESHOLDS, rate, vitalsText };
