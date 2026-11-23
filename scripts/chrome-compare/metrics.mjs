// The Chrome comparison's metrics: per run, the tool calls a chat made (from MoPilot's operation log or the transcript), and per arm and harness, success, time, calls, invalid calls and cards.

/** Outcomes of a call the model got wrong (bad arguments, a tool it does not have, a stale ref), not a refusal or a page failure. */
const INVALID = new Set(['bad_args', 'unknown_tool', 'stale_ref', 'hidden']);

/**
 * The calls in MoPilot's operation log (userData/capabilities/operations.jsonl lines) between `from` and
 * `to` (ms), of one chat when `chatId` is given: their count and how many were invalid.
 * @param {string} text the log file's contents
 * @param {{ chatId?: string | null, from: number, to: number }} o
 */
export function callsFromLog(text, { chatId = null, from, to }) {
  let calls = 0;
  let invalid = 0;
  for (const line of String(text).split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || (chatId !== null && e.chatId !== chatId) || !(e.at >= from && e.at <= to)) continue;
    calls++;
    if (INVALID.has(e.outcome)) invalid++;
  }
  return { calls, invalid };
}

/** The median of a list that has values. */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Per arm and harness: runs, success rate, median seconds, mean tool calls, invalid calls and cards.
 * @param {{ arm: string, harness: string, task: string, ok: boolean, ms: number, calls: number | null, invalid: number | null, cards: number, resultChars?: number }[]} runs
 */
export function summarize(runs) {
  /** @type {Map<string, typeof runs>} */
  const groups = new Map();
  for (const r of runs) {
    const key = `${r.arm}|${r.harness}`;
    if (!groups.has(key)) groups.set(key, []);
    /** @type {typeof runs} */ (groups.get(key)).push(r);
  }
  return [...groups].map(([key, rs]) => {
    const [arm, harness] = key.split('|');
    const known = (k) => rs.map((r) => r[k]).filter((v) => typeof v === 'number');
    return {
      arm,
      harness,
      runs: rs.length,
      success: rs.filter((r) => r.ok).length / rs.length,
      medianSeconds: median(rs.map((r) => r.ms / 1000)),
      meanCalls: mean(known('calls')),
      meanInvalid: mean(known('invalid')),
      meanCards: mean(rs.map((r) => r.cards)),
      meanChars: mean(known('resultChars')),
    };
  });
}

const fmt = (v, digits = 1) => (v === null ? 'n/a' : Number(v).toFixed(digits));

/** The summary as a Markdown table. */
export function table(rows) {
  const head =
    '| Arm | Harness | Runs | Success | Median s | Calls | Invalid | Cards | Result chars |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const body = rows.map(
    (r) =>
      `| ${r.arm} | ${r.harness} | ${r.runs} | ${Math.round(r.success * 100)}% | ${fmt(r.medianSeconds)} | ${fmt(r.meanCalls)} | ${fmt(r.meanInvalid)} | ${fmt(r.meanCards)} | ${fmt(r.meanChars, 0)} |`,
  );
  return [head, ...body].join('\n');
}
