// The streaming benchmark (docs/performance/measurement.md): runs scenarios S1 to S7 on a scratch MoPilot instance over the fake harnesses, with the probes on, and writes cells.json, runs.json and the report.
//
// Release-only, like the other suites that take over the computer: it refuses to start unless MOPILOT_RELEASE=1 or it
// runs in an isolated virtual machine (release-suites.cjs); agents run it there through scripts/vm-exec.sh. Each
// scenario gets its own instance (its own home, user data and control folder under --out), driven over its debugging
// port by Playwright, and closed before the next.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CHUNKS, RATES, REPEATS, SCENARIO_IDS, cells as allCells, plans, sendOrder } from './scenarios.mjs';
import { CHARS_PER_TOKEN, MARK } from './replay.mjs';

const require = createRequire(import.meta.url);
const { insideVirtualMachine } = require('../release-suites.cjs');
const { checkoutCore } = require('../../electron/platform/core.cjs');

/** How often a plan runs when its chats start on another harness than the one picked (a pick before the harness was ready). */
export const PLAN_ATTEMPTS = 2;
/** Time after the last turn ends before a cell's window closes, so the frames that paint it are counted. */
export const SETTLE_MS = 1000;

/**
 * @typedef {{ scenarios: string[], rates: number[], chunks: number[], repeats: number, turnsScale: number,
 *             out: string | null, app: string | null, foreground: boolean | null }} Options
 */

/**
 * Parses the command line; throws on what it doesn't know.
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const o = {
    scenarios: [...SCENARIO_IDS],
    rates: [...RATES],
    chunks: [...CHUNKS],
    repeats: REPEATS,
    turnsScale: 1,
    out: null,
    app: null,
    foreground: null,
  };
  const list = (/** @type {string} */ v) =>
    String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const numbers = (/** @type {string} */ v, /** @type {string} */ k) =>
    list(v).map((x) => {
      const n = Number(x);
      if (!(n > 0)) throw new Error(`${k} takes positive numbers: ${v}`);
      return n;
    });
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split(/=(.*)/s);
    const v = () => inline ?? argv[++i];
    if (k === '--scenarios') o.scenarios = list(v());
    else if (k === '--rates') o.rates = numbers(v(), k);
    else if (k === '--chunks') o.chunks = numbers(v(), k);
    else if (k === '--repeats') o.repeats = Math.max(1, Number.parseInt(v(), 10) || 1);
    else if (k === '--turns-scale') o.turnsScale = numbers(v(), k)[0];
    else if (k === '--out') o.out = path.resolve(v());
    else if (k === '--app') o.app = path.resolve(v());
    else if (k === '--foreground') o.foreground = true;
    else if (k === '--background') o.foreground = false;
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  for (const s of o.scenarios) if (!SCENARIO_IDS.includes(s)) throw new Error(`Unknown scenario: ${s}`);
  return o;
}

/**
 * Why this run must not start, or null: the release gate, and a built app to launch.
 * @param {Options} o
 * @param {{ env?: Record<string, string | undefined>, inVm?: () => boolean, exists?: (p: string) => boolean }} [deps]
 */
export function refusal(o, { env = process.env, inVm = insideVirtualMachine, exists = fs.existsSync } = {}) {
  if (env.MOPILOT_RELEASE !== '1' && !inVm())
    return 'The streaming benchmark is release-only: ask the user to start it with MOPILOT_RELEASE=1, or run it in the isolated virtual machine (scripts/vm-exec.sh).';
  if (!o.app) return '--app is required: the MoPilot checkout to launch unpackaged (a separate instance, with its own user data).';
  if (!exists(path.join(o.app, 'dist', 'index.html')))
    return 'Build the app first (npm run build in the --app checkout): the instance loads dist/index.html.';
  if (!exists(/** @type {string} */ (checkoutCore(o.app))))
    return 'Build the Rust core first (node scripts/build-core.mjs --ensure in the --app checkout): the instance does not start without it.';
  return null;
}

/** What went wrong, for the report: an error's message, or what was thrown. */
const errorText = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));
/** Loads a module of the benchmark (relative to this file) or a package. */
export const importModule = (/** @type {string} */ p) => import(p);

/** How long a cell may take: its reply at its rate, plus a minute for the instance. */
export const cellTimeoutMs = (/** @type {number} */ bytes, /** @type {number} */ rate) =>
  (bytes / (rate * CHARS_PER_TOKEN)) * 1000 + 60_000;

/**
 * Runs every plan's cells over a driver (driver.mjs, or a fake in tests); returns the cells measured.
 * @param {Options} o
 * @param {{ driver: ReturnType<typeof import('./driver.mjs').createDriver>, out: string, foreground: boolean,
 *           writeSettings: (ctl: string, s: object) => void, warmSettings: (bytes: number) => object,
 *           now?: () => number, sleep?: (ms: number) => Promise<unknown>, log?: (s: string) => void }} deps
 */
export async function runBench(
  o,
  {
    driver,
    out,
    foreground,
    writeSettings,
    warmSettings,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => undefined,
  },
) {
  /** @type {import('./aggregate.mjs').Cell[]} */
  const measured = [];
  for (const plan of plans(o.scenarios, { turnsScale: o.turnsScale }))
    for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
      const dir = path.join(out, `${plan.id}-${plan.variant}${attempt > 1 ? `-${attempt}` : ''}`);
      log(`${plan.id} ${plan.variant}: ${plan.chats.length} chats, ${plan.turns} turns each`);
      const s = await driver.start(dir, { foreground });
      /** a chat that started on another harness than the one picked: the plan runs again on a fresh instance */
      let wrongHarness = false;
      /** @type {import('./aggregate.mjs').Cell[]} */
      const mine = [];
      try {
        // history: every chat's turns, at once in one delta each
        writeSettings(s.ctl, warmSettings(plan.bytes));
        const ids = [];
        for (const chat of plan.chats) {
          const id = await driver.newChat(s, chat.family, `${MARK} warm 1`);
          for (let n = 2; n <= plan.turns; n++) {
            const since = now();
            try {
              await driver.send(s, `${MARK} warm ${n}`);
              await driver.waitTurns(s, 1, since, 120_000);
            } catch (e) {
              // how much history the window held when it stopped answering is the finding
              throw new Error(`history turn ${n} of ${plan.turns}: ${errorText(e)}`);
            }
            if (n % 50 === 0) log(`  history: ${n} of ${plan.turns} turns`);
          }
          if (chat.switchTo) await driver.switchHarness(s, chat.switchTo);
          ids.push(id);
        }
        for (const [i, chat] of plan.chats.entries()) if (chat.role === 'window2') await driver.openWindow(s, ids[i]);
        for (const cell of allCells(o)) {
          const base = { scenario: plan.id, variant: plan.variant, ...cell, chats: plan.chats.length, probe: '' };
          try {
            writeSettings(s.ctl, {
              mode: 'replay',
              bytes: plan.bytes,
              rate: cell.rate,
              chunk: cell.chunk,
              toolEveryMs: plan.toolEveryMs,
              gate: true,
            });
            fs.rmSync(path.join(s.ctl, 'go'), { force: true });
            for (const { i } of sendOrder(plan.chats)) {
              await driver.openChat(s, ids[i]);
              await driver.send(s, `${MARK} ${cell.rate}/${cell.chunk} #${cell.rep}`);
            }
            await driver.focus(s);
            const from = now();
            fs.writeFileSync(path.join(s.ctl, 'go'), '');
            await driver.waitTurns(s, plan.chats.length, from, cellTimeoutMs(plan.bytes, cell.rate));
            await sleep(SETTLE_MS);
            mine.push({ ...base, from, to: now() });
            log(`  ${cell.rate} tok/s × ${cell.chunk}: ok`);
          } catch (e) {
            mine.push({ ...base, from: 0, to: 0, error: errorText(e) });
            log(`  ${cell.rate} tok/s × ${cell.chunk}: ${errorText(e)}`);
          }
        }
      } catch (e) {
        // the instance never got its chats ready: the plan's cells are recorded as failed, or it runs again when the
        // harness was picked before it was ready (driver.mjs newChat)
        const error = errorText(e);
        wrongHarness = /** @type {any} */ (e)?.wrongHarness === true && attempt < PLAN_ATTEMPTS;
        log(`  failed: ${error}${wrongHarness ? '; running the plan again on a fresh instance' : ''}`);
        for (const cell of allCells(o))
          mine.push({ scenario: plan.id, variant: plan.variant, ...cell, chats: plan.chats.length, probe: '', from: 0, to: 0, error });
      } finally {
        const probes = await driver.stop(s, out);
        for (const c of mine) c.probe = probes[0] ?? '';
        if (!wrongHarness) measured.push(...mine);
      }
      if (!wrongHarness) break;
    }
  return measured;
}

/**
 * The command: checks, then the run on the real driver; writes cells.json, runs.json and summary.md under --out.
 * @param {string[]} [argv]
 * @param {{ env?: Record<string, string | undefined>, inVm?: () => boolean, load?: (p: string) => Promise<any>,
 *           out?: { log: (s: string) => void, error: (s: string) => void }, exists?: (p: string) => boolean }} [deps]
 */
export async function main(
  argv = process.argv.slice(2),
  { env = process.env, inVm = insideVirtualMachine, load = importModule, out = console, exists = fs.existsSync } = {},
) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    out.error(errorText(e));
    return 2;
  }
  const why = refusal(o, { env, inVm, exists });
  if (why) {
    out.error(why);
    return 2;
  }
  const work = o.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'perf-bench-'));
  fs.mkdirSync(work, { recursive: true });
  const { createDriver, writeSettings, warmSettings } = await load('./driver.mjs');
  const { aggregateRun } = await load('./aggregate.mjs');
  const { _electron } = await load('@playwright/test');
  // in a virtual machine nobody's work is in front, so the active window may take focus
  const foreground = o.foreground ?? inVm();
  const driver = createDriver({ electron: _electron, root: o.app, log: (s) => out.log(s) });
  const measured = await runBench(o, { driver, out: work, foreground, writeSettings, warmSettings, log: (s) => out.log(s) });
  fs.writeFileSync(path.join(work, 'cells.json'), JSON.stringify(measured, null, 2));
  out.log(aggregateRun(work));
  out.log(`Written to ${work}`);
  return measured.some((c) => c.error) ? 1 : 0;
}

// the command line entry (run at a release, or by an agent in the virtual machine)
if (import.meta.url === pathToFileURL(String(process.argv[1])).href) process.exitCode = await main();
