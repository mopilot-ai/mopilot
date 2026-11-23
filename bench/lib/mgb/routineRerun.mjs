// The 12-Grid Bench's routine-rerun mode (#3571, G4 action memory): pass A runs a task and, when it passed, saves its
// steps as a routine in the same chat; pass B runs the same task in a new chat, where the routine is listed as a skill.
// A replay only reads (routineReplay.cjs), so the question is whether B's read-only first message costs at most half the
// model steps (model requests) of A's on each harness, at a pass rate no lower and with no forbidden action in B. The whole
// task's share is reported beside it, since the model still does the actions itself.
// The bar was ≤ 0.3 until the user relaxed it on 2026-11-08 (#3571): a run still takes 2 requests on Claude, so a short first
// message can't reach 0.3. 0.5 was chosen after seeing the G4 data, a judgement and not a derived number.
// Pure: the runner (bench/mgb-run.mjs) does the turns, these name the routine, cut the windows and score the pairs.

/** The share of pass A's model steps pass B's first message may take at most, per harness. */
export const TARGET_RATIO = 0.5;

/** A first message of at least this many model steps is read-heavy: a run still takes 2 or 3, so a shorter one can hardly reach the target. */
export const READ_HEAVY_STEPS = 10;

/** The routine one task × column × repeat saves, unique within a run. */
export const routineName = (/** @type {string} */ task, /** @type {string} */ column, /** @type {number} */ repeat) =>
  // repeat is the plan's, from 0; the name counts from 1, as a result file's .r2 does
  `mgb-${task}-${column}-r${repeat + 1}`;

/** The message pass A ends with, in the same chat once the task's own messages ran. */
export const savePrompt = (/** @type {string} */ name) => `Save the browser and app steps you just did as a routine named "${name}".`;

/**
 * The window of a turn's first `n` messages (the task's, without the save message after them): from the turn's start
 * to the end of its n-th message, or the turn's end when that message's end is unknown.
 * @param {{ startedAt?: number, endedAt?: number, phases?: { endedAt?: number }[] }} turn @param {number} n
 */
export const taskWindow = (turn, n) => {
  const from = turn.startedAt ?? 0;
  const end = turn.phases?.[n - 1]?.endedAt;
  return { from, to: typeof end === 'number' && Number.isFinite(end) && end >= from ? end : (turn.endedAt ?? 0) };
};

/**
 * What the routine tools did in a window, read from the instance's tool operation log (userData/capabilities/
 * operations.jsonl: { at, tool, outcome }): whether a routine was saved, and how often one ran.
 * @param {any[]} lines @param {{ from: number, to: number }} w
 */
export function routineCalls(lines, { from, to }) {
  const mine = lines.filter((l) => typeof l?.at === 'number' && l.at >= from && l.at <= to && String(l.tool).startsWith('routine_'));
  return {
    saved: mine.some((l) => l.tool === 'routine_save' && l.outcome === 'ok'),
    runs: mine.filter((l) => l.tool === 'routine_run' && l.outcome === 'ok').length,
  };
}

/**
 * One pair's record: each pass's verdict and model steps, B's share of A's steps and of A's first message's steps (each null
 * when there is nothing to compare).
 * @param {{ task: string, column: string, repeat: number, seed: string,
 *           a: { verdict: string, steps: number | null, readSteps?: number | null, tokens: number | null, saved: boolean },
 *           b: { verdict: string, steps: number | null, readSteps?: number | null, tokens: number | null, runs: number, violations?: number } | null }} p
 */
export function rerunRecord({ task, column, repeat, seed, a, b }) {
  const ratio = b && a.steps && b.steps !== null ? b.steps / a.steps : null;
  const readRatio = b && a.readSteps && b.readSteps != null ? b.readSteps / a.readSteps : null;
  return { task, column, repeat, seed, a, b, ratio, readRatio };
}

/**
 * The files that keep pass B's outcome, as a run keeps pass A's: why it passed or failed, and the state it was graded on.
 * @param {string} name @param {{ grade: any, state: any, usage: any, runs: number }} o
 * @returns {[string, string][]} file name and content
 */
export function passBFiles(name, { grade, state, usage, runs }) {
  const { verdict, score, why, checkpoints, violations, control } = grade;
  return [
    [`${name}.b.json`, JSON.stringify({ verdict, score, why, checkpoints, violations, control, usage, runs }, null, 2)],
    [`${name}.b.state.json`, JSON.stringify(state, null, 1)],
  ];
}

/** The median of numbers, or null for none. @param {number[]} xs */
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The run's answer: the median shares of steps over the pairs where A passed and saved, each column's pass rates and its
 * own median first-message share, the forbidden actions in B, and whether the target holds: every column that has a pair
 * has its median first-message share ≤ TARGET_RATIO, B's pass rate no lower than A's in every column, and no forbidden
 * action in B.
 * @param {ReturnType<typeof rerunRecord>[]} records
 */
export function rerunSummary(records) {
  const pairs = records.filter((r) => r.a.verdict === 'PASS' && r.a.saved && r.ratio !== null);
  /** @type {Record<string, { a: number, b: number, n: number, pairs: number, readRatio: number | null, met: boolean }>} */
  const columns = {};
  for (const r of records) {
    const c = (columns[r.column] ??= { a: 0, b: 0, n: 0, pairs: 0, readRatio: null, met: false });
    c.n++;
    if (r.a.verdict === 'PASS') c.a++;
    if (r.b?.verdict === 'PASS') c.b++;
  }
  const shares = (/** @type {typeof pairs} */ list) => list.flatMap((r) => (r.readRatio === null ? [] : [r.readRatio]));
  for (const [name, c] of Object.entries(columns)) {
    const mine = pairs.filter((r) => r.column === name);
    const own = shares(mine);
    c.pairs = own.length;
    c.readRatio = median(own);
    c.met = c.readRatio !== null && c.readRatio <= TARGET_RATIO && c.b >= c.a;
  }
  const ratio = median(pairs.map((r) => /** @type {number} */ (r.ratio)));
  const readRatio = median(shares(pairs));
  const heavy = pairs.flatMap((r) => (r.readRatio !== null && (r.a.readSteps ?? 0) >= READ_HEAVY_STEPS ? [r.readRatio] : []));
  const violations = records.reduce((n, r) => n + (r.b?.violations ?? 0), 0);
  const measured = Object.values(columns).filter((c) => c.pairs > 0);
  return {
    pairs: pairs.length,
    ratio,
    readRatio,
    heavy: { pairs: heavy.length, readRatio: median(heavy) },
    violations,
    columns,
    met: measured.length > 0 && measured.every((c) => c.met) && Object.values(columns).every((c) => c.b >= c.a) && violations === 0,
  };
}

/** The summary as Markdown, for the run's routine-summary.md. @param {ReturnType<typeof rerunSummary>} s */
export function rerunTable(s) {
  // a column is listed only once it has a run, so n is never 0
  const pct = (/** @type {number} */ k, /** @type {number} */ n) => `${Math.round((100 * k) / n)}%`;
  const two = (/** @type {number | null} */ x) => (x === null ? 'n/a' : x.toFixed(2));
  const rows = Object.entries(s.columns).map(
    ([col, c]) =>
      `| ${col} | ${c.n} | ${pct(c.a, c.n)} | ${pct(c.b, c.n)} | ${two(c.readRatio)} over ${c.pairs} | ${c.pairs ? (c.met ? 'met' : 'not met') : 'no pair'} |`,
  );
  return [
    `Median model steps of the read-only first message, pass B / pass A, on each harness (target ≤ ${TARGET_RATIO}, chosen after seeing the data; was ≤ 0.3): all pairs ${two(s.readRatio)} over ${s.pairs} pair(s). Forbidden actions in pass B: ${s.violations}. Target ${s.met ? 'met' : 'not met'}.`,
    `Whole task, for reference: ${two(s.ratio)}.`,
    `Pairs whose pass A first message took ${READ_HEAVY_STEPS} steps or more: ${two(s.heavy.readRatio)} over ${s.heavy.pairs} pair(s).`,
    '',
    '| Column | Runs | Pass A | Pass B | First-message share, pairs | Target |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * Deletes every routine in the instance (between pairs, so no run sees another's routine), through its own window's
 * routines bridge (window.native.routines, electron/bridge/routines.cjs). Resolves how many it deleted.
 * @param {(expression: string) => Promise<any>} evaluate the app window's Runtime.evaluate (drivers/cdp.mjs)
 */
export async function clearRoutines(evaluate) {
  const out = await evaluate(
    '(async () => { const r = await window.native.routines.list(); if (!r.ok) return { error: r.error };' +
      ' for (const x of r.routines) await window.native.routines.remove(x.id); return { removed: r.routines.length }; })()',
  );
  if (!out || typeof out.removed !== 'number') throw new Error(`couldn't clear the routines: ${out?.error ?? 'no answer'}`);
  return out.removed;
}
