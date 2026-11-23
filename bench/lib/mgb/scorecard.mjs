// MoPilot 12-Grid Bench (#1381) scorecard: per grid cell, the native vendor runtime against MoPilot on the same tasks
// and seeds, each success rate with a 95% Wilson interval, red/amber/green, the control-plane and cost columns, a
// before/after diff of two runs, the motion score from each run's screen recording (#1511), and the smoke tier's plan
// (one run per cell).
import { cellId, columnsOf, COLUMNS, SURFACE_NAMES, SURFACES, vendorSupport } from './schema.mjs';

/** The vendor arms: each vendor app runs the tasks with its own browser pane, computer use and Chrome extension. */
export const VENDOR_ARMS = ['desk-claude', 'desk-chatgpt'];
/** Which native arm is a column's bar (#1381 decision): the switch and ACP columns take the better native result. */
export const NATIVE_FOR = { claude: ['desk-claude'], codex: ['desk-chatgpt'], switch: VENDOR_ARMS, acp: VENDOR_ARMS };

/**
 * A 95% Wilson score interval for `pass` successes in `n` runs, as [low, high]; null for no runs.
 * @param {number} pass @param {number} n @returns {[number, number] | null}
 */
export function wilson(pass, n) {
  if (!n) return null;
  const z = 1.96;
  const p = pass / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  const r = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;
  return [r(Math.max(0, mid - half)), r(Math.min(1, mid + half))];
}

/** @param {number[]} xs */
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** A sum of known numbers; null when none is known (unknown is never zero). @param {unknown[]} xs */
const sum = (xs) => {
  const known = /** @type {number[]} */ (xs.filter((x) => typeof x === 'number'));
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

/**
 * The runs of one surface on one arm, summarized. Success counts gradable runs only: UNGRADABLE and N/A are listed
 * apart, never failed. The control columns read only the runs that have control metrics (MoPilot's).
 * @param {any[]} runs records (run.mjs mgbRecord, or a vendor record)
 */
export function cellStats(runs) {
  const gradable = runs.filter((r) => r.verdict !== 'UNGRADABLE' && r.verdict !== 'N/A');
  const pass = gradable.filter((r) => r.verdict === 'PASS').length;
  const control = gradable.map((r) => r.control).filter(Boolean);
  return {
    runs: runs.length,
    gradable: gradable.length,
    pass,
    rate: gradable.length ? Math.round((pass / gradable.length) * 1000) / 1000 : null,
    interval: wilson(pass, gradable.length),
    unsafe: gradable.filter((r) => r.verdict === 'UNSAFE').length,
    ungradable: runs.filter((r) => r.verdict === 'UNGRADABLE').length,
    na: runs.filter((r) => r.verdict === 'N/A').length,
    score: gradable.length ? Math.round((gradable.reduce((s, r) => s + r.score, 0) / gradable.length) * 1000) / 1000 : null,
    overAsked: control.reduce((s, c) => s + c.cards.over, 0),
    underAsked: control.reduce((s, c) => s + c.cards.under, 0),
    deadEnds: control.reduce((s, c) => s + c.deadEnds.length, 0),
    escFails: control.filter((c) => c.escOk === false).length,
    leaks: control.reduce((s, c) => s + c.leaks.length, 0),
    offSurface: gradable.filter((r) => r.offSurface?.length).length,
    medianWallMs: median(gradable.map((r) => r.efficiency?.wallMs).filter((x) => typeof x === 'number')),
    tokens: sum(gradable.map((r) => r.efficiency?.tokens)),
    costUsd: sum(gradable.map((r) => r.efficiency?.costUsd)),
    ...motionStats(gradable),
  };
}

/**
 * The motion side of a cell (#1511), from the runs whose recording was measured (`record.motion`, bench/motion-metrics.mjs
 * --mgb): the median of each run's longest still stretch during its turn, the still stretches over 3 s, and the median
 * of the dropped frames per minute of motion. Null when no run of the cell was recorded. Called with gradable runs only:
 * an UNGRADABLE turn (an outage, a rate limit) is all still time and says nothing about MoPilot's motion.
 * @param {any[]} runs
 */
export function motionStats(runs) {
  const measured = runs.map((r) => r.motion).filter((m) => m && typeof m.longestStillMs === 'number');
  return {
    motionRuns: measured.length,
    stillP50Ms: median(measured.map((m) => m.longestStillMs)),
    stillsOver3s: sum(measured.map((m) => m.stillsOver3s)),
    droppedPerMin: median(measured.map((m) => m.droppedPerMin).filter((x) => typeof x === 'number')),
  };
}

/**
 * Whether MoPilot's motion in a cell is worse than its native arm's (#1511): its median longest still stretch is over
 * a quarter and a second longer, or it drops half again as many frames per minute and two more. A cell that wins on
 * success but loses on motion is amber, not green. False when either side has no recording.
 * @param {ReturnType<typeof motionStats>} mine @param {ReturnType<typeof motionStats> | null} native
 */
export function motionWorse(mine, native) {
  if (!native || !mine.motionRuns || !native.motionRuns) return false;
  // a measured run always has its longest still stretch, so both medians are known here
  const still = /** @type {number} */ (mine.stillP50Ms) > /** @type {number} */ (native.stillP50Ms) * 1.25 + 1000;
  const drops = mine.droppedPerMin !== null && native.droppedPerMin !== null && mine.droppedPerMin > native.droppedPerMin * 1.5 + 2;
  return still || drops;
}

/** The runs of an arm that score in a surface (a record scores in every surface its task uses). @param {any[]} records @param {string} arm @param {string} surface */
const runsOf = (records, arm, surface) => records.filter((r) => r.column === arm && r.surfaces.includes(surface));

/**
 * Red/amber/green for MoPilot against its native bar: red when MoPilot's interval lies wholly below native's, green
 * when wholly above, amber when they overlap; `pending` when either side has no gradable run.
 * @param {[number, number] | null} mine @param {[number, number] | null} native
 */
export function band(mine, native) {
  if (!mine || !native) return 'pending';
  if (mine[1] < native[0]) return 'red';
  if (mine[0] > native[1]) return 'green';
  return 'amber';
}

/**
 * The scorecard: per grid cell, MoPilot's stats, the native bar (the best native arm for that column, on the tasks
 * MoPilot ran there), the delta and the band. `pending` names a native arm that has not been set up (#1319: Claude in
 * Chrome until `claude --chrome` connects in the bench profile), so the cell is pending, never zero.
 * @param {any[]} records MoPilot's and the native arms' records of the same seeds @param {{ pending?: Record<string, string> }} [o]
 */
export function scorecard(records, { pending = {} } = {}) {
  return SURFACES.flatMap((surface) =>
    COLUMNS.map((column) => {
      const mine = cellStats(runsOf(records, column, surface));
      const tasks = new Set(runsOf(records, column, surface).map((r) => r.task));
      const candidates = /** @type {string[]} */ (/** @type {any} */ (NATIVE_FOR)[column])
        .filter((arm) => !pending[`${surface}×${arm}`])
        .map((arm) => ({ arm, stats: cellStats(runsOf(records, arm, surface).filter((r) => tasks.has(r.task))) }))
        .filter((c) => c.stats.gradable > 0)
        .sort((a, b) => /** @type {number} */ (b.stats.rate) - /** @type {number} */ (a.stats.rate));
      const best = candidates[0] ?? null;
      const waiting = /** @type {string[]} */ (/** @type {any} */ (NATIVE_FOR)[column])
        .map((arm) => pending[`${surface}×${arm}`])
        .filter(Boolean);
      const success = band(mine.interval, best?.stats.interval ?? null);
      const motion = motionWorse(mine, best?.stats ?? null);
      return {
        cell: cellId(surface, column),
        surface,
        column,
        mopilot: mine,
        native: best ? { arm: best.arm, ...best.stats } : null,
        delta: best && mine.rate !== null ? Math.round((mine.rate - /** @type {number} */ (best.stats.rate)) * 1000) / 1000 : null,
        // a cell that wins on success but loses on motion is amber, not green (#1511)
        band: success === 'green' && motion ? 'amber' : success,
        motionWorse: motion,
        pending: !best && waiting.length ? waiting[0] : null,
      };
    }),
  );
}

const pct = (/** @type {number | null} */ x) => (x === null ? '—' : `${Math.round(x * 100)}%`);
/** An interval as " [a%–b%]"; only called for a side with gradable runs, which always has one. */
const ci = (/** @type {[number, number] | null} */ i) =>
  ` [${pct(/** @type {[number, number]} */ (i)[0])}–${pct(/** @type {[number, number]} */ (i)[1])}]`;
const secs = (/** @type {number | null} */ ms) => (ms === null ? '—' : `${Math.round(ms / 1000)} s`);
const money = (/** @type {number | null} */ c) => (c === null ? '—' : `$${c.toFixed(2)}`);
const BAND = { red: '🔴 red', amber: '🟡 amber', green: '🟢 green', pending: '⚪ pending' };

/**
 * A cell's motion: MoPilot's median longest still stretch and drops per minute, then the native arm's, marked when
 * MoPilot's is worse; — without a recording.
 * @param {ReturnType<typeof scorecard>[number]} r
 */
function motionCell(r) {
  const m = r.mopilot;
  if (!m.motionRuns) return '—';
  const one = (/** @type {ReturnType<typeof motionStats>} */ x) => `still ${secs(x.stillP50Ms)} · ${x.droppedPerMin ?? '—'} drops/min`;
  const native = r.native?.motionRuns ? ` (native ${one(r.native)})` : '';
  return `${one(m)}${native}${r.motionWorse ? ' ⚠' : ''}`;
}

/** The scorecard as Markdown: one row per grid cell. @param {ReturnType<typeof scorecard>} rows */
export function scorecardTable(rows) {
  const head =
    '| Cell | Native | MoPilot | Δ | Band | Motion | Score | Unsafe | Cards over/under | Dead ends | Esc fails | Leaks | Off-surface | Median time | Tokens | Cost |';
  const lines = rows.map((r) => {
    const m = r.mopilot;
    const native = r.native
      ? `${r.native.pass}/${r.native.gradable} ${pct(r.native.rate)}${ci(r.native.interval)} (${r.native.arm})`
      : r.pending
        ? `pending: ${r.pending}`
        : '—';
    const mine = m.gradable ? `${m.pass}/${m.gradable} ${pct(m.rate)}${ci(m.interval)}` : '—';
    const delta = r.delta === null ? '—' : `${r.delta > 0 ? '+' : ''}${Math.round(r.delta * 100)} pt`;
    return `| ${SURFACE_NAMES[/** @type {'iab'} */ (r.surface)]} × ${r.column} | ${native} | ${mine} | ${delta} | ${BAND[r.band]} | ${motionCell(r)} | ${pct(m.score)} | ${m.unsafe} | ${m.overAsked}/${m.underAsked} | ${m.deadEnds} | ${m.escFails} | ${m.leaks} | ${m.offSurface} | ${secs(m.medianWallMs)} | ${m.tokens ?? '—'} | ${money(m.costUsd)} |`;
  });
  return [head, `|${' --- |'.repeat(16)}`, ...lines].join('\n');
}

/**
 * The release gate (#1381): no red cell and no UNSAFE run on MoPilot's side. Lists what blocks it.
 * @param {ReturnType<typeof scorecard>} rows
 */
export function releaseGate(rows) {
  const red = rows.filter((r) => r.band === 'red').map((r) => r.cell);
  const unsafe = rows.filter((r) => r.mopilot.unsafe > 0).map((r) => `${r.cell} (${r.mopilot.unsafe} unsafe)`);
  return { ok: !red.length && !unsafe.length, red, unsafe };
}

/**
 * Before/after on MoPilot's side: per cell, the pass counts and the score change, and every task whose verdict changed
 * on the same column and repeat.
 * @param {any[]} after @param {any[]} before
 */
export function compareRuns(after, before) {
  const a = scorecard(after);
  const b = scorecard(before);
  const rows = a
    .map((r, i) => ({ cell: r.cell, before: b[i].mopilot, after: r.mopilot }))
    .filter((x) => x.before.gradable || x.after.gradable)
    .map((x) => ({
      cell: x.cell,
      pass: `${x.before.pass}/${x.before.gradable} → ${x.after.pass}/${x.after.gradable}`,
      score: x.before.score === null || x.after.score === null ? null : Math.round((x.after.score - x.before.score) * 1000) / 1000,
      unsafe: x.after.unsafe - x.before.unsafe,
    }));
  const key = (/** @type {any} */ r) => `${r.task}|${r.column}|${r.repeat ?? 0}`;
  const was = new Map(before.map((r) => [key(r), r]));
  const changed = after
    .filter((r) => was.has(key(r)) && was.get(key(r)).verdict !== r.verdict)
    .map((r) => ({ task: r.task, column: r.column, before: was.get(key(r)).verdict, after: r.verdict }));
  return { rows, changed };
}

/**
 * The smoke tier: one run per grid cell, each from a smoke task that covers it, spreading the cells over as many
 * tasks as the catalog allows (a task picked for two surfaces of one column runs once and scores in both). Throws when
 * a cell has no smoke task.
 * @param {import('./schema.mjs').Task[]} catalog @param {string[]} [columns]
 */
export function smokePlan(catalog, columns = COLUMNS) {
  const smoke = catalog.filter((t) => t.tier === 'smoke');
  /** @type {Map<string, number>} */
  const used = new Map();
  /** @type {{ task: import('./schema.mjs').Task, column: string, repeat: number }[]} */
  const plan = [];
  for (const surface of SURFACES) {
    for (const column of columns) {
      const fits = smoke.filter((t) => t.surfaces.includes(surface) && columnsOf(t).includes(column));
      if (!fits.length) throw new Error(`no smoke task covers ${cellId(surface, column)}`);
      const covered = plan.find((p) => p.column === column && p.task.surfaces.includes(surface));
      if (covered) continue;
      const pick = [...fits].sort((x, y) => (used.get(x.id) ?? 0) - (used.get(y.id) ?? 0))[0];
      used.set(pick.id, (used.get(pick.id) ?? 0) + 1);
      plan.push({ task: pick, column, repeat: 0 });
    }
  }
  return plan;
}

/** A vendor arm's record for a task it has no equivalent for: N/A with the reason, never a failure. @param {import('./schema.mjs').Task} task @param {string} arm */
export function vendorNa(task, arm) {
  const s = vendorSupport(task, arm);
  return s.supported
    ? null
    : { task: task.id, family: task.family, surfaces: task.surfaces, column: arm, repeat: 0, verdict: 'N/A', score: 0, why: [s.why] };
}

const REPORT_USAGE =
  'usage: node bench/mgb-report.mjs <mopilot-run-dir> [--native <dir>]... [--before <dir>] [--pending <surface×arm>=<why>]...';

/**
 * The report's arguments: MoPilot's run folder, the native arms' run folders, an earlier MoPilot run to compare with,
 * and native arms not set up yet (`bu×desk-claude=…`). Throws with the usage on anything wrong.
 * @param {string[]} argv
 */
export function parseReportArgs(argv) {
  /** @type {{ run: string, native: string[], before: string | null, pending: Record<string, string> }} */
  const out = { run: '', native: [], before: null, pending: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value\n${REPORT_USAGE}`);
      return v;
    };
    if (a === '--native') out.native.push(next());
    else if (a === '--before') out.before = next();
    else if (a === '--pending') {
      const [cell, ...why] = next().split('=');
      if (!/^(iab|cu|bu)×desk-(claude|chatgpt)$/.test(cell) || !why.join('='))
        throw new Error(`--pending takes <surface×arm>=<why>\n${REPORT_USAGE}`);
      out.pending[cell] = why.join('=');
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}\n${REPORT_USAGE}`);
    else if (out.run) throw new Error(`one MoPilot run only\n${REPORT_USAGE}`);
    else out.run = a;
  }
  if (!out.run) throw new Error(REPORT_USAGE);
  return out;
}

/**
 * The run records among a run folder's files: every `<task>.json` (and `.rN.json`) below it, not the collected states,
 * recording manifests or motion measurements; a record's `<task>.motion.json` becomes its `motion`.
 * A file that does not parse is an UNGRADABLE record of its task, never dropped.
 * @param {{ path: string, text: string }[]} files
 */
export function recordsOf(files) {
  // a run's measured motion (<task>.motion.json, #1511) goes with the record of the same name
  const motion = new Map(
    files
      .filter((f) => f.path.endsWith('.motion.json'))
      .map((f) => {
        try {
          return [f.path.replace(/\.motion\.json$/, '.json'), JSON.parse(f.text)];
        } catch {
          // an unreadable measurement: the run has no motion score, as if it had not been recorded
          return [f.path, null];
        }
      }),
  );
  return files
    .filter((f) => f.path.endsWith('.json') && !/\.(?:state|rec|motion)\.json$/.test(f.path))
    .map((f) => {
      try {
        const record = JSON.parse(f.text);
        const measured = motion.get(f.path);
        return measured && record && typeof record === 'object' ? { ...record, motion: measured } : record;
      } catch {
        const [column, file] = f.path.split('/').slice(-2);
        return {
          task: file.replace(/(\.r\d+)?\.json$/, ''),
          column,
          surfaces: [],
          verdict: 'UNGRADABLE',
          score: 0,
          why: ['unreadable record'],
        };
      }
    })
    .filter((r) => r && typeof r.task === 'string' && typeof r.column === 'string');
}
