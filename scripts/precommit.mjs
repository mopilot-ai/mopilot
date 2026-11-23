// The pre-commit check (.githooks/pre-commit): Biome's format and lint rules on the staged files, the lint ratchet
// on their bug-class warnings, the staged file-growth check, the TypeScript configs when a staged change can affect types, and a header comment on
// every source file when one is staged, and rustfmt and clippy when Rust core files are. Fast enough to
// run on every commit, so agents and people get the same feedback CI would give without spending CI time. Skip
// once with `git commit --no-verify`.
// When typed files have unstaged edits (partial staging, or another agent working in the same tree), the type
// check runs on a checkout of the index, so it judges what is being committed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExceptionsFile, isSource } from './file-size.mjs';
import { startHeavyStep } from './test-slots.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const MAPPED = /^(?:(?:electron|shared|src|scripts|bench|mobile\/src)\/.*\.(?:[cm]?[jt]s|tsx)|core\/.*\.rs)$/s;
// The Rust core's sources and its Cargo configuration, which rustfmt and clippy check.
const CORE = /^core\/(?:.*\.(?:rs|toml)|Cargo\.lock)$/s;
const TYPED = /^(?!web\/)(?:.*\.(?:[cm]?[jt]s|tsx)|(?:.*\/)?tsconfig[^/]*\.json|(?:.*\/)?package\.json)$/s;
// what the PR check's whole-tree type checks also read: web/'s own (`npm run typecheck` there), a JSON module a typed
// file can import (resolveJsonModule; any JSON outside the folders no type check includes, so a new typed folder is
// covered) and a lockfile, which pins the installed type declarations
const TYPE_INPUT = /^(?:web\/.*\.(?:[cm]?[jt]s|tsx)|(?!(?:docs|conformance|lint|deploy|design|designs|core|native|\.github)\/).*\.json)$/s;

/**
 * Whether the PR check's `types` entry has anything to check: a changed or deleted path the root, phone or web type
 * check reads. Git C-quotes unusual paths in changedPaths; an undecoded record conservatively keeps the check.
 * @param {string[]} paths
 */
export const typesChanged = (paths) => paths.some((file) => file.startsWith('"') || TYPED.test(file) || TYPE_INPUT.test(file));
// files whose bug-class warnings the lint ratchet counts, and the configuration that decides them
// a lint-rule fixture a test writes into the source tree while it runs (tests/*Rule*.test.ts): never committed. It can't
// be ignored in .gitignore, since Biome reads that file and would then skip the fixture the test lints (#1507)
const FIXTURE = /(?:^|\/)\.lint-fixture-[^/]+\//;
const RATCHETED = /^(?:(?:electron|shared|src|scripts|mobile)\/.*\.(?:[cm]?[jt]s|tsx|css)|biome\.json|lint\/rules\/[^/]+\.grit)$/s;

/** @typedef {(cmd: string, args: string[], inherit?: boolean) => { status: number | null, stdout?: string }} Run */

/**
 * The commands to run for these staged paths, in order, each with what to do when it fails; empty when nothing
 * staged needs checking. `dirty`: typed files whose working copy differs from the index.
 * @param {string[]} staged
 * @param {string[]} [dirty]
 * @returns {[string, string[], string][]}
 */
export function plan(staged, dirty = []) {
  /** @type {[string, string[], string][]} */
  const steps = [];
  if (staged.some((file) => !file.startsWith('web/'))) {
    steps.push([
      'npx',
      // warnings are the lint ratchet's: it reports only the ones a change adds
      ['biome', 'check', '--staged', '--no-errors-on-unmatched', '--files-ignore-unknown=true', '--diagnostic-level=error'],
      'Format with `npm run format -- <files>`; fix lint errors by hand.',
    ]);
  }
  if (staged.some((file) => RATCHETED.test(file))) {
    steps.push(['node', ['scripts/lint-ratchet.mjs', '--staged'], 'Fix the warnings this change adds (docs/bug-prevention/README.md).']);
  }
  if (staged.some((file) => isSource(file) || isExceptionsFile(file))) {
    steps.push([
      'node',
      ['scripts/file-size.mjs', '--staged'],
      'Split by responsibility or explain a scoped exception (docs/code-quality.md#file-growth).',
    ]);
  }
  if (staged.some((file) => TYPED.test(file))) {
    steps.push(
      dirty.length
        ? ['node', ['scripts/precommit.mjs', '--typecheck-index'], 'Fix the type errors above (paths are in a checkout of the index).']
        : ['npm', ['run', '--silent', 'typecheck'], 'Fix the type errors above.'],
    );
  }
  if (staged.some((file) => CORE.test(file))) {
    steps.push(['node', ['scripts/core-check.mjs'], 'Format and lint the core (docs/architecture/rust-core.md §9).']);
  }
  // every source file says what it owns in its header, which the generated module map lists
  if (staged.some((file) => MAPPED.test(file))) {
    steps.push(['node', ['scripts/module-map.mjs', '--check'], 'Give each file named above a one-line header comment.']);
  }
  return steps;
}

/**
 * @param {{ run?: Run, log?: (message: string) => void, start?: typeof startHeavyStep, env?: Record<string, string | undefined> }} [deps]
 */
export function precommit({ run = defaultRun, log = console.error, start = startHeavyStep, env = process.env } = {}) {
  const listed = run('git', ['diff', '--cached', '--name-status', '-z', '--diff-filter=ACMRTD']);
  if (listed.status !== 0) return listed.status ?? 1;
  const records = (listed.stdout ?? '').split('\0');
  const staged = [];
  const fixtures = [];
  // Git's index owns admission: test cleanup can remove a working file while its staged blob survives.
  // Renames/copies carry two paths; the destination is the changed entry. Keep deletions in the check plan.
  for (let i = 0; i < records.length - 1; ) {
    const status = records[i++];
    const source = records[i++];
    const file = /^[RC]/.test(status) ? records[i++] : source;
    staged.push(file);
    if (status !== 'D' && FIXTURE.test(file)) fixtures.push(file);
  }
  if (fixtures.length) {
    log(
      `pre-commit: ${fixtures.join(', ')} is a test's lint fixture, not source. Unstage it (git restore --staged <path>); a test run writes and removes it.`,
    );
    return 1;
  }
  const lines = (/** @type {string[]} */ args) => (run('git', args).stdout ?? '').split('\0').filter((f) => TYPED.test(f));
  const dirty = [...lines(['diff', '--name-only', '-z']), ...lines(['ls-files', '--others', '--exclude-standard', '-z'])];
  const steps = plan(staged, dirty);
  if (!steps.length) return 0;
  // the checks run inside one slot of the machine's shared budget (test-slots.mjs), below normal priority
  const lease = start(env, { log });
  try {
    for (const [cmd, args, fix] of steps) {
      const result = run(cmd, args, true);
      if (result.status !== 0) {
        log(`pre-commit: \`${cmd} ${args.join(' ')}\` failed. ${fix} Skip once with --no-verify.`);
        return result.status ?? 1;
      }
    }
    return 0;
  } finally {
    lease.release();
  }
}

/**
 * The TypeScript configs against a checkout of the index (with this tree's node_modules), not the working tree.
 * @param {{ run?: Run, repoRoot?: string }} [deps]
 */
export function typecheckIndex({ run = defaultRun, repoRoot = root } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'precommit-index-'));
  try {
    const out = run('git', ['checkout-index', '--all', `--prefix=${dir}/`]);
    if (out.status !== 0) return out.status ?? 1;
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'));
    const catalogScript = path.join(dir, 'scripts/harness-catalog.mjs');
    if (existsSync(catalogScript)) {
      const generated = run('node', [catalogScript, dir], true);
      if (generated.status !== 0) return generated.status ?? 1;
    }
    const configs = ['tsconfig.json', 'tsconfig.node.json'];
    if (existsSync(path.join(dir, 'mobile/tsconfig.json'))) {
      symlinkSync(path.join(repoRoot, 'mobile/node_modules'), path.join(dir, 'mobile/node_modules'));
      configs.push('mobile/tsconfig.json');
    }
    for (const config of configs) {
      const result = run('npx', ['tsc', '--noEmit', '-p', path.join(dir, config)], true);
      if (result.status !== 0) return result.status ?? 1;
    }
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @type {Run} */
export function defaultRun(cmd, args, inherit = false) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 1 << 28 });
}

/** Type-check the phone only when this checkout contains its independent project.
 * @param {{ run?: Run, repoRoot?: string }} [deps]
 */
export function mobileTypecheck({ run = defaultRun, repoRoot = root } = {}) {
  const config = path.join(repoRoot, 'mobile/tsconfig.json');
  if (!existsSync(config)) return 0;
  return run('npx', ['tsc', '--noEmit', '-p', config], true).status ?? 1;
}

/**
 * The hook (no arguments), or a selected type-check step.
 * @param {string[]} argv
 * @param {{ run?: Run, log?: (message: string) => void, repoRoot?: string }} [deps]
 */
export function cli(argv, deps = {}) {
  if (argv.includes('--typecheck-index')) return typecheckIndex(deps);
  if (argv.includes('--typecheck-mobile')) return mobileTypecheck(deps);
  return precommit(deps);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = cli(process.argv.slice(2));
}
