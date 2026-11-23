// `npm run test:coverage`: runs the unit tests under V8 coverage, drops node:test mock stand-ins and writes the c8 report.

import { parseCoverageArgs } from './focused-unit-coverage.mjs';
import { checkChanged } from './diff-coverage.mjs';
import { changedCoreLcov, mergeLcov } from './rust-coverage.mjs';
import { packRaw } from './raw-coverage.mjs';
import { rawCoverageRun } from './coverage-artifacts.mjs';
import { specsNote } from './related-tests.mjs';
import { CI_TEST_TIMEOUT_MS, EXIT_WITH_PARENT, WASM_CODE_GC_GUARD, startHeavyStep, startTestRun, testConcurrency } from './test-slots.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// node:test's mock.module loads a generated stand-in at `<module url>?node-test-mock=N`. c8 maps it
// back onto the real file, where its never-taken guard would count as an uncovered branch.
const MOCK_SCRIPT = '?node-test-mock=';

export { testConcurrency };

/**
 * Every top-level unit-test file; conformance, E2E and other release suites live in subdirectories. A checkout
 * without the web app (the open-source edition) has no web/tests.
 */
export function allUnitTests(repoRoot = root) {
  return ['tests', 'web/tests'].flatMap((dir) =>
    (existsSync(path.join(repoRoot, dir)) ? readdirSync(path.join(repoRoot, dir)) : [])
      .filter((f) => f.endsWith('.test.ts'))
      .sort()
      .map((f) => `${dir}/${f}`),
  );
}

/** Separate a directory option (`--reports-dir`, `--raw-out`) from test-selection arguments before either parser consumes them. */
function directoryArg(args, option = '--reports-dir') {
  const at = args.indexOf(option);
  if (at >= 0 && !args[at + 1]) throw new Error(`${option} needs a directory.`);
  return {
    directory: at >= 0 ? args[at + 1] : null,
    rest: at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args,
  };
}

/** The c8 report over the raw coverage in `tempDir`, written to `reportsDir`; measured only, or held to .c8rc.json's thresholds. */
export function reportArgs(repoRoot, reportsDir, tempDir, reportOnly, html = false) {
  return [
    path.join(repoRoot, 'node_modules/c8/bin/c8.js'),
    'report',
    '--config',
    path.join(repoRoot, '.c8rc.json'),
    '--reports-dir',
    reportsDir,
    '--temp-directory',
    tempDir,
    ...['text-summary', 'json', 'json-summary', ...(html ? ['html'] : [])].flatMap((name) => ['--reporter', name]),
    // merge the raw files one at a time: the whole suite's data does not fit in a small heap
    '--merge-async',
    ...(reportOnly ? ['--check-coverage=false'] : []),
  ];
}

const SETUPS = { tests: 'tests/support/register.ts', web: 'web/tests/setup.ts' };

/**
 * The loaders to import (`--setup=tests,web`), or null for the files to decide. Both compile .tsx, and the last one
 * imported wins, so CI shards of one run name that run's set: c8 can merge only coverage of the same compiled code.
 */
function setupArg(args) {
  const arg = args.find((a) => a.startsWith('--setup='));
  if (!arg) return { setups: null, rest: args };
  const setups = arg.slice('--setup='.length).split(',');
  if (!setups.every((name) => Object.hasOwn(SETUPS, name))) throw new Error(`--setup takes tests and/or web, got ${arg}.`);
  return { setups, rest: args.filter((a) => a !== arg) };
}

/**
 * The test run, and the c8 report that follows it, for the given command-line arguments; `concurrency` null leaves
 * the number of files at a time to node (main passes the run's leased share instead).
 */
export function coveragePlan(args, repoRoot = root, env = process.env, concurrency = testConcurrency(env)) {
  const { directory, rest: selection } = directoryArg(args);
  const { setups, rest } = setupArg(selection);
  const reportsDir = directory ? path.resolve(repoRoot, directory) : path.join(repoRoot, 'coverage/unit');
  const reportOnly = rest.includes('--report-only');
  const all = rest.includes('--all');
  const named = rest.filter((arg) => !['--report-only', '--all', '--html', '--'].includes(arg));
  if (all && named.length) throw new Error('--all runs every unit-test file; do not also name files.');
  const files = all ? allUnitTests(repoRoot) : named;
  if (!files.length)
    throw new Error(
      'Specify focused unit-test files: npm run test:coverage -- tests/modelRetry.test.ts (add --report-only to measure without enforcing 100%, or use --all for every unit test).',
    );
  for (const file of files) {
    if (!/^(?:tests|web\/tests)\/[^/]+\.test\.ts$/.test(file) || !existsSync(path.join(repoRoot, file))) {
      throw new Error(`Expected an existing top-level unit-test file, got: ${file}`);
    }
  }
  const tempDir = path.join(reportsDir, 'tmp');
  return {
    reportsDir,
    tempDir,
    test: [
      // Maglev (V8's mid-tier compiler) crashes Node 24 with SIGSEGV under CPU contention, which a run of many files
      // causes (nodejs/node#64841); the test files' processes inherit this V8 flag
      '--no-maglev',
      ...WASM_CODE_GC_GUARD,
      // a killed coverage command takes its tests with it, instead of leaving them writing raw coverage
      ...EXIT_WITH_PARENT,
      '--test',
      `--test-global-setup=${path.join(repoRoot, 'scripts/test-global-setup.mjs')}`,
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--experimental-test-module-mocks',
      // a test that hangs fails instead of holding up the whole run
      `--test-timeout=${CI_TEST_TIMEOUT_MS}`,
      // bounds memory on a busy machine (testConcurrency)
      ...(concurrency ? [`--test-concurrency=${concurrency}`] : []),
      // the usual report, and why a file failed outside its tests (a crash, or work that outlived a test)
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      `--test-reporter=${path.join(repoRoot, 'scripts/test-file-failures.mjs')}`,
      '--test-reporter-destination=stderr',
      ...Object.entries(SETUPS).flatMap(([name, setup]) =>
        (setups ? setups.includes(name) : files.some((file) => file.startsWith(name === 'web' ? 'web/' : 'tests/')))
          ? ['--import', path.join(repoRoot, setup)]
          : [],
      ),
      ...files,
    ],
    report: reportArgs(repoRoot, reportsDir, tempDir, reportOnly, rest.includes('--html')),
  };
}

/** A file URL without its query: a module a test imports fresh (`x.ts?case=1`) is still `x.ts`. */
const bare = (url) => (url.startsWith('file:') ? url.replace(/[?#].*$/, '') : url);

/**
 * Clean raw V8 coverage files: drop mock.module stand-in scripts, and count copies of a module loaded
 * under a query string as that module, so c8 merges them instead of reporting their branches apart.
 */
export function stripMockScripts(dir) {
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const file = path.join(dir, name);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.result = data.result.filter((script) => !script.url.includes(MOCK_SCRIPT)).map((script) => ({ ...script, url: bare(script.url) }));
    const maps = data['source-map-cache'];
    if (maps)
      data['source-map-cache'] = Object.fromEntries(
        Object.entries(maps)
          .filter(([url]) => !url.includes(MOCK_SCRIPT))
          .map(([url, map]) => [bare(url), map]),
      );
    writeFileSync(file, JSON.stringify(data));
  }
}

/** Run `work` inside `lease`, freeing it however `work` ends. */
const within = (lease, work) => {
  try {
    return work(lease);
  } finally {
    lease.release();
  }
};

/**
 * The coverage command, each phase inside the machine's shared budget (test-slots.mjs) at the size it needs: choosing
 * the related files, then the c8 report and changed-line check, in one slot each; the tests in the run's share. A
 * dozen runs choosing or reporting outside the budget at once still overloaded the machine after the tests themselves
 * were leased (#2340), and holding the whole share through a one-core report starved the other runs.
 * @param {{ env?: Record<string, string | undefined>, start?: typeof startTestRun, heavy?: typeof startHeavyStep, cargo?: Parameters<typeof changedCoreLcov>[3], rawRun?: typeof rawCoverageRun }} host
 */
export function main(args, spawn = spawnSync, repoRoot = root, host = {}) {
  const { env = process.env, start = startTestRun, heavy = startHeavyStep, cargo, rawRun = rawCoverageRun } = host;
  const prepared = within(heavy(env), () => prepare(args, repoRoot, env, cargo, rawRun));
  if (typeof prepared === 'number') return prepared;
  const { plan } = prepared;
  const run = (argv, runEnv) => {
    const result = spawn(process.execPath, argv, { cwd: repoRoot, stdio: 'inherit', env: runEnv });
    if (result.error) throw result.error;
    return result.status ?? 1;
  };
  // the raw traces are removed only by a run that completed with its final report in place; a failed or throwing run keeps them as evidence
  let status = 1;
  try {
    const tests = within(start(env), (lease) => {
      if (lease.workers) plan.test.splice(1, 0, `--test-concurrency=${lease.workers}`);
      return run(plan.test, { ...process.env, ...lease.env, NODE_V8_COVERAGE: plan.tempDir });
    });
    status = within(heavy(env), () => report(prepared, tests, run, repoRoot, cargo));
    return status;
  } finally {
    // a packed shard has its raw copy in --raw-out and no report; any other run needs its report newer than the traces
    prepared.artifacts.finish({
      ok: status === 0,
      final: prepared.rawDirectory ? undefined : path.join(plan.reportsDir, 'coverage-final.json'),
    });
  }
}

/** The files to run and the plan to run them by, or the exit status when there is nothing to run. */
function prepare(args, repoRoot, env, cargo, rawRun) {
  const html = args.includes('--html');
  const keep = args.includes('--keep-raw');
  args = args.filter((arg) => arg !== '--html' && arg !== '--keep-raw');
  // a CI test shard's raw coverage, packed for the job that merges every shard's into one report (scripts/test-shards.mjs)
  const raw = directoryArg(args, '--raw-out');
  const setup = raw.rest.filter((a) => a.startsWith('--setup='));
  const { directory, rest } = directoryArg(raw.rest.filter((a) => !a.startsWith('--setup=')));
  const focused =
    rest.includes('--suite') || rest.includes('--related') || rest.some((arg) => arg === '--changed' || arg.startsWith('--changed='))
      ? parseCoverageArgs(rest, repoRoot)
      : null;
  const note = specsNote(focused?.specs ?? []);
  if (note) console.log(note);
  if (focused?.nothingToRun) {
    // a change only to the Rust core runs no JS test, but its own tests and changed-line check still run
    if (focused.changed) {
      const rust = rustCheck(focused.changed, {}, repoRoot, cargo);
      if (rust !== null) return rust;
    }
    console.log(`No unit test applies to the changes since ${focused.changed ?? 'origin/main'}; none to run.`);
    return 0;
  }
  const plan = coveragePlan(
    focused
      ? [
          ...(focused.reportOnly || focused.changed ? ['--report-only'] : []),
          ...focused.files,
          ...(directory ? ['--reports-dir', directory] : []),
          ...setup,
          ...(html ? ['--html'] : []),
        ]
      : [...raw.rest, ...(html ? ['--html'] : [])],
    repoRoot,
    env,
    null,
  );
  if (focused?.timeout) plan.test[plan.test.indexOf(`--test-timeout=${CI_TEST_TIMEOUT_MS}`)] = `--test-timeout=${focused.timeout}`;
  for (const pattern of focused?.skip ?? []) plan.test.splice(1, 0, `--test-skip-pattern=${pattern}`);
  const artifacts = rawRun(plan.reportsDir, { keep });
  plan.report[plan.report.indexOf('--temp-directory') + 1] = artifacts.tempDir;
  plan.tempDir = artifacts.tempDir;
  return { plan, focused, rawDirectory: raw.directory, artifacts };
}

/** Pack a CI shard's raw coverage, or report it and check the changed lines. */
function report({ plan, focused, rawDirectory }, tests, run, repoRoot, cargo) {
  stripMockScripts(plan.tempDir);
  if (rawDirectory) {
    console.log(`Packed ${packRaw(plan.tempDir, path.resolve(repoRoot, rawDirectory), repoRoot)} raw coverage files into ${rawDirectory}.`);
    return tests;
  }
  const reported = run(plan.report, process.env);
  if (tests || reported || !focused?.changed) return tests || reported;
  const coverage = JSON.parse(readFileSync(path.join(plan.reportsDir, 'coverage-final.json'), 'utf8'));
  return rustCheck(focused.changed, coverage, repoRoot, cargo, plan.reportsDir) ?? checkChangedHere(focused.changed, coverage, repoRoot);
}

const gitIn = (/** @type {string} */ repoRoot) => (/** @type {string[]} */ argv) =>
  execFileSync('git', argv, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 });
const checkChangedHere = (/** @type {string} */ base, /** @type {Record<string, any>} */ coverage, /** @type {string} */ repoRoot) =>
  checkChanged({ base, coverage, git: gitIn(repoRoot), repoRoot });

/**
 * The changed-line check with the Rust core's coverage merged in, for a change that touches core/ (scripts/rust-coverage.mjs);
 * null when it doesn't. Its lcov goes in `dir`.
 */
function rustCheck(base, coverage, repoRoot, cargo, dir = path.join(repoRoot, 'coverage/unit')) {
  const lcov = changedCoreLcov(base, gitIn(repoRoot), dir, { ...cargo, repoRoot });
  if (lcov === null) return null;
  if (typeof lcov === 'number') return lcov;
  return checkChangedHere(base, mergeLcov(coverage, [lcov], repoRoot), repoRoot);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
