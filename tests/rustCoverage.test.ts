// scripts/rust-coverage.mjs: the Rust core's lcov read as c8's per-file entries (lines, functions, branches), each OS's
// report of a file merged, the core's paths and changes told apart, and its coverage run started on the pinned nightly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NIGHTLY,
  parseEnv,
  changedCoreLcov,
  coreChanges,
  isCoreChange,
  isCoreSource,
  lcovToCoverage,
  mergeLcov,
  runRustCoverage,
} from '../scripts/rust-coverage.mjs';
import { runScript } from './support/scripts-shared-cli.ts';

const ROOT = '/repo';
const LIB = path.join(ROOT, 'core/crates/proc/src/lib.rs');

const mac = `SF:/Users/runner/work/x/core/crates/proc/src/lib.rs
FN:3,table
FN:9,12,descendants
FNDA:1,table
FNDA:0,descendants
DA:3,1
DA:4,0
BRDA:4,0,0,1
BRDA:4,0,1,-
end_of_record
`;
const linux = `SF:/home/runner/work/x/core/crates/proc/src/lib.rs
FN:9,12,descendants
FNDA:2,descendants
DA:4,3
DA:20,1
BRDA:4,0,1,1
end_of_record
`;

test('an lcov report reads as c8 entries keyed under this checkout, whatever the runner checked out to', () => {
  const coverage = lcovToCoverage(mac, ROOT);
  assert.deepEqual(Object.keys(coverage), [LIB]);
  const lib = coverage[LIB];
  assert.equal(lib.path, LIB);
  assert.deepEqual(lib.s, { 3: 1, 4: 0 });
  assert.deepEqual(lib.statementMap[4], { start: { line: 4, column: 0 }, end: { line: 4, column: 0 } });
  // both FN forms: the start line alone, and start and end
  assert.deepEqual(
    Object.values(lib.fnMap).map((fn: any) => [fn.name, fn.loc.start.line, fn.loc.end.line]),
    [
      ['table', 3, 3],
      ['descendants', 9, 12],
    ],
  );
  assert.deepEqual(Object.values(lib.f), [1, 0]);
  // a branch never reached ("-") counts as not taken
  assert.deepEqual(Object.values(lib.b), [[1, 0]]);
  assert.equal(lib.branchMap[0].locations.length, 2);
});

test("each OS's report of one file adds up: lines, functions and branches", () => {
  const base = { '/repo/src/a.ts': { path: '/repo/src/a.ts' } };
  const merged = mergeLcov(base, [mac, linux], ROOT);
  assert.deepEqual(merged['/repo/src/a.ts'], base['/repo/src/a.ts'], "c8's entries are kept");
  const lib = merged[LIB];
  assert.deepEqual(lib.s, { 3: 1, 4: 3, 20: 1 });
  assert.deepEqual(Object.values(lib.f), [1, 2]);
  assert.deepEqual(Object.values(lib.b), [[1, 1]]);
  assert.deepEqual(mergeLcov(base, [], ROOT), base);
});

test('a source outside core/ keeps its own path, and lines outside a record are skipped', () => {
  const coverage = lcovToCoverage('DA:1,1\nFNDA:1,orphan\nSF:/elsewhere/x.rs\nFNDA:1,unknown\nDA:1,1\nend_of_record\n', ROOT);
  assert.deepEqual(Object.keys(coverage), ['/elsewhere/x.rs']);
  assert.deepEqual(coverage['/elsewhere/x.rs'].s, { 1: 1 });
  assert.deepEqual(coverage['/elsewhere/x.rs'].f, {});
});

test("the core's sources and changes are told from everything else", () => {
  assert.equal(isCoreSource('core/crates/proc/src/lib.rs'), true);
  assert.equal(isCoreSource('core/crates/proc/tests/table.rs'), true);
  assert.equal(isCoreSource('core/crates/proc/build.rs'), false);
  assert.equal(isCoreSource('core/target/debug/build/x.rs'), false);
  assert.equal(isCoreSource('src/lib.rs'), false);
  assert.equal(isCoreChange('core/Cargo.lock'), true);
  assert.equal(isCoreChange('core/target/debug/x'), false);
  assert.equal(isCoreChange('docs/core/a.md'), false);
});

test('the changes under core/ since the merge base include untracked files', () => {
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'merge-base') return 'mb\n';
    if (args[0] === 'diff') return 'core/Cargo.toml\nsrc/a.ts\n\n';
    return 'core/crates/x/src/lib.rs\ncore/target/y\n';
  };
  assert.deepEqual(coreChanges('origin/main', git), ['core/Cargo.toml', 'core/crates/x/src/lib.rs']);
  assert.deepEqual(calls[0], ['merge-base', 'origin/main', 'HEAD']);
  assert.deepEqual(calls[1], ['diff', '--name-only', '--no-renames', 'mb']);
});

test("show-env's exports read as an environment", () => {
  assert.deepEqual(parseEnv('export A=\'1\'\nexport B="two words"\nexport C=3\nnot an export\n'), { A: '1', B: 'two words', C: '3' });
});

test('the coverage run: Rust tests and the binding tests against an instrumented addon, on the pinned nightly, in one report', (t) => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'rust-coverage-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const core = path.join(repoRoot, 'core');
  const env = { LLVM_PROFILE_FILE: '/t/core-%p.profraw', CARGO_LLVM_COV_TARGET_DIR: '/t' };
  const read = (cmd: string, args: string[], cwd: string) => {
    assert.deepEqual([cmd, args, cwd], ['cargo', [`+${NIGHTLY}`, 'llvm-cov', 'show-env', '--branch', '--export-prefix'], core]);
    return "export LLVM_PROFILE_FILE='/t/core-%p.profraw'\nexport CARGO_LLVM_COV_TARGET_DIR='/t'\n";
  };
  const calls: any[] = [];
  const run = (cmd: string, args: string[], cwd: string, stepEnv?: Record<string, string>) => (
    calls.push([cmd, args, cwd, stepEnv]), { status: 0 }
  );
  const tests = ['tests/coreBindingA.test.ts'];
  assert.equal(runRustCoverage('coverage/rust/x.lcov', { run, read, repoRoot, platform: 'linux', tests }), 0);
  assert.deepEqual(calls, [
    ['cargo', [`+${NIGHTLY}`, 'llvm-cov', 'clean', '--workspace'], core, env],
    ['cargo', [`+${NIGHTLY}`, 'test'], core, env],
    ['cargo', [`+${NIGHTLY}`, 'build', '-p', 'node', '--features', 'test-routes'], core, env],
    [process.execPath, ['scripts/harness-catalog.mjs'], repoRoot, env],
    [
      process.execPath,
      ['scripts/test-slots.mjs', '--test', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', ...tests],
      repoRoot,
      { ...env, MOPILOT_CORE: path.join('/t', 'debug', 'libmopilot_core.so'), MOPILOT_CORE_REQUIRED: '1' },
    ],
    [
      'cargo',
      [`+${NIGHTLY}`, 'llvm-cov', 'report', '--branch', '--lcov', '--output-path', path.join(repoRoot, 'coverage/rust/x.lcov')],
      core,
      env,
    ],
  ]);
  // the binding tests are found by name; the build lands in core/target without a target dir
  calls.length = 0;
  const bare = () => "export LLVM_PROFILE_FILE='x'\n";
  assert.equal(runRustCoverage('x.lcov', { run, read: bare, repoRoot: process.cwd(), platform: 'darwin' }), 0);
  const binding = (calls as any[])[4];
  assert.ok(binding[1].includes(path.join('tests', 'coreBinding.test.ts')));
  assert.equal(binding[3].MOPILOT_CORE, path.join(process.cwd(), 'core', 'target', 'debug', 'libmopilot_core.dylib'));
  // the first failing step stops the run with its status
  const errors: string[] = [];
  const original = console.error;
  console.error = (m: string) => errors.push(m);
  try {
    let n = 0;
    assert.equal(runRustCoverage('x.lcov', { run: () => (n++ === 1 ? { status: 101 } : { status: 0 }), read, repoRoot, tests }), 101);
    assert.equal(n, 2);
    assert.equal(
      runRustCoverage('x.lcov', { run: () => ({ status: null, error: new Error('spawn node ENOENT') }), read, repoRoot, tests }),
      1,
    );
    const missing = () => {
      throw new Error('no such command: llvm-cov');
    };
    assert.equal(runRustCoverage('x.lcov', { run, read: missing, repoRoot, tests }), 1);
  } finally {
    console.error = original;
  }
  assert.match(errors[0], /`cargo \+nightly-[\d-]+ test` failed\./);
  assert.match(errors[1], /`cargo \+nightly-[\d-]+ llvm-cov clean --workspace` failed \(spawn node ENOENT\)\./);
  assert.match(
    errors[2],
    /cargo llvm-cov did not start \(no such command: llvm-cov\)\. Install rustup, then `rustup toolchain install nightly-/,
  );
});

test('the real runner starts each step; one that cannot start (here: no core/ to run in) stops the run', (t) => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'rust-coverage-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const errors: string[] = [];
  const original = console.error;
  console.error = (m: string) => errors.push(m);
  try {
    assert.equal(runRustCoverage('x.lcov', { read: () => '', repoRoot, tests: [] }), 1);
  } finally {
    console.error = original;
  }
  assert.match(errors[0], /llvm-cov clean --workspace` failed \(spawnSync cargo ENOENT\)\./);
});

test('a change to core/ gets its lcov; another change gets none, and a failed run its status', (t) => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'rust-coverage-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const touching = (files: string) => (args: string[]) => (args[0] === 'diff' ? files : '');
  // the report step writes the lcov; the others do their work elsewhere
  const write = (_cmd: string, args: string[]) => {
    if (args.includes('--output-path')) writeFileSync(args[args.length - 1], mac);
    return { status: 0 };
  };
  const read = () => '';
  const tests: string[] = [];
  assert.equal(changedCoreLcov('main', touching('src/a.ts\n'), repoRoot, { run: write, read, repoRoot, tests }), null);
  assert.equal(changedCoreLcov('main', touching('core/Cargo.toml\n'), repoRoot, { run: write, read, repoRoot, tests }), mac);
  assert.equal(readFileSync(path.join(repoRoot, 'rust.lcov'), 'utf8'), mac);
  assert.equal(changedCoreLcov('main', touching('core/Cargo.toml\n'), repoRoot, { run: () => ({ status: 3 }), read, repoRoot, tests }), 3);
});

test('the command runs the real cargo: without one on PATH it says how to install it; without --out it shows its usage', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rust-coverage-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const noCargo = { PATH: '/usr/bin:/bin' };
  const run = runScript('scripts/rust-coverage.mjs', ['--out', path.join(dir, 'x.lcov')], noCargo);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /rust-coverage: cargo llvm-cov did not start/);
  const usage = runScript('scripts/rust-coverage.mjs', [], noCargo);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^Usage: node scripts\/rust-coverage\.mjs --out <file\.lcov>/);
});
