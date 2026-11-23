// Runs one arm on one benchmark tier inside the benchmark VM and writes a result per task to
// bench/results/<run>/<arm>/<task>.json. Refuses to start anywhere but a VM. Usage: bench/README.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRunArgs } from './lib/config.mjs';
import { externalPaths } from './lib/external.mjs';
import { gradeWebGames, parseJsonl, pickSiteTarget, realVerdict, resultRecord, timedOut } from './lib/grading.mjs';
import { requireVm } from './lib/guard.mjs';
import { finalPrompt, macPrompt, realConfigUrl, realPrompt, runTag, webGamesPrompt } from './lib/prompts.mjs';
import { loadCatalog, selectTasks } from './lib/tasks.mjs';
import { ensureTab, navigate, readFinish, siteTargets, targets } from './drivers/cdp.mjs';
import { desktopTurn } from './drivers/desktop.mjs';
import { screenshot } from './drivers/gui.mjs';
import { grade as macGrade, reset as macReset } from './drivers/macarena.mjs';
import { mopilotTurn } from './drivers/mopilot.mjs';

requireVm('bench/run.mjs');
const cfg = parseRunArgs(process.argv.slice(2));
const { arm, bench } = cfg;
const paths = externalPaths(cfg.external);
const tasks = /** @type {any[]} */ (selectTasks(cfg, loadCatalog(bench, cfg.external)));
mkdirSync(cfg.resultsDir, { recursive: true });
if (bench === 'wg') {
  await fetch(cfg.base).catch(() => {
    throw new Error(`WebGames is not served at ${cfg.base}: start node bench/webgames-serve.mjs (bench/README.md)`);
  });
}

/**
 * One agent turn on this arm; answer is the agent's final text. `driverError` marks a failure before the prompt
 * reached the agent (no app window, harness or model missing, the turn never started): the task is then ungradable,
 * not the agent's fail.
 * @param {string} prompt @param {string} tag @returns {Promise<Record<string, any>>}
 */
async function turn(prompt, tag) {
  const full = finalPrompt(prompt, cfg.extra, tag);
  try {
    if (arm.kind === 'mopilot') {
      return await mopilotTurn({ port: arm.port, harness: arm.harness, model: arm.model, timeoutS: cfg.timeoutS, prompt: full });
    }
    const r = desktopTurn({ arm, prompt: full, tag, timeoutS: cfg.timeoutS });
    // another app was in front (gui.mjs toFront): the prompt never reached the agent
    if ('notSent' in r && r.notSent)
      return { ...r, model: arm.app, driverError: true, error: `${r.front} was in front, so the prompt was not sent` };
    const notes = `${r.outsideBrowser ? 'STOPPED: reached for Claude in Chrome; ' : ''}tools ${JSON.stringify(r.tools)}${r.file ? '' : '; no transcript found'}`;
    return { ...r, model: arm.app, notes };
  } catch (e) {
    return { ok: false, wallMs: null, answer: '', error: String(e.message).slice(0, 500), driverError: e.beforeSend !== false };
  }
}

/** Grades a REAL task's /finish state with the upstream grader (python3 -I, outside the checkout). */
function gradeReal(/** @type {any} */ t, /** @type {string} */ finish) {
  const file = path.join(cfg.resultsDir, `${t.id}.finish.json`);
  writeFileSync(file, finish);
  let out = '';
  try {
    out = execFileSync('python3', ['-I', path.join(paths.realGraders, t.grader), file], {
      cwd: mkdtempSync(path.join(tmpdir(), 'real-grade-')),
      encoding: 'utf8',
    });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  return { ...realVerdict(finish, out), graderOut: out.trim().split('\n').slice(-3).join(' | ') };
}

/** Every target id on an app's CDP port, or none when it cannot be listed. @param {string} port */
const targetIds = async (port) => new Set((await targets(port).catch(() => [])).map((x) => String(x.id)));

/**
 * One REAL task: setup (MoPilot only), the turn, then /finish from the agent's tab and the grader.
 * @param {any} t @param {string} tag
 */
async function realTask(t, tag) {
  /** @type {string | null} */
  let setupId = null;
  if (arm.kind === 'mopilot') {
    // set the task up in the pane's shared profile: config, finish, then the site
    const setup = await ensureTab(arm.port, realConfigUrl(t));
    for (const url of [realConfigUrl(t), `${t.url}/finish`, `${t.url}/`]) await navigate(setup, url);
    setupId = setup.id;
  }
  // the app's targets before the turn: one on the site afterwards that is not among them is the agent's
  // (ChatGPT exposes its agent tabs over its CDP port while one stays open)
  const port = arm.kind === 'mopilot' ? arm.port : arm.cdp;
  const before = port ? await targetIds(port) : new Set();
  const r = await turn(realPrompt(t, arm.browser, arm.kind === 'mopilot'), tag);
  const onSite = port ? await siteTargets(port, t.url).catch(() => []) : [];
  const { target, note } = pickSiteTarget(onSite, before, setupId);
  const finish = target ? await readFinish(target, t.url) : '';
  const g = gradeReal(t, finish);
  return { ...r, ...g, notes: [note, `approvals ${r.approvals ?? 0}`, `grader: ${g.graderOut}`, r.notes].filter(Boolean).join('; ') };
}

/**
 * Runs one task and returns its result fields.
 * @param {any} t @param {string} tag @returns {Promise<Record<string, any>>}
 */
async function runTask(t, tag) {
  if (bench === 'wg') {
    const since = Date.now() - (arm.kind === 'desktop' ? 5000 : 0);
    const r = await turn(webGamesPrompt(t, cfg.base, arm.browser), tag);
    const completions = existsSync(cfg.completions) ? parseJsonl(readFileSync(cfg.completions, 'utf8')) : [];
    const g = gradeWebGames({ task: t, answer: r.answer ?? '', completions, since });
    return { ...r, ...g, notes: [g.notes, r.notes].filter(Boolean).join('; ') };
  }
  if (bench === 'real') return realTask(t, tag);
  macReset(t, paths.macarena);
  const r = await turn(macPrompt(t), tag);
  const g = macGrade(t);
  return {
    ...r,
    score: g.score,
    success: !r.outsideBrowser && g.score === 100,
    notes: [r.notes, `graders: ${g.outs.map((o) => o.slice(-200)).join(' | ')}`].filter(Boolean).join('; '),
  };
}

for (const t of tasks) {
  const base = { task: t.id, arm: cfg.armName, bench, run: cfg.run };
  const out = path.join(cfg.resultsDir, `${t.id}.json`);
  const unsupported = arm.unsupported?.[bench];
  if (unsupported) {
    writeFileSync(out, JSON.stringify(resultRecord({ ...base, unsupported: true, gradable: false, notes: unsupported }), null, 2));
    console.log(JSON.stringify({ task: t.id, unsupported: true }));
    continue;
  }
  const tag = runTag(cfg.armName, t.id);
  /** @type {Record<string, any>} */
  let res;
  try {
    res = await runTask(t, tag);
    if (res.driverError) {
      res = { ...res, gradable: false, notes: `driver error before the prompt reached the agent: ${res.error}; ${res.notes ?? ''}` };
    }
  } catch (e) {
    // setup or grading failed (a missing tab, a missing task file): this task is ungradable, and the run goes on
    res = { ok: false, gradable: false, error: String(e.message).slice(0, 500), notes: 'driver error during setup or grading' };
  }
  const record = resultRecord({ ...res, ...base, tag, timeout: timedOut(res) });
  writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(
    JSON.stringify({ task: t.id, success: record.success, gradable: record.gradable, wallMs: record.wallMs, timeout: record.timeout }),
  );
  try {
    screenshot(path.join(cfg.resultsDir, `${t.id}.png`));
  } catch {
    // a screenshot is a debugging aid only
  }
}
