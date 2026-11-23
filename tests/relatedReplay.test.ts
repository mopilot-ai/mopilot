// scripts/related-replay.mjs: replaying test selection over merged pull requests gives the per-file and per-change
// numbers docs/architecture/modularization.md §6 tracks.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { domainOf, main, mergedChanges, quantile, replay, summarize, table } from '../scripts/related-replay.mjs';

// A graph where a store module reaches two tests and a leaf reaches one.
const users = new Map<string, Set<string>>([
  ['src/fx/send.ts', new Set(['src/fx/store.ts', 'tests/send.test.ts'])],
  ['src/fx/store.ts', new Set(['tests/app.test.ts'])],
  ['electron/fx/queue.cjs', new Set(['tests/queue.test.ts'])],
]);

// two merges: a store change with its test, and a session change beside a doc and a since-deleted file
const LOG = 'aaa Merge pull request #1 from x/store\nbbb Merge pull request #2 from x/session\n';
const DIFFS: Record<string, string> = {
  aaa: 'src/fx/send.ts\ntests/send.test.ts\n',
  bbb: 'electron/fx/queue.cjs\ndocs/notes.md\nelectron/gone.cjs\n',
};
const git = (args: string[]) => {
  if (args[0] === 'log') return LOG;
  return DIFFS[args.at(-1) as string];
};
const exists = (file: string) => file !== 'electron/gone.cjs';
const invariantsFor = (files: string[]) =>
  files.some((f) => f.startsWith('src/')) ? ['tests/a.invariant.test.ts', 'tests/send.test.ts'] : [];

test('quantile is nearest-rank over sorted values, and 0 for none', () => {
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([3], 0.9), 3);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.9), 4);
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
});

test('a domain is the first two path segments', () => {
  assert.equal(domainOf('electron/fx/queue.cjs'), 'electron/fx');
  assert.equal(domainOf('README.md'), 'README.md');
});

test('mergedChanges lists each first-parent merge with the paths it changed against main before it', () => {
  const calls: string[][] = [];
  const changes = mergedChanges(
    (args) => {
      calls.push(args);
      return git(args);
    },
    { base: 'main', limit: 2 },
  );
  assert.deepEqual(calls[0], ['log', '--first-parent', '--merges', '--format=%H %s', '-n2', 'main']);
  assert.deepEqual(calls[1], ['diff', '--no-ext-diff', '--no-renames', '--name-only', 'aaa^1', 'aaa']);
  assert.deepEqual(changes[0], {
    sha: 'aaa',
    subject: 'Merge pull request #1 from x/store',
    files: ['src/fx/send.ts', 'tests/send.test.ts'],
  });
  assert.equal(changes.length, 2);
  // the defaults: origin/main, 200 merges
  assert.deepEqual(mergedChanges((args) => (args[0] === 'log' ? (calls.push(args), '') : ''))[0], undefined);
  assert.deepEqual(calls.at(-1), ['log', '--first-parent', '--merges', '--format=%H %s', '-n200', 'origin/main']);
});

test('replay counts sources only per file, unions related and invariant tests per change, and spots single-domain changes', () => {
  const { rows, perFile } = replay(mergedChanges(git), users, { invariantsFor, exists });
  assert.deepEqual(
    [...perFile],
    [
      ['src/fx/send.ts', 2],
      ['electron/fx/queue.cjs', 1],
    ],
  );
  assert.deepEqual(
    rows.map((r) => [r.related, r.invariants, r.selected, r.singleDomain]),
    [
      [2, 2, 3, true],
      [1, 0, 1, true],
    ],
  );
  assert.deepEqual(rows[1].graph, ['electron/fx/queue.cjs'], 'docs and deleted files are not graph files today');
  const summary = summarize({ rows, perFile });
  assert.deepEqual(summary, {
    changes: 2,
    files: 2,
    relatedPerFile: { p50: 1, p90: 2, max: 2 },
    invariantsPerChange: { p50: 0, p90: 2 },
    invariantsPerSingleDomainChange: { changes: 2, p50: 0, p90: 2 },
    selectedPerChange: { p50: 1, p90: 3 },
  });
  assert.match(table(summary), /Replayed 2 merged pull requests \(2 changed source files still in the tree\)/);
  assert.match(table(summary), /\| Invariant tests per single-domain change \(2\) \| 0 \| 2 \|/);
});

test('a change across domains is not single-domain; one with no sources is neither', () => {
  const { rows } = replay(
    [
      { sha: 'c', subject: '', files: ['src/fx/send.ts', 'electron/fx/queue.cjs'] },
      { sha: 'd', subject: '', files: ['tests/send.test.ts'] },
    ],
    users,
    { invariantsFor, exists: () => true },
  );
  assert.deepEqual(
    rows.map((r) => r.singleDomain),
    [false, false],
  );
  // the defaults: the real invariant selection and the working tree; a file outside it selects nothing
  const real = replay([{ sha: 'e', subject: '', files: ['src/no/such/file.ts'] }], users);
  assert.deepEqual([real.rows[0].graph, real.rows[0].related], [[], 0]);
});

test('main prints the table or JSON and validates its arguments', () => {
  const out: string[] = [];
  const log = (s: string) => out.push(s);
  const summary = main(['--', '--limit=2', '--base=main'], { git, log, users: () => users, exists });
  assert.equal(summary.changes, 2);
  assert.match(out[0], /^Replayed 2/);
  main(['--json'], { git, log, users: () => users, exists });
  assert.equal(JSON.parse(out[1]).files, 2);
  // without an exists override, main checks the working tree
  assert.equal(main([], { git, log, users: () => users }).changes, 2);
  assert.throws(() => main(['--limit=0'], { git, log }), /positive whole number/);
  assert.throws(() => main(['--nope'], { git, log }), /Unknown argument: --nope/);
});

test('the command replays this checkout’s merges, and names a bad argument', () => {
  const ok = spawnSync(process.execPath, ['scripts/related-replay.mjs', '--limit=1', '--base=HEAD', '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(JSON.parse(ok.stdout).changes <= 1);
  const bad = spawnSync(process.execPath, ['scripts/related-replay.mjs', '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown argument: --nope/);
});
