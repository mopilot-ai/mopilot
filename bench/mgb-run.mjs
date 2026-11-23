// Runs the MoPilot 12-Grid Bench (#1381) inside the benchmark VM: each task on each harness column, graded from the
// fixture apps' and the Mac's state, written to bench/results/<run>/<column>/<task>.json plus summary.md. Refuses to
// start anywhere but a VM. Usage: docs/control-plane/benchmark.md.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { requireVm } from './lib/guard.mjs';
import { gradeTask } from './lib/mgb/grade.mjs';
import {
  ledgerUsage,
  mgbRecord,
  mgbTable,
  armPrompts,
  chromeMarkError,
  chromeMarkUrl,
  errorText,
  parseMgbArgs,
  peerCell,
  prepareRun,
  resultName,
  runPlan,
  runEnv,
  runTag,
  todayFor,
  usageCost,
  vendorSetupError,
} from './lib/mgb/run.mjs';
import { offSurface } from './lib/mgb/tasks/common.mjs';
import { CATALOG } from './lib/mgb/tasks/index.mjs';
import { ARMS } from './lib/config.mjs';
import { vendorNa } from './lib/mgb/scorecard.mjs';
import { APPS } from './lib/mgb/apps/index.mjs';
import { chromeMark } from './lib/mgb/apps/server.mjs';
import {
  CHROME_PROFILE,
  collectSources,
  expand,
  fixtureServer,
  limitProxy,
  markChrome,
  mgbTurn,
  readLedger,
  setupSources,
  startBenchChrome,
} from './drivers/mgb.mjs';
import { archiveChat, vendorTurn } from './drivers/mgbDesktop.mjs';
import { assertBenchChrome, tidyDesktop } from './drivers/gui.mjs';
import { startRecording } from './drivers/record.mjs';
import { clearInstanceRoutines, routinePassB } from './drivers/mgbRerun.mjs';
import { routineName, savePrompt, rerunSummary, rerunTable } from './lib/mgb/routineRerun.mjs';

requireVm('bench/mgb-run.mjs');
const cfg = parseMgbArgs(process.argv.slice(2), CATALOG);
const token = process.env.MGB_TOKEN ?? '';
if (token.length < 16) throw new Error('set MGB_TOKEN (16+ characters), the same one bench/mgb-serve.mjs was started with');
const server = fixtureServer(cfg.port, token);
await server.state().catch(() => {
  throw new Error(`the fixtures are not served on port ${cfg.port}: start MGB_TOKEN=… node bench/mgb-serve.mjs ${cfg.port}`);
});
const prices = cfg.prices ? JSON.parse(readFileSync(cfg.prices, 'utf8')) : {};
// the provider proxy the bench's Claude instance talks through (bench/mgb-limit-proxy.mjs), for usage-limit tasks
const limiter = limitProxy(Number(process.env.MGB_PROXY_PORT ?? 8830), token);

// the user's Chrome carries the bench mark on every app host before any task runs: without it, a browser-use task could
// not tell that Chrome from a built-in browser (ChatGPT's sends Chrome's exact user agent)
const plan = runPlan(cfg, CATALOG);
// Only successful marking is cached; a failed pre-launch is retried by the next task.
let chromeMarked = cfg.skipChrome;

/** @type {any[]} */
const records = [];
/** @type {any[]} the routine-rerun mode's pairs (G4) */
const pairs = [];
const vendor = cfg.arm !== 'mopilot';
for (const { task, column, repeat } of plan) {
  const name = resultName(task.id, repeat);
  const na = vendor ? vendorNa(task, cfg.arm) : null;
  if (na) {
    // the vendor has no equivalent: recorded as N/A with the reason, never scored as a failure
    mkdirSync(path.join(cfg.resultsDir, column), { recursive: true });
    writeFileSync(path.join(cfg.resultsDir, column, `${name}.json`), JSON.stringify({ ...na, repeat }, null, 2));
    records.push({ ...na, repeat });
    continue;
  }
  const cell = vendor ? { harness: /** @type {any} */ (ARMS)[cfg.arm].app, userData: '' } : cfg.cells[column];
  const dir = path.join(cfg.resultsDir, column);
  mkdirSync(dir, { recursive: true });
  const tag = runTag(task.id, column);
  // the fixtures' "today" is the date this column's model reads
  const runCfg = { ...cfg, today: todayFor(cfg, column) };
  const env = runEnv(runCfg, task, tag, expand('~/mgb-files'));
  const { data, fixtures, prompts } = prepareRun(task, env);
  const shot = path.join(dir, `${name}.png`);
  /** @type {any} */
  let out;
  /** @type {ReturnType<typeof startRecording> | null} */
  let recorder = null;
  try {
    if (!cfg.skipChrome) assertBenchChrome(expand(CHROME_PROFILE));
    if (!chromeMarked) {
      const apps = APPS.map((a) => a.name);
      const marked = await markChrome(server, chromeMarkUrl(cfg.port, chromeMark(token), apps), apps.length);
      const markError = chromeMarkError(plan, apps, marked);
      if (markError) throw new Error(markError);
      chromeMarked = true;
    }
    // Close the owned mark/task windows before recording; skip-Chrome never inspects or mutates Chrome.
    const left = tidyDesktop(cfg.skipChrome ? '' : expand(CHROME_PROFILE));
    // a clean desktop is a precondition, not a note: a task that would start beside another task's leftovers is not
    // run (no tokens spent) and is UNGRADABLE (environment), to be run again once the tidy works
    if (left.length) throw new Error(`environment: ${left.join(', ')} still running after the tidy, so the task did not run`);
    // Chrome setup is part of this task's failure boundary, before recording or spending any model tokens.
    if (!cfg.skipChrome) startBenchChrome();
    recorder = startRecording(path.join(dir, name));
    if (vendor) {
      await setupSources({ task, fixtures, env, server });
      // the native arm runs the model of its column (Claude Desktop keeps the choice per session, so it is picked each time)
      const model = cfg.arm === 'desk-claude' ? cfg.cells.claude.model : cfg.cells.codex.model;
      const turn = vendorTurn({
        arm: /** @type {any} */ (ARMS)[cfg.arm],
        prompts: armPrompts(prompts, tag),
        tag,
        timeoutS: cfg.timeoutS,
        model,
      });
      const state = await collectSources({ fixtures, env, server, window: { from: turn.startedAt, to: turn.endedAt } });
      // a run in another permission mode than the arm's is a setup error (UNGRADABLE), never the model's fail
      // (a run that already failed keeps its own error: no transcript means no recorded mode either)
      const setupError = turn.driverError ? null : vendorSetupError(/** @type {any} */ (ARMS)[cfg.arm], turn.setup);
      // the chat leaves the user's sidebar once its state is read (the vendor apps run on the user's own account)
      const archived = archiveChat(/** @type {any} */ (ARMS)[cfg.arm], turn);
      out = { state, turn: { ...turn, archived, ...(setupError ? { driverError: true, error: setupError } : {}) } };
    } else {
      // routine-rerun (G4): no routine of an earlier pair is listed, and pass A ends by saving its steps
      if (cfg.routineRerun) await clearInstanceRoutines(cell.port);
      out = await mgbTurn({
        task,
        cell,
        port: cell.port,
        fixtures,
        prompts: cfg.routineRerun ? [...prompts, savePrompt(routineName(task.id, column, repeat))] : prompts,
        env,
        server,
        timeoutS: cfg.timeoutS,
        shot,
        skipChrome: cfg.skipChrome,
        peer: peerCell(column, cfg.cells),
        data,
        limiter,
        tag,
        userData: cell.userData,
      });
    }
  } catch (e) {
    out = { state: {}, turn: { driverError: true, error: errorText(e).slice(0, 500) } };
  }
  // with the turn's own times beside the parts' (the first prompt sent, the turn's end), for aligning them
  if (recorder) {
    const rec = { ...(await recorder.stop()), turnStartedAt: out.turn.startedAt ?? null, turnEndedAt: out.turn.endedAt ?? null };
    writeFileSync(path.join(dir, `${name}.rec.json`), JSON.stringify(rec, null, 1));
  }
  const graded = gradeTask({ task, data, state: out.state, env, turn: out.turn });
  // MoPilot's control-plane metrics (cards, dead ends, leaks) mean nothing in a vendor app's run
  const grade = vendor ? { ...graded, control: null } : graded;
  // MoPilot's request ledger, or the vendor app's own transcript (same shape)
  const usage = vendor
    ? (out.turn.usage ?? null)
    : out.turn.startedAt
      ? ledgerUsage(readLedger(cell.userData), { from: out.turn.startedAt, to: out.turn.endedAt })
      : null;
  const record = mgbRecord({
    task,
    column,
    cell,
    cfg: runCfg,
    tag,
    grade,
    turn: out.turn,
    offSurface: offSurface(out.state),
    usage,
    costUsd: usageCost(usage, prices),
    repeat,
  });
  if (grade.verdict === 'PASS') rmSync(shot, { force: true });
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(record, null, 2));
  // the collected state, for reading a failure; it holds only fixture data
  writeFileSync(path.join(dir, `${name}.state.json`), JSON.stringify(out.state, null, 1));
  records.push(record);
  console.log(JSON.stringify({ task: task.id, column, repeat, verdict: grade.verdict, score: grade.score, why: grade.why.slice(0, 5) }));
  if (cfg.routineRerun && !out.turn.driverError) {
    const a = { turn: out.turn, verdict: grade.verdict, prompts: prompts.length };
    try {
      const pair = await routinePassB({
        cfg,
        task,
        column,
        repeat,
        cell,
        tag,
        dir,
        name,
        a,
        server,
        limiter,
        peer: peerCell(column, cfg.cells),
      });
      pairs.push(pair);
      console.log(JSON.stringify({ routine: pair.task, column, repeat, a: pair.a, b: pair.b, ratio: pair.ratio }));
    } catch (e) {
      console.log(JSON.stringify({ routine: task.id, column, repeat, error: errorText(e).slice(0, 300) }));
    }
  }
}
if (cfg.routineRerun) writeFileSync(path.join(cfg.resultsDir, 'routine-summary.md'), `${rerunTable(rerunSummary(pairs))}\n`);
writeFileSync(path.join(cfg.resultsDir, 'summary.md'), `${mgbTable(records, vendor ? [cfg.arm] : cfg.columns)}\n`);
