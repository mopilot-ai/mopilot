// The Chrome comparison (design D5): runs each task on each harness in four arms (native, ext, B2, B1) against a scratch Chrome profile, and writes success, time, tool calls, invalid calls and cards.
//
// Release-only, like the other suites that take over the computer: it refuses to start unless
// MOPILOT_RELEASE=1 or it runs in an isolated virtual machine (release-suites.cjs), and it only ever drives a Chrome profile under --user-data-dir, which must be a scratch
// folder (never Chrome's own user data folder). The native arm also refuses while any other Chrome runs,
// since the vendors' extensions may pair with it. How to run it: docs/control-plane/chrome-comparison.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { selectTasks, UPLOAD_TEXT } from './tasks.mjs';
import { summarize, table } from './metrics.mjs';
import { summarizeActions, actionTable } from './actions.mjs';

const { insideVirtualMachine } = createRequire(import.meta.url)('../release-suites.cjs');

export const ARMS = Object.freeze({
  // the vendors' own Chrome controllers: Claude in Chrome on a Claude Code chat, the Codex Browser plugin on a Codex chat
  // (codex.browser.chromeExtension=0: Codex segments otherwise get MoPilot's extension by default)
  native: { flags: 'shared.browser.chromeRelay=0,codex.browser.chromeExtension=0', channel: 'builtin' },
  // MoPilot's own Chrome extension behind the native-shaped tools, in a Chrome of its own with the extension
  // loaded unpacked and its pairing page answered (extension.mjs)
  ext: { flags: 'shared.browser.chromeExtension=1,native.claude.chrome=0', channel: 'builtin', ownChrome: true },
  // MoPilot's relay behind the native-shaped tools (chrome_* for Claude, the extension backend for Codex)
  b2: { flags: 'shared.browser.chromeRelay=1,native.claude.chrome=0', channel: 'builtin' },
  // MoPilot's own tools (sage_browser_*) over Your Chrome
  b1: { flags: 'shared.browser.chromeRelay=0,native.claude.chrome=0,codex.browser.chromeExtension=0', channel: 'chrome' },
  // the switches as the build ships them, on MoPilot's own extension: what an ACP chat gets by default (#1483);
  // not run unless asked for (--arms)
  shipped: { flags: 'native.claude.chrome=0', channel: 'builtin', ownChrome: true, optional: true },
  // the chrome_* tools off: a Codex chat's Browser plugin drives MoPilot's extension through its Chrome backend
  // (chromeBackend.cjs, #1539); a Claude Code chat has no Chrome here. Not run unless asked for (--arms)
  plugin: {
    flags: 'native.claude.chrome=0,shared.browser.chromeExtensionByDefault=0',
    channel: 'builtin',
    ownChrome: true,
    optional: true,
  },
});
/** Every harness a run can name; opencode (an ACP harness) only when asked for (--harnesses). */
export const HARNESSES = Object.freeze(['claude', 'codex', 'opencode']);

/** Chrome's own user data folders on this machine: the comparison never uses them. */
export function chromeHomes(home = os.homedir(), platform = process.platform, env = process.env) {
  if (platform === 'darwin')
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary', 'Chromium'].map((p) =>
      path.join(home, 'Library', 'Application Support', p),
    );
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      'Google\\Chrome\\User Data',
      'Google\\Chrome Beta\\User Data',
      'Google\\Chrome Dev\\User Data',
      'Google\\Chrome SxS\\User Data',
      'Chromium\\User Data',
    ].map((p) => path.win32.join(local, p));
  }
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium'].map((p) => path.join(home, '.config', p));
}

/**
 * A folder as the disk sees it: links followed (through its nearest existing parent, for a folder not made yet),
 * and in lower case where the disk ignores case (macOS, Windows).
 */
export function canonical(p, platform = process.platform) {
  let head = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(head) && path.dirname(head) !== head) {
    rest.unshift(path.basename(head));
    head = path.dirname(head);
  }
  const real = path.join(fs.realpathSync.native(head), ...rest);
  return platform === 'darwin' || platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * @typedef {{ arms: string[], harnesses: string[], tasks: string[] | null, optional: boolean, repeat: number,
 *             userDataDir: string | null, app: string | null, out: string | null, timeoutMs: number,
 *             models: Record<string, string>, effort: string | null, probe: string | null, flags: string }} Options
 */

/**
 * Parses the command line; throws on what it doesn't know.
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const o = {
    arms: Object.keys(ARMS).filter((a) => !ARMS[a].optional),
    harnesses: ['claude', 'codex'],
    tasks: null,
    optional: false,
    repeat: 1,
    userDataDir: null,
    app: null,
    out: null,
    timeoutMs: 600_000,
    // each harness's model by its name in the picker; a harness not named takes its first
    models: {},
    // a Codex chat's reasoning effort (its default in the instance's settings); null: the model's own default
    effort: null,
    // a module (default export: (own, phase) => Promise<void>) that inspects the ext arm's Chrome while a turn runs
    probe: null,
    // MOPILOT_FLAGS switches added to every arm's own, e.g. shared.browser.chromePageTree=1
    flags: '',
  };
  const list = (v) =>
    String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split(/=(.*)/s);
    const v = () => inline ?? argv[++i];
    if (k === '--arms') o.arms = list(v());
    else if (k === '--harnesses') o.harnesses = list(v());
    else if (k === '--tasks') o.tasks = list(v());
    else if (k === '--optional') o.optional = true;
    else if (k === '--repeat') o.repeat = Math.max(1, Number.parseInt(v(), 10) || 1);
    else if (k === '--user-data-dir') o.userDataDir = path.resolve(v());
    else if (k === '--app') o.app = path.resolve(v());
    else if (k === '--out') o.out = path.resolve(v());
    else if (k === '--timeout') o.timeoutMs = Math.max(1, Number(v()) || 600) * 1000;
    else if (k === '--effort') o.effort = String(v()).trim() || null;
    else if (k === '--probe') o.probe = path.resolve(v());
    else if (k === '--flags') o.flags = String(v()).trim();
    else if (k === '--model') {
      const [h, m] = String(v()).split(/=(.*)/s);
      if (!m?.trim()) throw new Error(`--model takes harness=model, as the picker names the model: ${argv[i]}`);
      o.models[h.trim()] = m.trim();
    } else throw new Error(`Unknown option: ${argv[i]}`);
  }
  for (const a of o.arms) if (!ARMS[a]) throw new Error(`Unknown arm: ${a}`);
  for (const h of [...o.harnesses, ...Object.keys(o.models)]) if (!HARNESSES.includes(h)) throw new Error(`Unknown harness: ${h}`);
  return o;
}

/**
 * Why this run must not start, or null: the release gate, a scratch --user-data-dir that is no Chrome home
 * (nor inside or around one), and an --app to launch.
 */
export function refusal(
  o,
  { env = process.env, homes = chromeHomes(), platform = process.platform, inVm = insideVirtualMachine, exists = fs.existsSync } = {},
) {
  if (env.MOPILOT_RELEASE !== '1' && !inVm())
    return 'The Chrome comparison is release-only: ask the user to start it with MOPILOT_RELEASE=1, or run it in the isolated virtual machine.';
  if (!o.userDataDir) return '--user-data-dir is required: a scratch Chrome profile folder, never your own.';
  // another browser's own profile folders are not known here: only Google Chrome
  if (env.MOPILOT_CHROME_RELAY_EXECUTABLE) return 'The Chrome comparison runs Google Chrome only: unset MOPILOT_CHROME_RELAY_EXECUTABLE.';
  const inside = (a, b) => a === b || a.startsWith(b + path.sep);
  const dir = canonical(o.userDataDir, platform);
  if (homes.map((h) => canonical(h, platform)).some((h) => inside(dir, h) || inside(h, dir)))
    return `${o.userDataDir} is (or holds) a Chrome profile of yours: use a scratch folder.`;
  if (!o.app) return '--app is required: the MoPilot checkout to launch unpackaged (a separate instance, with its own user data).';
  if (o.arms.some((a) => ARMS[a].ownChrome) && !exists(path.join(o.app, 'dist', 'chrome-extension', 'manifest.json')))
    return 'The ext arm loads the built extension: run npm run build:chrome-extension in the --app checkout first.';
  return null;
}

/**
 * Chrome processes that are not the scratch profile's (ps -axo command=): the native arm's vendor
 * extensions could pair with them, so it refuses while there are any.
 */
export function otherChromes(psText, userDataDir) {
  // a browser's main process: its executable, never a helper (--type=) or the crash handler
  const browser =
    /\/Google Chrome[^/]*\.app\/Contents\/MacOS\/Google Chrome[^/]*(?:\s|$)|\bchrome\.exe\b|\/(?:google-chrome[\w-]*|chromium(?:-browser)?)(?:\s|$)/i;
  return String(psText)
    .split('\n')
    .filter((l) => browser.test(l) && !/--type=/.test(l) && !l.split(/\s+/).includes(`--user-data-dir=${userDataDir}`));
}

/** Every process's command line (ps), for otherChromes. */
export const psCommands = () => execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' });
/** Loads a module of the harness (relative to this file) or a package. */
export const importModule = (p) => import(p);

/**
 * Runs the comparison over a driver (driver.mjs, or a fake in tests); returns every run and the summary.
 * @param {ReturnType<typeof parseArgs>} o
 * @param {{ driver: any, server: any, tasks: ReturnType<typeof selectTasks>, uploadFile: string, now?: () => number, log?: (s: string) => void,
 *           ps?: () => string }} deps
 */
export async function runComparison(o, { driver, server, tasks, uploadFile, now = Date.now, log = () => undefined, ps = () => '' }) {
  const runs = [];
  for (const arm of o.arms) {
    // checked before the arm and before each of its tasks: the user may open their Chrome during a long run
    const alone = () => {
      if (arm !== 'native') return;
      const others = otherChromes(ps(), o.userDataDir);
      if (others.length)
        throw new Error(`Quit your own Chrome first: the native arm's vendor extensions could pair with it (${others.length} running).`);
    };
    alone();
    const session = await driver.start(arm, ARMS[arm]);
    try {
      for (const harness of o.harnesses)
        for (const task of tasks)
          for (let n = 0; n < o.repeat; n++) {
            alone();
            server.reset();
            const prompt = task.prompt({ base: server.base, uploadFile });
            const started = now();
            let r;
            try {
              r = await driver.runTask(session, { harness, model: o.models[harness], prompt, timeoutMs: o.timeoutMs });
            } catch (e) {
              r = { answer: '', calls: null, invalid: null, cards: 0, error: String(e?.message ?? e) };
            }
            const ok = !r.error && task.check(server.records, r.answer, { uploadFile });
            const run = {
              arm,
              harness,
              task: task.id,
              ok,
              ms: now() - started,
              calls: r.calls,
              invalid: r.invalid,
              cards: r.cards,
              ...(r.actions ? { resultChars: r.actions.reduce((n, a) => n + a.chars, 0) } : {}),
              ...(r.actions ? { actions: r.actions } : {}),
              ...(typeof r.pairings === 'number' ? { pairings: r.pairings } : {}),
              ...(r.declined ? { declined: r.declined } : {}),
              // the end of the chat's answer, to tell why a run failed
              ...(r.answer ? { answer: String(r.answer).slice(-600) } : {}),
              // and what the pages received, when the check failed
              ...(ok ? {} : { posted: structuredClone(server.records) }),
              ...(r.error ? { error: r.error } : {}),
            };
            runs.push(run);
            log(`${arm} ${harness} ${task.id}: ${ok ? 'ok' : 'failed'}${r.error ? ` (${r.error})` : ''}`);
          }
    } finally {
      await driver.stop(session);
    }
  }
  return { runs, summary: summarize(runs) };
}

/**
 * The command: checks, then the run with the real page server and driver; writes runs.json and summary.md under --out.
 * @param {string[]} [argv]
 * @param {{ env?: Record<string, string | undefined>, homes?: string[], load?: (p: string) => Promise<any>,
 *           out?: { log: (s: string) => void, error: (s: string) => void }, spawn?: typeof import('node:child_process').spawn }} [deps]
 *   spawn: how the driver opens Chrome on the scratch profile (tests pass a fake; unit tests never start a browser)
 */
export async function main(argv = process.argv.slice(2), { env = process.env, homes, load = importModule, out = console, spawn } = {}) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    out.error(String(e.message));
    return 2;
  }
  const why = refusal(o, { env, ...(homes ? { homes } : {}) });
  if (why) {
    out.error(why);
    return 2;
  }
  const tasks = selectTasks({ ids: o.tasks, optional: o.optional });
  const work = o.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-compare-'));
  fs.mkdirSync(work, { recursive: true });
  const uploadFile = path.join(work, 'receipt-7731.txt');
  fs.writeFileSync(uploadFile, UPLOAD_TEXT);
  const { startFixtureServer } = await load('./server.mjs');
  const { electronDriver } = await load('./driver.mjs');
  const { _electron } = await load('@playwright/test');
  const server = await startFixtureServer({ tasks });
  const signIn = tasks.some((t) => t.id === 'signed-in') ? `${server.base}/login` : null;
  const probe = o.probe ? (await load(pathToFileURL(o.probe).href)).default : null;
  const driver = electronDriver({
    app: o.app,
    probe,
    extraFlags: o.flags,
    userDataDir: o.userDataDir,
    work,
    uploadFile,
    signIn,
    effort: o.effort,
    actionsHome: os.homedir(),
    electron: _electron,
    env,
    spawn,
    log: (s) => out.log(s),
  });
  try {
    const result = await runComparison(o, {
      driver,
      server,
      tasks,
      uploadFile,
      log: (s) => out.log(s),
      ps: psCommands,
    });
    fs.writeFileSync(path.join(work, 'runs.json'), JSON.stringify(result.runs, null, 2));
    fs.writeFileSync(path.join(work, 'summary.md'), `${table(result.summary)}\n\n${actionTable(summarizeActions(result.runs))}\n`);
    out.log(table(result.summary));
    out.log(`Written to ${work}`);
    return 0;
  } finally {
    server.close();
  }
}

// the command line entry (run by hand at a release)
if (import.meta.url === pathToFileURL(String(process.argv[1])).href) process.exitCode = await main();
