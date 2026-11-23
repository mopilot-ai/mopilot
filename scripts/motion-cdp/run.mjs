// Motion capture over CDP (#1511): MoPilot's side of a motion moment on a scratch instance in background mode, on each harness family's fake, driven and measured only through CDP (Animation domain timings, Page.startScreencast frames), never the mouse, keyboard or screen.
//
// It runs on request (#1511 measures MoPilot here and the vendor apps in the benchmark VM): it launches its own
// instance with scratch user data and fake harnesses (scripts/perf-bench/driver.mjs), which opens without taking focus,
// and quits it at the end. Output per family, under --out: animations.json and summary.md (every animation the page
// ran: element, duration, delay, easing), frames/ (screencast JPEGs and frames.json) and recording.json, which
// `node bench/motion-metrics.mjs <recording.json>` measures like a VM recording.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MARK } from '../perf-bench/replay.mjs';
import { startCapture } from './session.mjs';

export const FAMILIES = /** @type {const} */ (['claude', 'codex', 'acp']);
/** Chromium switches that keep a window drawn behind others from being throttled, so its timings are real. */
export const UNTHROTTLED = [
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
];
/** The turn's prompt: the perf bench's mark arms the fakes' replay, which streams its paced reply whatever the rest says. */
export const PROMPT = `${MARK} Motion capture: list the files here, then explain the project in three short paragraphs.`;
/** The words that make each fake ask for an approval: an MCP tool's can_use_tool, a command approval, an ACP permission. */
export const APPROVAL_TRIGGERS = /** @type {const} */ ({ claude: 'MCPREPO', codex: 'APPROVECMD', acp: 'PERMIT' });
/** The words that make each fake run a command whose row can open (Claude Code and Codex ask first). */
export const STEP_TRIGGERS = /** @type {const} */ ({ claude: 'RUNCMD', codex: 'APPROVECMD', acp: 'TOOL' });
/** How long the steps moment waits for an approval card before it takes it that none comes. */
export const CARD_WAIT_MS = 20_000;
/**
 * The moments this tool captures: a whole turn; a turn that stops on an approval card the capture then allows; a turn
 * whose finished work is unfolded ("Worked for") and one tool row opened and closed again.
 */
export const MOMENTS = /** @type {const} */ (['turn-start', 'approval', 'steps']);
/** How long a press on Allow is held, so its :active state shows before the release. */
export const PRESS_MS = 160;
/** Time after the turn ends before the capture stops, so the last animations finish. */
export const SETTLE_MS = 1500;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * @typedef {{ app: string, out: string | null, families: ('claude' | 'codex' | 'acp')[], rate: number, chunk: number,
 *   bytes: number, toolEveryMs: number, reduced: boolean, quality: number, moment: 'turn-start' | 'approval' | 'steps' }} Options
 */

/** Parses the command line; throws on what it does not know. */
export function parseArgs(/** @type {string[]} */ argv) {
  /** @type {Options} */
  const o = {
    app: ROOT,
    out: null,
    families: [...FAMILIES],
    rate: 50,
    chunk: 12,
    bytes: 1600,
    toolEveryMs: 2500,
    reduced: false,
    quality: 80,
    moment: 'turn-start',
  };
  const positive = (/** @type {string} */ k, /** @type {string | undefined} */ v) => {
    const n = Number(v);
    if (!(n > 0)) throw new Error(`${k} takes a positive number: ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--reduced-motion') o.reduced = true;
    else if (k === '--app') o.app = path.resolve(String(argv[++i]));
    else if (k === '--out') o.out = path.resolve(String(argv[++i]));
    else if (k === '--families') {
      const list = String(argv[++i]).split(',').filter(Boolean);
      for (const f of list)
        if (!FAMILIES.includes(/** @type {any} */ (f))) throw new Error(`unknown family ${f}; known: ${FAMILIES.join(', ')}`);
      o.families = /** @type {Options['families']} */ (list);
    } else if (k === '--rate') o.rate = positive(k, argv[++i]);
    else if (k === '--chunk') o.chunk = positive(k, argv[++i]);
    else if (k === '--bytes') o.bytes = positive(k, argv[++i]);
    else if (k === '--tool-every') o.toolEveryMs = positive(k, argv[++i]);
    else if (k === '--quality') o.quality = Math.min(100, positive(k, argv[++i]));
    else if (k === '--moment') {
      const m = String(argv[++i]);
      if (!MOMENTS.includes(/** @type {any} */ (m))) throw new Error(`unknown moment ${m}; known: ${MOMENTS.join(', ')}`);
      o.moment = /** @type {Options['moment']} */ (m);
    } else throw new Error(`unknown option ${k}`);
  }
  if (!o.families.length) throw new Error('--families needs at least one family');
  return o;
}

/** The page's layout for the metrics: the regions a moment reads, in CSS px (null when the element is not there). */
export const LAYOUT_JS = `(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  return { transcript: r('.thread-scroll'), composer: r('.thread-composer-area') };
})()`;

/** What each moment's summary is titled after. */
const TITLES = { 'turn-start': 'a turn', approval: 'an approval', steps: 'unfolding the work' };

/**
 * The steps moment's clicks, synthetic through CDP: the finished turn's "Worked for" opens its work (a chat whose
 * layout folds it), then the first tool row that can open is opened and closed again, each after the last one's
 * motion has played. Marks each click it made; a control the harness's layout does not have is skipped.
 * @param {any} page @param {Record<string, number>} marks @param {{ now: () => number, sleep: (ms: number) => Promise<unknown> }} t
 */
export async function foldSteps(page, marks, { now, sleep }) {
  await sleep(700);
  const fold = page.locator('.worked-for:not(.running)');
  if (await fold.count()) {
    marks.unfold = now();
    await fold.first().click();
    await sleep(700);
  }
  const rows = page.locator('.step-row.expandable .step-row-hit');
  if (!(await rows.count())) return;
  marks.expand = now();
  await rows.first().click();
  await sleep(700);
  marks.collapse = now();
  await rows.first().click();
  await sleep(700);
}

/**
 * Captures one turn on one family: a new chat on its fake, then the turn sent and followed until it ends, with the
 * Animation domain and a screencast on (session.mjs). Writes the family's folder; returns a one-line summary.
 * @param {{ driver: any, s: any, family: 'claude' | 'codex' | 'acp', dir: string, o: Options,
 *   writeSettings: (ctl: string, settings: object) => void, now?: () => number, sleep?: (ms: number) => Promise<unknown> }} c
 */
export async function captureTurn({
  driver,
  s,
  family,
  dir,
  o,
  writeSettings,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  await s.page
    .getByRole('button', { name: /^New chat/ })
    .first()
    .click();
  await driver.pickHarness(s, family);
  writeSettings(s.ctl, { mode: 'replay', bytes: o.bytes, rate: o.rate, chunk: o.chunk, toolEveryMs: o.toolEveryMs, gate: false });
  const capture = await startCapture(s.page, { dir, reduced: o.reduced, quality: o.quality, now });
  await sleep(500);
  const sentAt = now();
  /** @type {Record<string, number>} */
  const marks = { send: sentAt };
  if (o.moment === 'approval') {
    await driver.send(s, `${MARK} ${APPROVAL_TRIGGERS[family]} Motion capture: an approval card, then allow it.`);
    await s.page.locator('.approval-card').first().waitFor({ timeout: 60_000 });
    marks.card = now();
    // the card's entrance plays out before the press
    await sleep(700);
    marks.allow = now();
    // a held press (synthetic, through CDP) so the button's :active state shows, then the release
    await s.page.locator('.approval-card .ap-btn.allow').first().click({ delay: PRESS_MS });
  } else if (o.moment === 'steps') {
    await driver.send(s, `${MARK} ${STEP_TRIGGERS[family]} Motion capture: run a command, then explain it.`);
    // Claude Code and Codex ask before they run it: allow it as an operator would
    const card = s.page.locator('.approval-card .ap-btn.allow').first();
    const asked = await card.waitFor({ timeout: CARD_WAIT_MS }).then(
      () => true,
      () => false,
    );
    if (asked) await card.click();
  } else await driver.send(s, PROMPT);
  await driver.waitTurns(s, 1, sentAt, 120_000);
  if (o.moment === 'steps') await foldSteps(s.page, marks, { now, sleep });
  await sleep(SETTLE_MS);
  // the thread view exists once the turn has drawn it (a new chat's home view has no transcript yet)
  const regions = await s.page.evaluate(LAYOUT_JS);
  const done = await capture.finish({
    title: `MoPilot ${family}: animations during ${TITLES[o.moment]}`,
    arm: `mp-${family}`,
    family: 'mopilot',
    moment: o.moment,
    marks,
    regions,
  });
  return `${family}: ${done}`;
}

/** Loads a module of this tool (relative to this file) or a package. */
export const loadModule = (/** @type {string} */ p) => import(p);
/** A fresh output folder when --out is not given. */
export const scratchDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'motion-cdp-'));

/**
 * The command line: one scratch instance per family, each captured and quit before the next.
 * @param {string[]} [argv]
 * @param {{ load?: (p: string) => Promise<any>, log?: (s: string) => void, error?: (s: string) => void, tmp?: () => string }} [deps]
 */
export async function main(
  argv = process.argv.slice(2),
  { load = loadModule, log = console.log, error = console.error, tmp = scratchDir } = {},
) {
  /** @type {Options} */
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    error(/** @type {Error} */ (e).message);
    return 2;
  }
  if (!fs.existsSync(path.join(o.app, 'dist', 'index.html'))) {
    error(`Build the app first (npm run build in ${o.app}): the instance loads dist/index.html.`);
    return 2;
  }
  const out = o.out ?? tmp();
  const { createDriver, writeSettings } = await load('../perf-bench/driver.mjs');
  const { _electron } = await load('@playwright/test');
  const driver = createDriver({ electron: _electron, root: o.app, log });
  let failed = 0;
  for (const family of o.families) {
    const dir = path.join(out, family);
    /** @type {any} */
    let s;
    try {
      s = await driver.start(path.join(dir, 'profile'), { args: UNTHROTTLED });
    } catch (e) {
      // an instance that never came up: the other families still run
      failed += 1;
      error(`${family}: the instance did not start: ${/** @type {Error} */ (e).message}`);
      continue;
    }
    try {
      log(await captureTurn({ driver, s, family, dir, o, writeSettings }));
    } catch (e) {
      failed += 1;
      error(`${family}: ${/** @type {Error} */ (e).message}`);
    } finally {
      await driver.stop(s, out);
    }
  }
  log(`Written to ${out}`);
  return failed ? 1 : 0;
}

// the command line entry, on request (#1511)
if (import.meta.url === pathToFileURL(String(process.argv[1])).href) process.exitCode = await main();
