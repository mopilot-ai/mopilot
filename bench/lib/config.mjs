// Benchmark run configuration: the benchmarks, the arms and how each is driven, and parsing a run's command line.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The bench/ folder; results and the external checkouts live under it by default. */
export const BENCH_DIR = fileURLToPath(new URL('../', import.meta.url));

/** wg: WebGames (in-app browser), real: REAL / agisdk (in-app browser), mac: MacArena (computer use). */
export const BENCHES = ['wg', 'real', 'mac'];
export const BENCH_NAMES = { wg: 'WebGames', real: 'REAL', mac: 'MacArena' };
export const TIERS = ['smoke', 'full'];

/**
 * The arms. A `mopilot` arm is one MoPilot instance driven over its CDP port on one harness; a `desktop` arm is a
 * native app driven through the VM's GUI, followed through its own transcript on disk. Coordinates are in the 1200 px
 * wide screenshot space of the benchmark VM's 1440x900 screen (bench/drivers/gui.mjs scales them).
 * `unsupported` names benchmarks an arm cannot be graded on, with the reason recorded in its results.
 */
export const ARMS = {
  'mp-claude': { kind: 'mopilot', harness: 'Claude Code', model: 'Sonnet 5.5', port: '9361', browser: 'the in-app browser' },
  'mp-codex': { kind: 'mopilot', harness: 'Codex', model: '', port: '9362', browser: 'the in-app browser' },
  'desk-claude': {
    kind: 'desktop',
    app: 'Claude',
    transcripts: 'claude',
    // Cmd+N opens a new session with its composer focused (the sidebar moves between versions, and a stray click can
    // land in one of the account's own synced sessions); the model is picked per session: ⇧⌘I, then its number
    newChat: 'cmd+n',
    composer: null,
    modelKeys: { 'Sonnet 5.5': '3', 'Opus 5.5': '1', 'Haiku 5.5': '4' },
    // the permission mode its runs must use (the transcript's permissionMode): Auto, as in the baseline. The app keeps
    // the last mode chosen for new sessions but has fallen back to Manual, whose approval cards no driver answers
    permission: 'auto',
    // its chats are archived after each task (they sit next to the user's own): the sidebar row's menu, Archive
    archive: 'row-menu',
    browser: "the app's built-in browser only (no other browser)",
    unsupported: {
      real: 'Claude Desktop browses in its built-in pane, whose storage the grader cannot read, and it quits when started with --remote-debugging-port',
    },
  },
  'desk-chatgpt': {
    kind: 'desktop',
    app: 'ChatGPT',
    transcripts: 'codex',
    // Cmd+N opens a new chat with its composer focused; the model chosen in the composer carries over to new chats
    newChat: 'cmd+n',
    composer: null,
    // its composer is not in the app's accessibility tree (12 nodes, no AXTextArea; #4114): there is nothing to focus,
    // so a follow-up is pasted into whatever the chat has focused and the transcript check decides whether it arrived
    composerInTree: false,
    cdp: '9398',
    // Full access: the rollout's approval policy and sandbox
    permission: 'never/danger-full-access',
    // its chats are archived after each task: Shift+Cmd+A archives the open chat
    archive: 'shift-cmd-a',
    browser: "the app's built-in browser",
  },
};

const USAGE =
  'usage: node bench/run.mjs --bench wg|real|mac --arm <arm> [--tier smoke|full] [--tasks a,b] [--run <name>] ' +
  '[--port <cdp>] [--harness <name>] [--model <label>] [--timeout <s>] [--base <webgames-url>] [--extra <text>] ' +
  `[--results <dir>] [--external <dir>]; arms: ${Object.keys(ARMS).join(', ')}`;

/**
 * Parses and checks a run's arguments; throws with the usage on anything wrong.
 * @param {string[]} argv
 */
export function parseRunArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        bench: { type: 'string' },
        arm: { type: 'string' },
        tier: { type: 'string', default: 'smoke' },
        tasks: { type: 'string', default: '' },
        run: { type: 'string', default: 'local' },
        port: { type: 'string' },
        harness: { type: 'string' },
        model: { type: 'string' },
        timeout: { type: 'string', default: '300' },
        base: { type: 'string', default: 'http://127.0.0.1:8800' },
        extra: { type: 'string', default: '' },
        results: { type: 'string', default: path.join(BENCH_DIR, 'results') },
        external: { type: 'string', default: path.join(BENCH_DIR, 'external') },
      },
    }));
  } catch (e) {
    throw new Error(`${e.message}\n${USAGE}`);
  }
  const fail = (why) => {
    throw new Error(`${why}\n${USAGE}`);
  };
  if (!BENCHES.includes(values.bench)) fail(`--bench must be one of ${BENCHES.join(', ')}`);
  const arm = Object.hasOwn(ARMS, values.arm ?? '') ? ARMS[values.arm] : null;
  if (!arm) fail(`unknown --arm ${values.arm}`);
  if (!TIERS.includes(values.tier)) fail(`--tier must be smoke or full`);
  if (!/^(?!\.+$)[\w.-]+$/.test(values.run)) fail('--run must be a plain name (letters, digits, . _ -), not . or ..');
  const timeoutS = Number(values.timeout);
  if (!Number.isInteger(timeoutS) || timeoutS <= 0) fail('--timeout must be a positive number of seconds');
  return {
    bench: values.bench,
    armName: values.arm,
    arm: {
      ...arm,
      ...(values.port ? { port: values.port } : {}),
      ...(values.harness ? { harness: values.harness } : {}),
      ...(values.model !== undefined ? { model: values.model } : {}),
    },
    tier: values.tier,
    tasks: values.tasks
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    run: values.run,
    timeoutS,
    base: values.base.replace(/\/+$/, ''),
    extra: values.extra,
    resultsDir: path.join(values.results, values.run, values.arm),
    // where bench/webgames-serve.mjs logs the completions pages report (start it with the same path)
    completions: path.join(values.results, 'webgames-completions.jsonl'),
    external: values.external,
  };
}
