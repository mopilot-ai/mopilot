// Harness version contract (#1321): which harnesses it can install at a pinned version and how, the scratch paths and
// seeded settings of one run, the verdict against a baseline, the committed results, the run lock and the process
// watch. The suites' summaries are in contractSuites.mjs, re-exported here.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CELLS } from './edge.mjs';
import { ACP_CATALOG, ACP_PUBLIC_IDS } from '../../shared/harnessCatalog.mjs';

export * from './contractSuites.mjs';

/** @typedef {import('./contractSuites.mjs').Item} Item */

/** The result file's shape; bump it when a reader would misread an older file. */
export const CONTRACT_SCHEMA = 1;

/**
 * The harnesses the contract can install at an exact version: the npm package, the binary it puts in the prefix's
 * node_modules/.bin, what pins it in a MoPilot instance (`ui-state.json` as Settings → CLI location saves it), the
 * conformance runner's harness name and the model its turns use (a Sonnet-class model, cheap but not trivial: the
 * edge cells' Claude Code turns use Sonnet 5.5 too), the edge cells it is in, and the ACP quirks id. Package names follow the npm
 * install methods in #1289's install table. Harnesses whose vendor publishes no npm package (Kimi Code, Cursor CLI,
 * Goose) are not here: a contract for them is recorded as incomplete, never as passed.
 * @typedef {{ label: string, npm: string, bin: string, pin?: 'codexBin' | 'claudeBin', conformance?: 'codex' | 'claude', model?: string,
 *   cells: string[], acp?: string }} ContractHarness
 * @type {Record<string, ContractHarness>}
 */
export const HARNESSES = {
  codex: {
    label: 'Codex',
    npm: '@openai/codex',
    bin: 'codex',
    pin: 'codexBin',
    conformance: 'codex',
    model: 'gpt-6-luna',
    cells: ['codex', 'switch'],
  },
  claude: {
    label: 'Claude Code',
    npm: '@anthropic-ai/claude-code',
    bin: 'claude',
    pin: 'claudeBin',
    conformance: 'claude',
    model: 'claude-sonnet-5-5',
    cells: ['claude', 'switch'],
  },
  ...Object.fromEntries(
    ACP_PUBLIC_IDS.filter((id) => ACP_CATALOG[id].contract).map((id) => {
      const h = ACP_CATALOG[id];
      return [`acp:${id}`, { label: h.label, ...h.contract, cells: [], acp: id }];
    }),
  ),
};

export const SUITES = ['controlMatrix', 'conformance', 'edge', 'acp', 'mgb'];

/**
 * How a first-class CLI says whether it is signed in. A run on a signed-out CLI would fail every turn and read as a
 * regression, so the contract checks first and stops as incomplete.
 * @type {Record<string, { args: string[], signedIn: (out: string) => boolean }>}
 */
export const LOGIN_CHECKS = {
  claude: { args: ['auth', 'status'], signedIn: (out) => /"loggedIn":\s*true/.test(out) },
  codex: { args: ['login', 'status'], signedIn: (out) => /^Logged in\b/m.test(out) },
};
// no build metadata (+…): npm ignores it and --version never prints it, so such a version could never pass the install
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * A version as the contract names files and branches after it: a leading "v" dropped, otherwise exact. Null when it
 * is not a plain semver (no paths, spaces or shell characters can reach a file name or a command).
 * @param {unknown} v
 */
export function releaseVersion(v) {
  const s = String(v ?? '')
    .trim()
    .replace(/^v(?=\d)/, '');
  return VERSION.test(s) ? s : null;
}

/**
 * The version a CLI's `--version` prints ("2.1.296 (Claude Code)", "codex-cli 0.162.0-alpha.17.2", "GitHub Copilot CLI
 * 1.0.98." with the sentence's period), or null.
 */
export function versionFromOutput(/** @type {string} */ out) {
  const m = /(?:^|[\s/v])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]*[0-9A-Za-z])?)(?=$|[\s)(,]|\.(?![0-9A-Za-z]))/.exec(String(out ?? ''));
  return m ? m[1] : null;
}

const USAGE =
  'usage: node bench/contract-run.mjs --harness <kind> --version <x.y.z> [--suites controlMatrix,conformance,edge,acp] ' +
  `[--work <dir>] [--port-offset <n>] [--fixtures-port <n>] [--timeout <s>] [--click-chrome] [--keep]; harnesses: ${Object.keys(HARNESSES).join(', ')}`;

/**
 * The runner's arguments, checked; throws with the usage on anything wrong.
 * @param {string[]} argv
 * @param {{ home: string }} env
 */
export function parseContractArgs(argv, { home }) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        harness: { type: 'string' },
        version: { type: 'string' },
        suites: { type: 'string', default: SUITES.join(',') },
        work: { type: 'string', default: path.join(home, 'contract') },
        // clear of the edge suite's own runs (9371/9372, fixtures 8790/8791) and the VM's other instances on 9381/9382
        'port-offset': { type: 'string', default: '30' },
        'fixtures-port': { type: 'string', default: '8890' },
        timeout: { type: 'string', default: '180' },
        keep: { type: 'boolean', default: false },
        // offered Chrome and system-browser actions are recorded, never clicked, unless --click-chrome: the instance's
        // scratch Chrome folder keeps them off the VM's default profile (#1535), but another run's Chrome may be open
        'skip-chrome': { type: 'boolean', default: true }, // the default now; older command lines still parse
        'click-chrome': { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    throw new Error(`${/** @type {Error} */ (e).message}\n${USAGE}`);
  }
  const fail = (/** @type {string} */ why) => {
    throw new Error(`${why}\n${USAGE}`);
  };
  const kind = values.harness ?? '';
  if (!Object.hasOwn(HARNESSES, kind)) fail(`unknown harness ${kind || '(none)'}`);
  const version = releaseVersion(values.version);
  if (!version) fail(`--version must be a release version such as 2.1.296, not ${values.version ?? '(none)'}`);
  const suites = values.suites
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of suites) if (!SUITES.includes(s)) fail(`unknown suite ${s}`);
  const int = (/** @type {string} */ name, /** @type {number} */ min, /** @type {number} */ max) => {
    const n = Number(values[/** @type {'timeout'} */ (name)]);
    if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  return {
    kind,
    version: /** @type {string} */ (version),
    suites: suites.length ? suites : SUITES,
    work: path.resolve(values.work),
    portOffset: int('port-offset', 1, 1000),
    fixturesPort: int('fixtures-port', 1024, 65000),
    timeoutS: int('timeout', 1, 3600),
    keep: values.keep,
    skipChrome: !values['click-chrome'],
  };
}

/** Folder-safe name of one run: "claude@2.1.296", "acp-dsh@0.2.0-rc.2". @param {string} kind @param {string} version */
export const runName = (kind, version) => `${kind.replace(':', '-')}@${version}`;

/**
 * Everything one run owns under the work folder: the install prefix and its binary, the user-data folders of its
 * instances (one per CDP port its cells use), the fixture server's event log and the suites' outputs.
 * @param {{ work: string, kind: string, version: string, portOffset: number }} o
 */
export function contractPaths({ work, kind, version, portOffset }) {
  const h = HARNESSES[kind];
  const name = runName(kind, version);
  const dir = path.join(work, 'runs', name);
  const prefix = path.join(work, 'prefix', name);
  const ports = [...new Set(h.cells.map((c) => String(Number(/** @type {any} */ (CELLS)[c].port) + portOffset)))];
  return {
    dir,
    prefix,
    bin: path.join(prefix, 'node_modules', '.bin', h.bin),
    instances: ports.map((port) => ({ port, userData: path.join(dir, `userData-${port}`) })),
    events: path.join(dir, 'edge-events.jsonl'),
    conformanceOut: path.join(dir, 'conformance'),
    edgeResults: path.join(dir, 'edge'),
    // a Chrome the instances start themselves (MoPilot's Chrome relay) uses this profile, never the default one
    chromeProfile: path.join(dir, 'chrome-profile'),
    mgbResults: path.join(dir, 'mgb'),
    acpOut: path.join(dir, 'acp'),
    result: path.join(dir, 'contract.json'),
  };
}

/**
 * The pinned install: npm into a prefix of its own, so nothing on the VM's PATH changes and older versions sit beside
 * newer ones. `--prefix` without `-g` puts the binary in `<prefix>/node_modules/.bin`.
 * @param {string} kind @param {string} version @param {string} prefix
 */
export function installCommand(kind, version, prefix) {
  return {
    cmd: 'npm',
    args: ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--no-save', '--loglevel=error', `${HARNESSES[kind].npm}@${version}`],
  };
}

/**
 * `ui-state.json` for a scratch instance: the binary under test chosen as Settings → CLI location saves it (so the
 * newer CLI installed on the VM is not picked instead), Full access as the edge suite needs, and no close prompt,
 * update check, import or usage sharing.
 * @param {string} kind @param {string} bin
 */
export function seedUiState(kind, bin) {
  const pin = HARNESSES[kind].pin;
  return {
    ...(pin === 'codexBin' ? { codexBin: bin } : {}),
    prefs: {
      permission: 'full-access',
      // test runs use the cheaper models at low effort: Codex's GPT-6 Luna, and Claude Code at low (the edge suite
      // picks Sonnet 5.5; a pick keeps the effort)
      model: 'gpt-6-luna',
      effort: 'low',
      claudeSelection: { model: null, effort: 'low', fast: false },
      confirmClose: 'never',
      shareUsageData: false,
      autoUpdate: false,
      importSync: false,
      ...(pin === 'claudeBin' ? { claudeBin: bin } : {}),
    },
  };
}

/**
 * The contract's verdict. `incomplete` when the install or a suite could not run or grade, so nothing is claimed either
 * way. Otherwise a failing item is `known` when the baseline (the newest passing contract of that harness at a lower
 * version) failed it too, and a `regression` when it did not, or never ran it; a failing item of a suite the baseline
 * did not run at all is `unbaselined`, not a regression. `pass` needs no regression and a clean conformance run:
 * `versions.tested` counts only clean runs (tests/harnessMatrix.test.ts).
 * @param {{ install: { ok: boolean, error?: string }, suites: Record<string, { verdict: string, why?: string, items: Item[] }>,
 *   baseline: { failing: string[], suites?: Record<string, unknown> } | null }} o
 */
export function judgeContract({ install, suites, baseline }) {
  /** @type {string[]} */
  const incomplete = [];
  if (!install.ok) incomplete.push(`install: ${install.error ?? 'failed'}`);
  for (const [name, s] of Object.entries(suites))
    if (s.verdict === 'error') incomplete.push(`${name}: ${s.why ?? (s.items.some((i) => i.ungradable) ? 'ungradable runs' : 'error')}`);
  const items = Object.values(suites).flatMap((s) => s.items);
  const failing = items.filter((i) => i.failing);
  const before = new Set(baseline?.failing ?? []);
  // a suite the baseline never ran (one added since, like the 12-Grid Bench's mgb) has nothing to regress from: its
  // failures are listed as unbaselined until a contract that ran it becomes the baseline
  const ran = baseline?.suites ? new Set(Object.keys(baseline.suites)) : null;
  const unbaselinedItem = (/** @type {Item} */ i) => ran !== null && !ran.has(i.suite);
  const regressions = failing.filter((i) => !before.has(i.key) && !unbaselinedItem(i)).map((i) => i.key);
  const known = failing.filter((i) => before.has(i.key)).map((i) => i.key);
  const unbaselined = failing.filter(unbaselinedItem).map((i) => i.key);
  const conformanceClean = !failing.some((i) => i.suite === 'conformance');
  const verdict = incomplete.length ? 'incomplete' : regressions.length === 0 && conformanceClean ? 'pass' : 'fail';
  const failingRows = [...new Set(failing.filter((i) => regressions.includes(i.key)).flatMap((i) => i.rows))].sort();
  return { verdict, incomplete, regressions, known, unbaselined, failingRows };
}

/**
 * The baseline for a run: the newest contract of the same harness at a lower version that stands for "works today",
 * either because it passed or because its version is in versions.tested (the versions tested before the contract
 * existed: their failures are the known state, tracked as CM rows). A failed contract of an untested version never
 * counts, so a regression is never carried forward as known. Unreadable files are skipped by loadContracts.
 * @template {{ kind: string, version: string, verdict: string }} C
 * @param {C[]} contracts
 * @param {string} kind @param {string} version @param {(a: string, b: string) => number} compare
 * @param {string[]} [tested] the harness's versions.tested
 */
export function pickBaseline(contracts, kind, version, compare, tested = []) {
  return (
    contracts
      .filter(
        (c) =>
          c.kind === kind &&
          (c.verdict === 'pass' || (c.verdict === 'fail' && tested.includes(c.version))) &&
          compare(c.version, version) < 0,
      )
      .sort((a, b) => compare(b.version, a.version))[0] ?? null
  );
}

/**
 * The tested, known-bad and minimum versions of a harness as committed. First-class harnesses read them from
 * electron/harness/versions.cjs (tests/versions.test.ts keeps src/harness/registry.ts in step); an ACP harness is
 * tested at the version its admission result admitted (tests/conformance/results/acp-admission.json), and says what
 * that admission was.
 * @param {string} kind @param {{ versionsCjs: string, admission: any }} files
 * @returns {{ min: string, knownBad: string[], tested: string[], admission?: string }}
 */
export function committedVersions(kind, { versionsCjs, admission }) {
  if (kind.startsWith('acp:')) {
    const a = admission?.harnesses?.[kind.slice(4)];
    const state = a?.probeWithQuirksFixes?.state ?? 'not probed';
    return { min: '0.0.0', knownBad: [], tested: state === 'admitted' && a.version ? [a.version] : [], admission: state };
  }
  const m = new RegExp(`^\\s*${kind}: \\{ min: '([^']*)', knownBad: \\[([^\\]]*)\\], tested: \\[([^\\]]*)\\] \\},?$`, 'm').exec(
    versionsCjs,
  );
  if (!m) throw new Error(`electron/harness/versions.cjs has no versions line for ${kind}`);
  const list = (/** @type {string} */ s) => [...s.matchAll(/'([^']*)'/g)].map((x) => x[1]);
  return { min: m[1], knownBad: list(m[2]), tested: list(m[3]) };
}

/**
 * Reads the committed contract files (`<dir>/<kind>@<version>.json`, the kind's ":" as "-"). Returns the usable ones
 * and the names of files that could not be read or have the wrong shape.
 * @param {{ readdir: (d: string) => string[], readFile: (f: string) => string }} fsx @param {string} dir
 */
export function loadContracts(fsx, dir) {
  /** @type {{ kind: string, version: string, verdict: string, failing: string[], file: string }[]} */
  const contracts = [];
  /** @type {string[]} */
  const unreadable = [];
  let names = [];
  try {
    names = fsx.readdir(dir);
  } catch (e) {
    // no contract has been committed yet; any other failure is not "no baseline"
    if (/** @type {NodeJS.ErrnoException} */ (e)?.code === 'ENOENT') return { contracts, unreadable };
    throw e;
  }
  for (const f of names.filter((n) => n.endsWith('.json')).sort()) {
    try {
      const d = JSON.parse(fsx.readFile(path.join(dir, f)));
      if (!Object.hasOwn(HARNESSES, d?.kind) || !releaseVersion(d?.version) || typeof d?.verdict !== 'string' || !Array.isArray(d?.items))
        throw new Error('not a contract result');
      const failing = d.items.filter((/** @type {Item} */ i) => i?.failing).map((/** @type {Item} */ i) => i.key);
      contracts.push({ kind: d.kind, version: d.version, verdict: d.verdict, failing, file: f });
    } catch {
      // named in the result, so a broken file never passes for a baseline without failures
      unreadable.push(f);
    }
  }
  return { contracts, unreadable };
}

/**
 * Writes a result so no reader sees half a file: to a temp file beside it, then a rename.
 * @param {{ writeFile: (f: string, s: string) => void, rename: (a: string, b: string) => void, mkdir: (d: string) => void }} fsx
 * @param {string} file @param {unknown} record
 */
export function writeAtomic(fsx, file, record) {
  fsx.mkdir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fsx.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fsx.rename(tmp, file);
}

/**
 * Whether the pinned CLI is serving the instances, from successive process lists (`ps -axo pid,command`): a process under
 * the prefix seen in two polls in a row, other than a `--version` or `--help` ask (the app asks those of every candidate
 * it finds, whichever one it then runs). `seen` carries the pids of the previous poll.
 * @param {string} psOutput @param {string} prefix @param {Set<string>} seen
 */
export function servingProcess(psOutput, prefix, seen) {
  const now = new Set();
  let serving = false;
  for (const line of String(psOutput).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[2].includes(prefix) || /\s--(?:version|help)\s*$/.test(m[2])) continue;
    now.add(m[1]);
    if (seen.has(m[1])) serving = true;
  }
  seen.clear();
  for (const pid of now) seen.add(pid);
  return serving;
}

/**
 * Takes the run lock (a folder made without -p, holding the owner's pid). A lock whose owner is no longer alive (a run
 * killed by a VM restart) is taken over, so one crash does not stop every later run.
 * @param {{ mkdirExclusive: (d: string) => void, readFile: (f: string) => string, writeFile: (f: string, s: string) => void,
 *   rm: (p: string) => void }} fsx
 * @param {string} dir @param {number} pid @param {(pid: number) => boolean} alive
 * @returns {boolean} false while a live run holds it
 */
export function acquireLock(fsx, dir, pid, alive) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fsx.mkdirExclusive(dir);
      fsx.writeFile(path.join(dir, 'owner'), `${pid}\n`);
      return true;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e)?.code !== 'EEXIST') throw e;
    }
    let owner = NaN;
    try {
      owner = Number.parseInt(fsx.readFile(path.join(dir, 'owner')), 10);
    } catch {
      // the owner is between mkdir and writing its pid: treat it as alive
      return false;
    }
    if (Number.isInteger(owner) && alive(owner)) return false;
    fsx.rm(dir);
  }
  return false;
}

/**
 * The guard bench/scratch-chrome.mjs applies to every Chrome a contract instance starts: none without its own
 * --user-data-dir, since the VM's default profile is a real one, signed in and synced, and only the Chrome the run named.
 * MOPILOT_SCRATCH_CHROME_EXTENSION names MoPilot's unpacked extension folder, which the wrapper loads into every
 * Chrome it starts (bench/lib/chromePipe.mjs): Chrome 155 keeps no unpacked extension across starts (#1561).
 * MOPILOT_SCRATCH_CHROME_PAIR=1 has it press Pair on MoPilot's pairing page, as the bench's operator.
 * @param {string[]} args @param {Record<string, string | undefined>} env
 * @returns {{ refuse: string } | { chrome: string, extension: string | null, pair: boolean }}
 */
export function chromeGuard(args, env) {
  if (!args.some((a) => /^--user-data-dir=.+/.test(a)))
    return { refuse: 'refusing to start Chrome without --user-data-dir: the default profile is a real, synced one' };
  if (!env.MOPILOT_SCRATCH_CHROME_REAL) return { refuse: 'MOPILOT_SCRATCH_CHROME_REAL names no Chrome to start' };
  return {
    chrome: env.MOPILOT_SCRATCH_CHROME_REAL,
    extension: env.MOPILOT_SCRATCH_CHROME_EXTENSION || null,
    pair: !!env.MOPILOT_SCRATCH_CHROME_EXTENSION && env.MOPILOT_SCRATCH_CHROME_PAIR === '1',
  };
}

/** The Chrome processes in `after` that were not in `before`: the ones a run started, which its teardown quits. @param {number[]} before @param {number[]} after */
export const newPids = (before, after) => after.filter((p) => !before.includes(p));
