// The command-line arguments of `npm run test:coverage`: test files, `--suite`, `--changed` and `--related` turned into the tests to run.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measuredBy } from './diff-coverage.mjs';
import {
  changedFiles,
  changedPaths,
  discoverTests,
  invariantTestsFor,
  relatedSpecs,
  relatedTests,
  reverseGraph,
} from './related-tests.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const USAGE =
  'Specify focused unit-test files or suites: npm run test:coverage -- [--report-only] [--changed[=<base>]] [--related] [--suite <name>] tests/modelRetry.test.ts';

/**
 * Parse the CLI into test files and options; `--suite` expands to the files and node:test flags in tests/suites.json,
 * and `--related` adds every unit test that reaches a file changed against the `--changed` base (default origin/main),
 * plus global invariant tests and the control regression bundle when app-related paths changed.
 */
export function parseCoverageArgs(
  args,
  repoRoot = root,
  git = (a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 << 20 }),
  { graph = reverseGraph } = {},
) {
  /** @type {{ reportOnly: boolean, changed: string | null, files: string[], timeout: number, skip: string[], specs: string[], nothingToRun?: boolean }} */
  const opts = { reportOnly: false, changed: null, files: [], timeout: 0, skip: [], specs: [] };
  let related = false;
  let suites;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') continue;
    if (arg === '--report-only') opts.reportOnly = true;
    else if (arg === '--related') related = true;
    else if (arg === '--changed') opts.changed = 'origin/main';
    else if (arg.startsWith('--changed=')) opts.changed = arg.slice(10);
    else if (arg === '--suite') {
      suites ??= JSON.parse(readFileSync(path.join(repoRoot, 'tests/suites.json'), 'utf8'));
      const name = args[++i];
      const suite = suites[name];
      if (!suite) throw new Error(`Unknown suite: ${name}. Known suites: ${Object.keys(suites).join(', ')}`);
      // an entry may be a pattern (`tests/controlMatrix*.test.ts`), so a new test in the family needs no entry
      opts.files.push(...suite.tests.flatMap((/** @type {string} */ test) => discoverTests(test, repoRoot)));
      opts.timeout = Math.max(opts.timeout, suite.timeout ?? 0);
      opts.skip.push(...(suite.skip ?? []));
    } else opts.files.push(arg);
  }
  if (related) {
    const base = opts.changed ?? 'origin/main';
    const changed = changedFiles(base, git);
    const users = changed.length ? graph(repoRoot) : new Map();
    const reached = changed.length ? relatedTests(changed, users) : [];
    // release-only, so named for the change to update rather than run (scripts/related-tests.mjs)
    opts.specs = relatedSpecs(changed, users);
    const changedSources = changed.length
      ? changed.filter(measuredBy(JSON.parse(readFileSync(path.join(repoRoot, '.c8rc.json'), 'utf8')), repoRoot))
      : [];
    if (changedSources.length && !reached.length && !opts.files.length) {
      throw new Error(`No unit test reaches the changed files: ${changedSources.join(', ')}`);
    }
    // a stylesheet, a doc or one more Settings row can break them without any import leading there, and so can a deletion
    // scoped by the GUARDS each test declares in the tree being run
    const invariants = invariantTestsFor(changedPaths(base, git, { deleted: true }), (f) => readFileSync(path.join(repoRoot, f), 'utf8'));
    opts.files.push(...reached, ...invariants.filter((file) => existsSync(path.join(repoRoot, file))));
    if (!opts.files.length) return { ...opts, nothingToRun: true };
  }
  opts.files = [...new Set(opts.files)];
  if (!opts.files.length) throw new Error(USAGE);
  for (const file of opts.files) {
    if (!/^(?:tests|web\/tests)\/[^/]+\.test\.ts$/.test(file) || !existsSync(path.join(repoRoot, file))) {
      throw new Error(`Expected an existing top-level unit-test file, got: ${file}`);
    }
  }
  return opts;
}
