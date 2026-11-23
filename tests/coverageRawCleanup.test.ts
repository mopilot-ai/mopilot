// Raw coverage is a run's scratch: a completed run removes its verified traces, a failed or interrupted one keeps them as evidence for a while, and ambiguous ownership is never pruned.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  listWorktrees,
  PRESERVED_MS,
  PRESERVED_RUNS,
  processAlive,
  pruneRawRuns,
  rawCoverageRun,
  SIBLING_PRESERVED_MS,
  SIBLING_PRESERVED_RUNS,
  siblingRawParents,
} from '../scripts/coverage-artifacts.mjs';

function reportsDir(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'coverage-raw-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'coverage/unit');
}

const trace = (dir: string, name = 'coverage-1.json') => {
  writeFileSync(path.join(dir, name), JSON.stringify({ result: [] }));
  return path.join(dir, name);
};

const done = { ok: true };

test('a completed run removes only its verified raw traces, more than once, and keeps the final report', (t) => {
  const reports = reportsDir(t);
  mkdirSync(reports, { recursive: true });
  const final = path.join(reports, 'coverage-final.json');
  for (let i = 0; i < 3; i++) {
    const logs: string[] = [];
    const run = rawCoverageRun(reports, { pid: 4242, alive: () => true, log: (line: string) => logs.push(line) });
    assert.match(path.basename(run.tempDir), /^run-4242-/);
    const raw = trace(run.tempDir);
    utimesSync(raw, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    writeFileSync(final, '{}');
    run.finish({ ...done, final });
    assert.equal(existsSync(run.tempDir), false);
    assert.ok(existsSync(final), 'the final report stays');
    assert.deepEqual(logs, []);
  }
});

test('a failed, thrown or killed run keeps its traces as evidence', (t) => {
  const reports = reportsDir(t);
  const logs: string[] = [];
  for (const outcome of [undefined, { ok: false }]) {
    const run = rawCoverageRun(reports, { pid: 9, alive: () => true, log: (line: string) => logs.push(line) });
    const raw = trace(run.tempDir);
    run.finish(outcome);
    assert.ok(existsSync(raw));
  }
  assert.equal(logs.length, 2);
  assert.match(logs[0], /Kept the raw coverage of an incomplete run in .*run-9-/);
});

test('a completed run keeps its traces when the final report is missing or older, and removes nothing it cannot verify', (t) => {
  const reports = reportsDir(t);
  mkdirSync(reports, { recursive: true });
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const missing = rawCoverageRun(reports, { pid: 1, alive: () => true, log });
  const raw = trace(missing.tempDir);
  missing.finish({ ok: true, final: path.join(reports, 'coverage-final.json') });
  assert.ok(existsSync(raw), 'no report yet: the traces are the only evidence');
  assert.match(logs.at(-1) ?? '', /final report .* missing or older/);
  const final = path.join(reports, 'coverage-final.json');
  writeFileSync(final, '{}');
  utimesSync(final, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  missing.finish({ ok: true, final });
  assert.ok(existsSync(raw), 'a report older than the traces does not prove they were reported');
  // an unrelated file, and a .json that is not a raw trace, stay; the folder stays with them
  const other = rawCoverageRun(reports, { pid: 2, alive: () => true, log });
  const rawTwo = trace(other.tempDir);
  writeFileSync(path.join(other.tempDir, 'notes.json'), '{"result":42}');
  writeFileSync(path.join(other.tempDir, 'mine.txt'), 'keep');
  other.finish({ ok: true });
  assert.equal(existsSync(rawTwo), false, 'the verified trace goes');
  assert.deepEqual(readdirSync(other.tempDir).sort(), ['mine.txt', 'notes.json']);
  assert.match(logs.at(-1) ?? '', /^Could not remove raw coverage .*ENOTEMPTY|not empty/i);
});

test('--keep-raw keeps the traces and says until when; the next run removes them once their process is gone', (t) => {
  const reports = reportsDir(t);
  const logs: string[] = [];
  const kept = rawCoverageRun(reports, { keep: true, pid: 7, alive: () => true, log: (line: string) => logs.push(line) });
  const raw = trace(kept.tempDir);
  kept.finish(done);
  assert.ok(existsSync(raw));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Kept raw coverage in .*run-7-.*--keep-raw.*next run/);
  const next = rawCoverageRun(reports, { pid: 8, alive: (pid: number) => pid === 8 });
  assert.equal(existsSync(kept.tempDir), false);
  assert.deepEqual(readdirSync(path.join(reports, 'tmp')), [path.basename(next.tempDir)]);
});

test('pruning keeps live runs, ambiguous pid-less folders, loose traces and other files', (t) => {
  const parent = path.join(reportsDir(t), 'tmp');
  mkdirSync(parent, { recursive: true });
  for (const name of ['run-11-aaaaaa', 'run-cccccc']) {
    mkdirSync(path.join(parent, name));
    trace(path.join(parent, name));
  }
  trace(parent, 'coverage-loose.json');
  writeFileSync(path.join(parent, 'notes.txt'), 'mine');
  mkdirSync(path.join(parent, 'scratch'));
  const asked: number[] = [];
  pruneRawRuns(parent, {
    alive: (pid: number) => {
      asked.push(pid);
      return pid === 11;
    },
  });
  // an older session may still write to a pid-less folder or a loose trace: nothing proves otherwise
  assert.deepEqual(readdirSync(parent).sort(), ['coverage-loose.json', 'notes.txt', 'run-11-aaaaaa', 'run-cccccc', 'scratch']);
  assert.deepEqual(asked, [11]);
});

test('dead failed runs are kept as evidence: the newest few that are under a day old, never more', (t) => {
  const parent = path.join(reportsDir(t), 'tmp');
  mkdirSync(parent, { recursive: true });
  const now = Date.now();
  const make = (name: string, ageMs: number, kept = false) => {
    const dir = path.join(parent, name);
    mkdirSync(dir);
    trace(dir);
    if (kept) writeFileSync(path.join(dir, '.kept'), '');
    utimesSync(dir, new Date(now - ageMs), new Date(now - ageMs));
  };
  make('run-21-newest', 1000);
  make('run-22-newer', 2000);
  make('run-23-third', 3000);
  make('run-24-old', PRESERVED_MS + 1000);
  make('run-25-asked', 500, true);
  pruneRawRuns(parent, { alive: () => false, now: () => now });
  assert.equal(PRESERVED_RUNS, 2);
  assert.deepEqual(readdirSync(parent).sort(), ['run-21-newest', 'run-22-newer']);
});

test('pruning a missing folder does nothing, an entry that vanishes is skipped, and a folder it cannot remove is logged', (t) => {
  const reports = reportsDir(t);
  pruneRawRuns(path.join(reports, 'missing'));
  const parent = path.join(reports, 'tmp');
  mkdirSync(path.join(parent, 'run-1-dead'), { recursive: true });
  writeFileSync(path.join(parent, 'run-2-file'), 'not a folder'); // still stat-able: a file named like a run
  symlinkSync(path.join(parent, 'nowhere'), path.join(parent, 'run-3-dangling')); // listed, but gone when stat'ed
  const logs: string[] = [];
  const failing = (() => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  }) as never;
  // out of the keep-few window: both are old
  const old = new Date(Date.now() - PRESERVED_MS - 5000);
  utimesSync(path.join(parent, 'run-1-dead'), old, old);
  pruneRawRuns(parent, { alive: (pid: number) => pid === 2, log: (line: string) => logs.push(line), remove: failing });
  assert.deepEqual(logs, [`Could not remove old raw coverage ${path.join(parent, 'run-1-dead')}: EACCES: permission denied`]);
  const run = rawCoverageRun(reports, { alive: () => true, log: (line: string) => logs.push(line), remove: failing });
  trace(run.tempDir);
  run.finish({ ok: true });
  assert.match(logs.at(-1) ?? '', /^Could not remove raw coverage .*EACCES/);
});

test('a process is alive when signal 0 reaches it or it belongs to another user, and dead otherwise', () => {
  assert.equal(processAlive(process.pid), true);
  const failing = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(processAlive(1, failing('EPERM') as never), true);
  assert.equal(processAlive(1, failing('ESRCH') as never), false);
  assert.equal(processAlive(1, (() => true) as never), true);
});

const deadRun = (parent: string, name: string, ageMs: number, now: number) => {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  trace(dir);
  utimesSync(dir, new Date(now - ageMs), new Date(now - ageMs));
};

test("a run prunes sibling worktrees' dead runs to the newest one under an hour, and keeps its own day of evidence", (t) => {
  const reports = reportsDir(t);
  const own = path.join(reports, 'tmp');
  const sibling = path.join(path.dirname(path.dirname(reports)), 'other/coverage/unit/tmp');
  const now = Date.now();
  deadRun(own, 'run-31-newest', 60_000, now);
  deadRun(own, 'run-33-old', SIBLING_PRESERVED_MS + 1000, now);
  deadRun(sibling, 'run-31-newest', 60_000, now);
  deadRun(sibling, 'run-32-newer', 120_000, now);
  deadRun(sibling, 'run-33-old', SIBLING_PRESERVED_MS + 1000, now);
  deadRun(sibling, 'run-34-live', SIBLING_PRESERVED_MS * 3, now);
  deadRun(sibling, 'run-35-kept-recent', 30_000, now);
  writeFileSync(path.join(sibling, 'run-35-kept-recent', '.kept'), '');
  deadRun(sibling, 'run-36-kept-old', SIBLING_PRESERVED_MS + 1000, now);
  writeFileSync(path.join(sibling, 'run-36-kept-old', '.kept'), '');
  for (const name of ['run-35-kept-recent', 'run-36-kept-old']) {
    const at = name.endsWith('recent') ? 30_000 : SIBLING_PRESERVED_MS + 1000;
    utimesSync(path.join(sibling, name), new Date(now - at), new Date(now - at));
  }
  const seen: string[] = [];
  const run = rawCoverageRun(reports, {
    pid: 30,
    alive: (pid: number) => pid === 30 || pid === 34,
    now: () => now,
    siblings: (parent: string) => {
      seen.push(parent);
      return [sibling];
    },
  });
  assert.deepEqual(seen, [own]);
  assert.equal(SIBLING_PRESERVED_RUNS, 1);
  assert.deepEqual(readdirSync(own).sort(), [path.basename(run.tempDir), 'run-31-newest', 'run-33-old'].sort());
  // a live sibling run is never touched; a fresh --keep-raw folder neither counts nor goes until its hour is up
  assert.deepEqual(readdirSync(sibling).sort(), ['run-31-newest', 'run-34-live', 'run-35-kept-recent']);
});

test("sibling raw folders are every other worktree's coverage/<name>/tmp, never the run's own, even through a symlink", (t) => {
  const root = path.dirname(path.dirname(reportsDir(t)));
  const wt = (name: string) => path.join(root, name);
  for (const dir of ['main/coverage/unit/tmp', 'a/coverage/unit/tmp', 'a/coverage/e2e/tmp', 'b/coverage/notmp', 'c']) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileSync(path.join(root, 'a/coverage/file'), 'not a folder');
  symlinkSync(wt('main'), wt('alias'));
  const own = path.join(wt('alias'), 'coverage/unit/tmp');
  const asked: string[] = [];
  const worktrees = (cwd: string) => {
    asked.push(cwd);
    return [wt('main'), wt('a'), wt('b'), wt('c'), wt('gone')];
  };
  const parents = siblingRawParents(own, { root: wt('main'), worktrees });
  assert.deepEqual(parents.sort(), [path.join(wt('a'), 'coverage/e2e/tmp'), path.join(wt('a'), 'coverage/unit/tmp')]);
  assert.equal(asked.length, 1, 'git is asked from the checkout, not the reports folder');
  // a reports folder outside the checkout (another repository, a test's temporary folder) prunes no sibling
  assert.deepEqual(siblingRawParents(path.join(wt('a'), 'coverage/unit/tmp'), { root: wt('main'), worktrees }), []);
  assert.deepEqual(siblingRawParents(own), [], 'by default the checkout is this repository, which a temporary folder is outside');
  assert.equal(asked.length, 1);
});

test('worktrees come from git worktree list in porcelain form, and none outside a repository', (t) => {
  const calls: unknown[][] = [];
  const porcelain = 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/.claude/worktrees/x\nHEAD def\ndetached\n';
  const run = ((...args: unknown[]) => {
    calls.push(args);
    return porcelain;
  }) as never;
  assert.deepEqual(listWorktrees('/repo/sub', run), ['/repo', '/repo/.claude/worktrees/x']);
  assert.deepEqual(calls[0].slice(0, 2), ['git', ['worktree', 'list', '--porcelain']]);
  assert.equal((calls[0][2] as { cwd: string }).cwd, '/repo/sub');
  const failing = (() => {
    throw new Error('not a git repository');
  }) as never;
  assert.deepEqual(listWorktrees('/nowhere', failing), []);
  // the real command outside any repository
  assert.deepEqual(listWorktrees(path.dirname(path.dirname(reportsDir(t)))), []);
});
