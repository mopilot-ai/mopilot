// MoPilot 12-Grid Bench (#1381) run planning: arguments, the harness columns and their MoPilot instances, the task ×
// column runs of a tier, each run's environment and tag, the ledger's tokens for a turn, and the per-run record.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BENCH_DIR } from '../config.mjs';
import { columnsOf, COLUMNS, TIERS, VENDOR_SURFACES } from './schema.mjs';
import { smokePlan } from './scorecard.mjs';
import { taskRng } from './seed.mjs';
import { modelOfLine } from '../../../shared/costSummary.mjs';

/**
 * The MoPilot instance and harness of each column. Claude cells run Sonnet 5.5, Codex cells Codex's cheaper model,
 * the ACP column opencode on a free Zen model; the switch column starts on Claude Code and moves to Codex. Ports
 * stay clear of the edge suite (9371-9373) and the version contract (9401+). Models are picker labels, overridable
 * per run and recorded with the results.
 */
export const MGB_COLUMNS = {
  claude: { harness: 'Claude Code', model: 'Sonnet 5.5', port: '9381', userData: '~/bench-data/mgb-claude' },
  codex: { harness: 'Codex', model: 'GPT-6 Luna', port: '9382', userData: '~/bench-data/mgb-codex' },
  switch: {
    harness: 'Claude Code',
    model: 'Sonnet 5.5',
    port: '9381',
    userData: '~/bench-data/mgb-claude',
    switchTo: 'Codex',
    switchModel: 'GPT-6 Luna',
  },
  acp: { harness: 'opencode', model: 'Big Pickle', port: '9383', userData: '~/bench-data/mgb-acp' },
};

const USAGE =
  'usage: node bench/mgb-run.mjs [--tier smoke|full] [--tasks a,b] [--columns claude,codex,switch,acp] [--run <name>] ' +
  '[--arm mopilot|desk-claude|desk-chatgpt] [--seed <s>] [--today YYYY-MM-DD] [--port <fixtures>] [--timeout <s>] [--repeats <n>] [--model-<column> <label>] [--skip-chrome] [--prices <json>] [--results <dir>] [--routine-rerun [--rerun-seed <s>]]';

/** A comma list, trimmed, without empties. @param {string} s */
const list = (s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Parses and checks a run's arguments against the task catalog; throws with the usage on anything wrong.
 * @param {string[]} argv @param {import('./schema.mjs').Task[]} catalog @param {() => Date} [clock]
 */
export function parseMgbArgs(argv, catalog, clock = () => new Date()) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        tier: { type: 'string', default: 'smoke' },
        tasks: { type: 'string', default: '' },
        columns: { type: 'string', default: COLUMNS.join(',') },
        run: { type: 'string', default: 'mgb' },
        seed: { type: 'string', default: '' },
        today: { type: 'string', default: '' },
        port: { type: 'string', default: '8820' },
        timeout: { type: 'string', default: '900' },
        repeats: { type: 'string', default: '1' },
        arm: { type: 'string', default: 'mopilot' },
        ports: { type: 'string', default: '' },
        'model-claude': { type: 'string' },
        'model-codex': { type: 'string' },
        'model-acp': { type: 'string' },
        'skip-chrome': { type: 'boolean', default: false },
        prices: { type: 'string', default: '' },
        results: { type: 'string', default: path.join(BENCH_DIR, 'results') },
        'routine-rerun': { type: 'boolean', default: false },
        'rerun-seed': { type: 'string', default: '' },
      },
    }));
  } catch (e) {
    throw new Error(`${/** @type {Error} */ (e).message}\n${USAGE}`);
  }
  const fail = (/** @type {string} */ why) => {
    throw new Error(`${why}\n${USAGE}`);
  };
  if (!TIERS.includes(values.tier)) fail('--tier must be smoke or full');
  const columns = list(values.columns);
  if (!columns.length) fail('--columns names no column');
  for (const c of columns) if (!COLUMNS.includes(c)) fail(`unknown column ${c}`);
  const wanted = list(values.tasks);
  for (const id of wanted) if (!catalog.some((t) => t.id === id)) fail(`unknown task ${id}`);
  if (!/^(?!\.+$)[\w.-]+$/.test(values.run)) fail('--run must be a plain name (letters, digits, . _ -), not . or ..');
  // the date the model reads: Claude Code's prompt carries the machine's own date, Codex's environment context the GMT one
  // (see todayFor). They differ for hours each evening in the Americas, and a run then graded "this week" against another
  // week (the G4 pair on #4268: week 45 in the fixture, week 46 to the model)
  const now = clock();
  const today =
    values.today || [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const todayUtc = values.today || now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) fail('--today must be YYYY-MM-DD');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65534) fail('--port must be a port from 1024 to 65534');
  const timeoutS = Number(values.timeout);
  if (!Number.isInteger(timeoutS) || timeoutS <= 0) fail('--timeout must be a positive number of seconds');
  const arm = values.arm;
  if (arm !== 'mopilot' && !Object.hasOwn(VENDOR_SURFACES, arm))
    fail(`--arm must be mopilot or ${Object.keys(VENDOR_SURFACES).join(', ')}`);
  if (values['routine-rerun'] && arm !== 'mopilot') fail("--routine-rerun runs MoPilot columns only (routines are MoPilot's)");
  if (values['rerun-seed'] && !values['routine-rerun']) fail('--rerun-seed needs --routine-rerun');
  const repeats = Number(values.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) fail('--repeats must be a whole number from 1 to 10');
  const tasks = wanted.length
    ? catalog.filter((t) => wanted.includes(t.id))
    : catalog.filter((t) => values.tier === 'full' || t.tier === 'smoke');
  /** @type {Record<string, any>} */
  const cells = structuredClone(MGB_COLUMNS);
  if (values['model-claude']) cells.claude.model = cells.switch.model = values['model-claude'];
  if (values['model-codex']) cells.codex.model = cells.switch.switchModel = values['model-codex'];
  if (values['model-acp']) cells.acp.model = values['model-acp'];
  // other instances' CDP ports (the version contract's scratch instances): the switch cell shares Claude Code's
  for (const pair of list(values.ports)) {
    const [col, port] = pair.split('=');
    if (!Object.hasOwn(cells, col) || !/^\d{4,5}$/.test(port ?? '')) fail('--ports takes column=port pairs, e.g. claude=9401,codex=9402');
    cells[col].port = port;
    if (col === 'claude' && !values.ports.includes('switch=')) cells.switch.port = port;
  }
  return {
    tier: values.tier,
    tasks,
    // --tasks names the tasks; otherwise the tier picks them (smoke: one run per grid cell)
    explicitTasks: wanted.length > 0,
    columns,
    cells,
    run: values.run,
    // one seed per run: every column of a task sees the same data, so the columns compare
    seed: values.seed || values.run,
    today,
    todayUtc,
    port,
    timeoutS,
    // each task runs this many times per column on the same seed, so a cell's success rate has an error bar
    repeats,
    // mopilot runs the harness columns; a vendor arm runs the same tasks and seeds in the vendor's own app
    arm,
    skipChrome: values['skip-chrome'],
    // a JSON price table for usageCost (dollars per million tokens per served model); none: costs stay unknown
    prices: values.prices,
    resultsDir: path.join(values.results, values.run),
    // G4 (#3571): pass A saves its steps as a routine, pass B runs the task again in a new chat (on rerunSeed's data when set)
    routineRerun: values['routine-rerun'],
    rerunSeed: values['rerun-seed'] || null,
  };
}

/**
 * The runs of a plan: each task on each of its columns that the run asked for, `repeats` times, task by task.
 * @param {import('./schema.mjs').Task[]} tasks @param {string[]} columns
 */
export const planRuns = (tasks, columns, repeats = 1) =>
  tasks.flatMap((task) =>
    columnsOf(task)
      .filter((c) => columns.includes(c))
      .flatMap((column) => Array.from({ length: repeats }, (_, repeat) => ({ task, column, repeat }))),
  );

/** A run's result file name: the task, and its repeat after the first. @param {string} taskId @param {number} repeat */
export const resultName = (taskId, repeat) => `${taskId}${repeat ? `.r${repeat + 1}` : ''}`;

/** A run's tag: task, column and a time stamp, so reruns never share state or files. */
export const runTag = (/** @type {string} */ taskId, /** @type {string} */ column, now = Date.now()) =>
  `${taskId}.${column}.${now.toString(36)}`;

/** Columns whose model is told the GMT date (Codex's `<environment_context>` has `current_date` with `timezone: GMT`). */
const GMT_DATE_COLUMNS = new Set(['codex']);

/**
 * The run's "today" for a column: an explicit --today as given, else the date that column's model reads (the GMT date
 * for Codex, the machine's own for the others), so the fixtures and the model agree on what day it is.
 * @param {{ today: string, todayUtc: string }} cfg @param {string} column
 */
export const todayFor = (cfg, column) => (GMT_DATE_COLUMNS.has(column) ? cfg.todayUtc : cfg.today);

/**
 * The environment a task sees in one run: the run seed, the run's "today", each app's URL and a scratch folder for
 * the task's files (inside the VM user's home, never a real user's).
 * @param {{ seed: string, today: string, port: number }} cfg @param {import('./schema.mjs').Task} task @param {string} tag
 * @param {string} filesRoot @returns {import('./schema.mjs').Env}
 */
export const runEnv = (cfg, task, tag, filesRoot, tz = -new Date().getTimezoneOffset()) => ({
  runSeed: cfg.seed,
  today: cfg.today,
  urls: Object.fromEntries(task.apps.map((a) => [a, `http://${a}.localhost:${cfg.port}/`])),
  files: path.join(filesRoot, tag),
  // the runner runs on the Mac it grades, so its clock's offset is the one Calendar shows
  tz,
});

/**
 * Everything one run needs before the turn: the seeded data, the fixtures to load and the messages to send.
 * @param {import('./schema.mjs').Task} task @param {import('./schema.mjs').Env} env
 */
export function prepareRun(task, env) {
  const data = task.data(taskRng(env.runSeed, task.id), env);
  return { data, fixtures: task.fixtures(data, env), prompts: task.prompt(data, env) };
}

/** @typedef {{ in: number, out: number, cacheRead: number, cacheWrite: number, reasoning: number }} Counts */

/**
 * The tokens a turn used, from the request ledger's lines (#1316): requests between `from` and `to`, for `chat` when
 * the line names one, summed per model that answered, else the one asked for (a switch run uses two). Unknown counts stay out of the sums; no line at
 * all is null, never zero.
 * @param {any[]} lines @param {{ from: number, to: number, chat?: string }} o
 */
export function ledgerUsage(lines, { from, to, chat }) {
  const mine = lines.filter((l) => {
    const t = Date.parse(l?.t);
    return Number.isFinite(t) && t >= from && t <= to && (!chat || !l.chat || l.chat === chat);
  });
  if (!mine.length) return null;
  /** @type {Record<string, Counts>} */
  const byModel = {};
  for (const l of mine) {
    // the model that answered, else the one asked for: Codex names the one that answered only when it reroutes
    const m = (byModel[modelOfLine(l) ?? '?'] ??= {
      in: 0,
      out: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    for (const k of /** @type {(keyof Counts)[]} */ (['in', 'out', 'cacheRead', 'cacheWrite', 'reasoning']))
      if (Number.isFinite(l[k])) m[k] += l[k];
  }
  const all = Object.values(byModel);
  const tokens = all.reduce((s, c) => s + c.in + c.out + c.cacheRead + c.cacheWrite, 0);
  return { requests: mine.length, tokens, byModel };
}

/**
 * The cost of a turn in US dollars from a price table in dollars per million tokens ({ in, out, cacheRead?,
 * cacheWrite? } per served model; cache prices default to the input price). Null when any request's model has no
 * price: an unknown price is never counted as free.
 * @param {ReturnType<typeof ledgerUsage>} usage @param {Record<string, { in: number, out: number, cacheRead?: number, cacheWrite?: number }>} prices
 */
export function usageCost(usage, prices) {
  if (!usage) return null;
  let cost = 0;
  for (const [model, c] of Object.entries(usage.byModel)) {
    const p = prices[model];
    if (!p) return null;
    cost += (c.in * p.in + c.out * p.out + c.cacheRead * (p.cacheRead ?? p.in) + c.cacheWrite * (p.cacheWrite ?? p.in)) / 1e6;
  }
  return Math.round(cost * 10000) / 10000;
}

/** How long into the last message the driver presses Esc when a task names no event to wait for. */
export const ESC_FALLBACK_MS = 20_000;

/**
 * Whether the driver should press Esc now: once, after the app event the task names first appears, or, with none
 * named, 20 s into the last message.
 * @param {import('./schema.mjs').Task} task @param {{ escAt?: number, state: Record<string, any>, message: number,
 *   messages: number, messageStartedAt: number, now: number }} o
 */
export function escDue(task, { escAt, state, message, messages, messageStartedAt, now }) {
  if (!task.escape || escAt) return false;
  const after = task.escape.after;
  if (after) return (state[after.app]?.events ?? []).some((/** @type {any} */ e) => e.type === after.event);
  return message === messages - 1 && now - messageStartedAt >= ESC_FALLBACK_MS;
}

/**
 * The URL that marks the user's Chrome for every app (bench/lib/mgb/apps/server.mjs `/__mgb/mark`): opened once in the
 * bench Chrome profile, it hops from host to host setting the mark cookie.
 * @param {number} port the fixture server's port @param {string} mark @param {string[]} apps the app names
 */
export function chromeMarkUrl(port, mark, apps) {
  const [first, ...rest] = apps;
  return `http://${first}.localhost:${port}/__mgb/mark?k=${mark}${rest.length ? `&next=${rest.join(',')}` : ''}`;
}

/**
 * Why a run cannot start without the user's Chrome marked: a plan with browser-use tasks needs every app host to carry
 * the mark, or the user's Chrome would grade as the in-app browser. Null when the run can start.
 * @param {{ task: { id: string, surfaces: string[] } }[]} plan @param {string[]} apps @param {string[]} marked
 */
export function chromeMarkError(plan, apps, marked) {
  const missing = apps.filter((a) => !marked.includes(a));
  if (!missing.length) return null;
  const bu = [...new Set(plan.filter((r) => r.task.surfaces.includes('bu')).map((r) => r.task.id))];
  if (!bu.length) return null;
  return `the user's Chrome carries no bench mark on ${missing.join(', ')}, so ${bu.join(', ')} cannot tell it from the in-app browser: check the Chrome profile, or run with --skip-chrome`;
}

/**
 * A driver failure as text, with the chain of causes: Node's fetch says only "fetch failed" and keeps the reason
 * (refused, reset, bad header) in `cause`.
 * @param {unknown} e
 * @returns {string}
 */
export function errorText(e) {
  const parts = [];
  for (let c = /** @type {any} */ (e), n = 0; c != null && n < 4; c = c.cause, n++)
    parts.push(c instanceof Error ? [/** @type {any} */ (c).code, c.message].filter(Boolean).join(' ') : String(c));
  return parts.join(' <- ');
}

/**
 * Why a native arm's run does not count, from how the app actually ran it (bench/lib/transcript.mjs transcriptSetup):
 * a permission mode other than the arm's, or none recorded. Such a run is a setup error, never the model's fail: in
 * Manual mode Claude Desktop waits on approval cards no driver answers. Null when the run counts.
 * @param {{ app: string, permission?: string }} arm @param {{ permission: string | null } | null | undefined} setup
 */
export function vendorSetupError(arm, setup) {
  if (!arm.permission) return null;
  if (setup?.permission === arm.permission) return null;
  return `${arm.app} ran in permission mode ${setup?.permission ?? '(unknown)'}, not ${arm.permission}: set it in the app and rerun`;
}

/**
 * One run's record: the task and cell, the seed and tag, the grade, what the driver saw, the changes made around the
 * browser, and the tokens and cost. The agent's answer is kept for reading, never for grading.
 * @param {{ task: import('./schema.mjs').Task, column: string, cell: any, cfg: { run: string, seed: string, today: string },
 *   tag: string, grade: any, turn: any, offSurface: any[], usage: ReturnType<typeof ledgerUsage>, costUsd: number | null,
 *   repeat?: number }} o
 */
export function mgbRecord({ task, column, cell, cfg, tag, grade, turn, offSurface, usage, costUsd, repeat = 0 }) {
  return {
    task: task.id,
    repeat,
    family: task.family,
    surfaces: task.surfaces,
    column,
    harness: cell.switchTo ? `${cell.harness} → ${cell.switchTo}` : cell.harness,
    // a native arm's model is what its transcript says the app served
    model: turn.model ?? turn.setup?.model ?? null,
    run: cfg.run,
    seed: cfg.seed,
    today: cfg.today,
    tag,
    verdict: grade.verdict,
    success: grade.success,
    score: grade.score,
    why: grade.why,
    checkpoints: grade.checkpoints,
    violations: grade.violations,
    control: grade.control,
    efficiency: { ...grade.efficiency, tokens: usage?.tokens ?? null, costUsd },
    usage,
    offSurface,
    answer: String(turn.answer ?? '').slice(-4000),
    turn: {
      approvals: turn.approvals ?? 0,
      approvalLog: turn.approvalLog ?? [],
      askLog: turn.askLog ?? [],
      answers: turn.answers ?? [],
      strips: turn.strips ?? [],
      switch: turn.switch ?? null,
      offered: turn.offered ?? [],
      error: turn.error ?? null,
      timedOut: !!turn.timedOut,
      // a native arm's permission mode, model and effort as the app ran them
      setup: turn.setup ?? null,
      // whether a native arm's chat was archived from the user's sidebar afterwards (null for MoPilot runs)
      archived: turn.archived ?? null,
    },
  };
}

/**
 * The run's summary: one row per task, one column per harness column, each "VERDICT score" for a single run, or
 * "passes/runs, mean score" over repeats.
 * @param {{ task: string, column: string, verdict: string, score: number, offSurface?: any[] }[]} records @param {string[]} columns
 */
export function mgbTable(records, columns) {
  const tasks = [...new Set(records.map((r) => r.task))];
  const cell = (/** @type {any[]} */ rs) => {
    if (!rs.length) return '—';
    const warn = rs.some((r) => r.offSurface?.length) ? ' ⚠' : '';
    if (rs.length === 1) return `${rs[0].verdict} ${Math.round(rs[0].score * 100)}%${warn}`;
    const mean = rs.reduce((s, r) => s + r.score, 0) / rs.length;
    return `${rs.filter((r) => r.verdict === 'PASS').length}/${rs.length} PASS ${Math.round(mean * 100)}%${rs.some((r) => r.verdict === 'UNSAFE') ? ' UNSAFE' : ''}${warn}`;
  };
  const rows = tasks.map(
    (t) => `| ${t} | ${columns.map((c) => cell(records.filter((r) => r.task === t && r.column === c))).join(' | ')} |`,
  );
  const total = columns.map((c) => {
    const of = records.filter((r) => r.column === c);
    return `${of.filter((r) => r.verdict === 'PASS').length}/${of.length} pass`;
  });
  return [
    `| Task | ${columns.join(' | ')} |`,
    `| --- | ${columns.map(() => '---').join(' | ')} |`,
    ...rows,
    `| **Total** | ${total.join(' | ')} |`,
    '',
    '⚠: changes made around the browser (see offSurface).',
  ].join('\n');
}

/**
 * The harness a task's peer chats run on (F8): the other one from the cell's, so a hand-off always crosses harnesses.
 * A switch chat ends on Codex, so its peer is Claude Code; an ACP chat's peer is Claude Code.
 * @param {string} column @param {Record<string, any>} cells
 */
export const peerCell = (column, cells) => (column === 'claude' ? cells.codex : cells.claude);

/**
 * A task's messages for a native arm: the same words, with MoPilot's in-app browser named as the app's own built-in
 * browser, and the run tag on the first message (how the driver finds the app's transcript).
 * @param {string[]} prompts @param {string} tag
 */
export function armPrompts(prompts, tag) {
  const out = prompts.map((p) =>
    p.replace(/\bthe in-app browser\b/gi, 'your built-in browser').replace(/\bin-app browser\b/gi, 'built-in browser'),
  );
  out[0] = `${out[0]}\n\n(Run ${tag}.)`;
  return out;
}

/**
 * What a run runs, in order. A native arm runs every chosen task once per repeat (its own app is its one column). The
 * MoPilot smoke tier is one run per grid cell (`smokePlan`), and anything else is each task on each of its columns.
 * @param {ReturnType<typeof parseMgbArgs>} cfg @param {import('./schema.mjs').Task[]} catalog
 */
export function runPlan(cfg, catalog) {
  // a VM whose Chrome another run uses cannot run browser-use tasks: they are left out, not failed
  /** @template {{ task: any }} R @param {R[]} runs @returns {R[]} */
  const fair = (runs) => (cfg.skipChrome ? runs.filter((r) => !r.task.surfaces.includes('bu')) : runs);
  const times = (/** @type {{ task: any, column: string }[]} */ runs) =>
    runs.flatMap((r) => Array.from({ length: cfg.repeats }, (_, repeat) => ({ task: r.task, column: r.column, repeat })));
  if (cfg.arm !== 'mopilot') return fair(times(cfg.tasks.map((task) => ({ task, column: cfg.arm }))));
  if (cfg.tier === 'smoke' && !cfg.explicitTasks) return fair(times(smokePlan(catalog, cfg.columns)));
  return fair(planRuns(cfg.tasks, cfg.columns, cfg.repeats));
}
