// scripts/lint-ratchet.mjs: bug-class warnings may only go down per file, totals may not rise, fixes are recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALL,
  BASELINE,
  compare,
  configuredRules,
  countWarnings,
  defaultRun,
  describeRaised,
  formatBaseline,
  LINTED,
  lint,
  main,
  merge,
  parseBaseline,
  risenTotals,
  ruleOf,
} from '../scripts/lint-ratchet.mjs';

const counts = (o: Record<string, Record<string, number>>) => new Map(Object.entries(o).map(([r, f]) => [r, new Map(Object.entries(f))]));
const plain = (c: Map<string, Map<string, number>>) => Object.fromEntries([...c].map(([r, f]) => [r, Object.fromEntries(f)]));
const warn = (file: string, message: string, category = 'plugin', line: number | null = 1) => ({
  severity: 'warning',
  category,
  message,
  location: { path: file, start: line === null ? undefined : { line } },
});

test('warnings count under their plugin tag or Biome category; errors and unplaced diagnostics do not count', () => {
  assert.equal(ruleOf({ category: 'lint/nursery/noFloatingPromises', message: 'x' }), 'lint/nursery/noFloatingPromises');
  assert.equal(ruleOf({ category: 'plugin', message: '[time-id] A timestamp' }), 'plugin/time-id');
  assert.equal(ruleOf({ category: 'plugin', message: 'untagged' }), 'plugin');
  assert.equal(ruleOf({ category: 'plugin' }), 'plugin');
  const report = {
    diagnostics: [
      warn('src/a.ts', '[swallowed-error] one'),
      warn('src/a.ts', '[swallowed-error] two'),
      warn('src/b.ts', 'floating', 'lint/nursery/noFloatingPromises'),
      { severity: 'error', category: 'lint/x', message: 'an error is the ordinary lint’s', location: { path: 'src/a.ts' } },
      { severity: 'warning', category: 'plugin', message: '[time-id] no file' },
    ],
  };
  const { counts: got, warnings } = countWarnings(report);
  assert.deepEqual(plain(got), { 'plugin/swallowed-error': { 'src/a.ts': 2 }, 'lint/nursery/noFloatingPromises': { 'src/b.ts': 1 } });
  assert.equal(warnings.length, 3);
  assert.equal(countWarnings({}).warnings.length, 0);
});

test('the baseline file round-trips sorted, without zero entries; a rule with none left stays, empty', () => {
  assert.equal(parseBaseline(null).size, 0);
  assert.equal(parseBaseline('{}').size, 0);
  const text = formatBaseline(
    counts({ 'plugin/z': { 'src/b.ts': 1, 'src/a.ts': 2, 'src/gone.ts': 0 }, 'lint/a': { 'src/a.ts': 0 }, 'plugin/m': { 'src/c.ts': 3 } }),
  );
  assert.ok(text.endsWith('}\n'));
  const parsed = JSON.parse(text);
  assert.match(parsed.about, /may only go down/);
  assert.deepEqual(Object.keys(parsed.rules), ['lint/a', 'plugin/m', 'plugin/z']);
  assert.deepEqual(parsed.rules['lint/a'], {});
  assert.deepEqual(Object.keys(parsed.rules['plugin/z']), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(plain(parseBaseline(text)), parsed.rules);
});

test('compare finds the entries that rose and fell, within a scope when given', () => {
  const was = counts({ r: { 'src/a.ts': 2, 'src/b.ts': 1, 'src/same.ts': 4 }, gone: { 'src/c.ts': 1 } });
  const now = counts({ r: { 'src/a.ts': 3, 'src/same.ts': 4, 'src/new.ts': 1 } });
  assert.deepEqual(compare(was, now, ALL), {
    raised: [
      { rule: 'r', file: 'src/a.ts', was: 2, now: 3 },
      { rule: 'r', file: 'src/new.ts', was: 0, now: 1 },
    ],
    lowered: [
      { rule: 'r', file: 'src/b.ts', was: 1, now: 0 },
      { rule: 'gone', file: 'src/c.ts', was: 1, now: 0 },
    ],
  });
  assert.deepEqual(
    compare(was, now, (f) => f === 'src/b.ts'),
    { raised: [], lowered: [{ rule: 'r', file: 'src/b.ts', was: 1, now: 0 }] },
  );
});

test('merge replaces the scoped files’ entries, or everything without a scope', () => {
  const was = counts({ r: { 'src/a.ts': 2, 'src/b.ts': 1 }, old: { 'src/a.ts': 1 } });
  const now = counts({ r: { 'src/a.ts': 1, 'src/other.ts': 5 }, fresh: { 'src/a.ts': 1 } });
  assert.deepEqual(plain(merge(was, now, (f) => f === 'src/a.ts')), {
    r: { 'src/b.ts': 1, 'src/a.ts': 1 },
    old: {},
    fresh: { 'src/a.ts': 1 },
  });
  assert.deepEqual(plain(merge(was, now, ALL)), { r: { 'src/a.ts': 1, 'src/other.ts': 5 }, old: {}, fresh: { 'src/a.ts': 1 } });
});

test('a rule’s total may not rise; a rule the old baseline lacks starts free', () => {
  const was = counts({ r: { 'src/a.ts': 2 }, s: { 'src/a.ts': 1 } });
  assert.deepEqual(risenTotals(was, counts({ r: { 'src/b.ts': 2 }, s: { 'src/a.ts': 1 }, brandNew: { 'src/a.ts': 9 } })), []);
  assert.deepEqual(risenTotals(was, counts({ r: { 'src/a.ts': 2, 'src/b.ts': 1 } })), [{ rule: 'r', was: 2, now: 3 }]);
  // a rule burned down to zero is kept as {}: it is not new, and may not rise again
  const zeroed = parseBaseline(formatBaseline(counts({ r: { 'src/a.ts': 0 } })));
  assert.deepEqual(risenTotals(zeroed, counts({ r: { 'src/b.ts': 1 } })), [{ rule: 'r', was: 0, now: 1 }]);
});

test('the configured rules are the warning-level Biome rules and the GritQL files', () => {
  const biome = {
    linter: {
      rules: {
        preset: 'none',
        empty: null,
        suspicious: { noArrayIndexKey: 'warn', noExplicitAny: 'error', noDoubleEquals: { level: 'error' }, off: null },
        nursery: { noFloatingPromises: { level: 'warn', options: {} } },
      },
    },
    // an override can turn a rule to a warning too (tests turn them off); one without rules adds nothing
    overrides: [{ linter: { rules: { a11y: { useKeyWithClickEvents: 'warn' }, suspicious: { noArrayIndexKey: 'off' } } } }, {}],
  };
  assert.deepEqual(configuredRules(biome, ['time-id.grit', 'README.md']), [
    'lint/a11y/useKeyWithClickEvents',
    'lint/nursery/noFloatingPromises',
    'lint/suspicious/noArrayIndexKey',
    'plugin/time-id',
  ]);
  assert.deepEqual(configuredRules({}, []), []);
});

test('lint/baseline.json records exactly the rules the ratchet counts, so none can rise as a new rule', () => {
  const repo = new URL('../', import.meta.url);
  const rules = configuredRules(JSON.parse(readFileSync(new URL('biome.json', repo), 'utf8')), readdirSync(new URL('lint/rules', repo)));
  const recorded = parseBaseline(readFileSync(new URL(BASELINE, repo), 'utf8'));
  assert.ok(rules.includes('lint/correctness/useExhaustiveDependencies') && rules.includes('plugin/swallowed-error'));
  assert.deepEqual(
    rules.filter((rule) => !recorded.has(rule)),
    [],
    'record each as `"<rule>": {}` in lint/baseline.json (npm run lint:ratchet -- --update records the ones with warnings)',
  );
  assert.deepEqual(
    [...recorded.keys()].filter((rule) => !rules.includes(rule)),
    [],
    'a rule no longer configured leaves the baseline',
  );
});

test('a raised entry lists that rule’s warnings in that file', () => {
  const warnings = [
    warn('src/a.ts', '[time-id] new'),
    warn('src/a.ts', '[time-id] old', 'plugin', null),
    warn('src/b.ts', '[time-id] elsewhere'),
  ];
  assert.deepEqual(describeRaised([{ rule: 'plugin/time-id', file: 'src/a.ts', was: 1, now: 2 }], warnings), [
    'src/a.ts: plugin/time-id rose from 1 to 2. Fix the new one (the list includes the existing ones):',
    '  src/a.ts:1 [time-id] new',
    '  src/a.ts:? [time-id] old',
  ]);
});

test('lint runs the repository’s Biome on the named files and fails clearly without a report', () => {
  const seen: string[][] = [];
  const report = { diagnostics: [warn('src/a.ts', '[time-id] x')] };
  const got = lint(['src/a.ts'], (cmd, args) => (seen.push([cmd, ...args]), { status: 0, stdout: JSON.stringify(report) }));
  assert.equal(seen[0][0], process.execPath);
  assert.match(seen[0][1], /@biomejs[/\\]biome[/\\]bin[/\\]biome$/);
  assert.deepEqual(seen[0].slice(2, 4), ['lint', '--reporter=json']);
  assert.equal(seen[0].at(-1), 'src/a.ts');
  assert.deepEqual(plain(got.counts), { 'plugin/time-id': { 'src/a.ts': 1 } });
  assert.throws(() => lint([], () => ({ status: 2, stderr: 'bad config' })), /status=2; signal=none[\s\S]*stderr="bad config"/);
  assert.throws(() => lint([], () => ({ status: null, stdout: 'not json' })), /status=null; signal=none/);
  assert.equal(defaultRun(process.execPath, ['-e', 'process.stdout.write("ok")']).stdout, 'ok');
});

test('the pre-commit step counts the files the pull request check counts: every source Biome lints, not the web app', () => {
  // the phone app and tests among them: a phone warning was refused by the pull request check after the pre-commit step let it through
  assert.ok(
    [
      'src/a.ts',
      'src/b.tsx',
      'electron/c.cjs',
      'shared/d.mjs',
      'scripts/e.mjs',
      'bench/lib/f.mjs',
      'relay/server.mjs',
      'host/agent.ts',
      'mobile/src/MobileApp.tsx',
      'mobile/src/remote/client.ts',
      'mobile/App.tsx',
      'mobile/index.js',
      'mobile/metro.config.js',
      'tests/a.test.ts',
      'src/styles/tokens.css',
      'src/styles/app/thread-messages.css',
    ].every((f) => LINTED.test(f)),
  );
  assert.ok(
    ![
      'web/app/page.tsx',
      'docs/a.md',
      'lint/baseline.json',
      'web/app/a.css',
      'mobile/plugins/withLiveActivity.js',
      'mobile/app.config.js',
      'native/a.ts',
    ].some((f) => LINTED.test(f)),
  );
});

/** A repository root holding `baseline`, a Biome that reports `report`, and a git that answers from `git`. */
function setup(
  t: { after: (fn: () => void) => void },
  baseline: Record<string, Record<string, number>> | null,
  {
    report = { diagnostics: [] as unknown[] },
    git = {} as Record<string, { status: number; stdout?: string; stderr?: string }>,
    files = [] as string[],
  } = {},
) {
  const repoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lint-ratchet-')));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  mkdirSync(path.join(repoRoot, 'lint'));
  if (baseline) writeFileSync(path.join(repoRoot, BASELINE), formatBaseline(counts(baseline)));
  for (const f of files) {
    mkdirSync(path.dirname(path.join(repoRoot, f)), { recursive: true });
    writeFileSync(path.join(repoRoot, f), '');
  }
  const linted: string[][] = [];
  const gitCalls: string[] = [];
  const logs: string[] = [];
  const run = (cmd: string, args: string[]) => {
    if (cmd !== 'git') {
      linted.push(args.slice(6));
      return { status: 0, stdout: JSON.stringify(report) };
    }
    gitCalls.push(args.join(' '));
    return git[args.join(' ')] ?? git[args.slice(0, 2).join(' ')] ?? git[args[0]] ?? { status: 0, stdout: '' };
  };
  const read = () => plain(parseBaseline(readFileSync(path.join(repoRoot, BASELINE), 'utf8')));
  const go = (argv: string[]) => main(argv, { run, log: (s: string) => logs.push(s), repoRoot });
  return { repoRoot, linted, gitCalls, logs, read, go };
}

test('a full check fails when a file rises and suggests recording counts that fell', (t) => {
  const report = { diagnostics: [warn('src/a.ts', '[time-id] a'), warn('src/a.ts', '[time-id] b'), warn('src/b.ts', '[time-id] c')] };
  const risen = setup(t, { 'plugin/time-id': { 'src/a.ts': 1, 'src/b.ts': 1 } }, { report });
  assert.equal(risen.go([]), 1);
  assert.deepEqual(risen.linted, [[]], 'every file');
  assert.match(risen.logs[0], /^src\/a\.ts: plugin\/time-id rose from 1 to 2/);
  assert.match(risen.logs.at(-1) ?? '', /may only go down/);
  const fell = setup(t, { 'plugin/time-id': { 'src/a.ts': 3, 'src/b.ts': 1 } }, { report });
  assert.equal(fell.go([]), 0);
  assert.deepEqual(fell.logs, ['lint ratchet: 1 counts went down; run `npm run lint:ratchet -- --update` to record them.']);
  const same = setup(t, { 'plugin/time-id': { 'src/a.ts': 2, 'src/b.ts': 1 } }, { report });
  assert.equal(same.go([]), 0);
  assert.deepEqual(same.logs, []);
  // no baseline yet: every warning is new
  assert.equal(setup(t, null, { report }).go([]), 1);
});

test('the pull request check also refuses a baseline whose totals rose over the base', (t) => {
  const report = { diagnostics: [warn('src/a.ts', '[time-id] a'), warn('src/a.ts', '[time-id] b')] };
  const base = formatBaseline(counts({ 'plugin/time-id': { 'src/a.ts': 1 } }));
  // someone raised the baseline by hand: every file is within it, but the total rose
  const raised = setup(
    t,
    { 'plugin/time-id': { 'src/a.ts': 2 } },
    { report, git: { 'merge-base': { status: 0, stdout: 'mb\n' }, show: { status: 0, stdout: base } } },
  );
  assert.equal(raised.go(['--base=origin/main']), 1);
  assert.deepEqual(raised.gitCalls, ['merge-base origin/main HEAD', 'diff --name-only mb', `show mb:${BASELINE}`]);
  assert.match(raised.logs[0], /raises plugin\/time-id from 1 to 2 in total over origin\/main/);
  // a pull request answers for the files it changes, not for warnings main already holds
  const pr = (changed: string) => ({
    'merge-base': { status: 0, stdout: 'mb\n' },
    'diff --name-only': { status: 0, stdout: changed },
    show: { status: 0, stdout: formatBaseline(counts({ 'plugin/time-id': { 'src/a.ts': 1 } })) },
  });
  const touched = setup(t, { 'plugin/time-id': { 'src/a.ts': 1 } }, { report, git: pr('src/a.ts\ndocs/x.md\n') });
  assert.equal(touched.go(['--base=origin/main']), 1);
  assert.match(touched.logs[0], /^src\/a\.ts: plugin\/time-id rose from 1 to 2/);
  const untouched = setup(t, { 'plugin/time-id': { 'src/a.ts': 1 } }, { report, git: pr('src/b.ts\n') });
  assert.equal(untouched.go(['--base=origin/main']), 0);
  // the base predates the ratchet
  const first = setup(
    t,
    { 'plugin/time-id': { 'src/a.ts': 2 } },
    { report, git: { 'merge-base': { status: 0, stdout: 'mb\n' }, show: { status: 128 } } },
  );
  assert.equal(first.go(['--base=origin/main']), 0);
  // git failures stop the check
  const broken = setup(
    t,
    { 'plugin/time-id': { 'src/a.ts': 2 } },
    { report, git: { 'merge-base': { status: 128, stderr: 'no such ref' } } },
  );
  assert.throws(() => broken.go(['--base=nope']), /git merge-base nope HEAD failed:\nno such ref/);
  const silent = setup(t, { 'plugin/time-id': { 'src/a.ts': 2 } }, { report, git: { 'merge-base': { status: 1 } } });
  assert.throws(() => silent.go(['--base=nope']), /failed:\n$/);
});

test('update records current counts, for named files or all, but never a higher total', (t) => {
  const report = { diagnostics: [warn('src/moved.ts', '[time-id] a'), warn('src/moved.ts', '[time-id] b')] };
  // code moved from old.ts into moved.ts: the total stays 2
  const moved = setup(t, { 'plugin/time-id': { 'src/old.ts': 2 } }, { report });
  assert.equal(moved.go(['--update', 'src/old.ts', 'src/moved.ts']), 0);
  assert.deepEqual(moved.linted, [['src/old.ts', 'src/moved.ts']]);
  assert.deepEqual(moved.read(), { 'plugin/time-id': { 'src/moved.ts': 2 } });
  assert.match(moved.logs[0], /recorded the counts for src\/old\.ts, src\/moved\.ts/);
  const all = setup(t, { 'plugin/time-id': { 'src/old.ts': 2 } }, { report });
  assert.equal(all.go(['--update']), 0);
  assert.deepEqual(all.read(), { 'plugin/time-id': { 'src/moved.ts': 2 } });
  assert.match(all.logs[0], /recorded the counts in lint\/baseline\.json/);
  // nor for a rule whose warnings were all fixed
  const zeroed = setup(t, { 'plugin/time-id': {} }, { report });
  assert.equal(zeroed.go(['--update']), 1);
  assert.match(zeroed.logs[0], /plugin\/time-id would rise from 0 to 2/);
  assert.deepEqual(zeroed.read(), { 'plugin/time-id': {} });
  // a new warning is not recorded
  const added = setup(t, { 'plugin/time-id': { 'src/moved.ts': 1 } }, { report });
  assert.equal(added.go(['--update']), 1);
  assert.match(added.logs[0], /plugin\/time-id would rise from 1 to 2 in total/);
  assert.deepEqual(added.read(), { 'plugin/time-id': { 'src/moved.ts': 1 } });
});

test('the staged check lints staged sources, fails on a rise, and records and stages what went down', (t) => {
  const staged = (names: string, unstaged = '', untracked = '') => ({
    'rev-parse -q --verify MERGE_HEAD': { status: 1 },
    'diff --cached': { status: 0, stdout: names },
    'diff --name-only': { status: 0, stdout: unstaged },
    'ls-files --others': { status: 0, stdout: untracked },
  });
  // nothing the ratchet counts is staged
  const none = setup(t, {}, { git: staged('docs/a.md\ntests/a.test.ts\n') });
  assert.equal(none.go(['--staged']), 0);
  assert.deepEqual(none.linted, []);
  // nothing staged at all
  assert.equal(setup(t, {}, { git: { 'rev-parse': { status: 1 }, 'diff --cached': { status: 0 } } }).go(['--staged']), 0);
  // a staged source rose
  const report = { diagnostics: [warn('src/a.ts', '[time-id] a'), warn('src/a.ts', '[time-id] b')] };
  const rose = setup(t, { 'plugin/time-id': { 'src/a.ts': 1 } }, { report, git: staged('src/a.ts\n'), files: ['src/a.ts'] });
  assert.equal(rose.go(['--staged']), 1);
  assert.deepEqual(rose.linted, [['src/a.ts']]);
  assert.match(rose.logs.at(-1) ?? '', /npm run lint:ratchet -- --update <files>/);
  assert.ok(!rose.logs.some((l) => /unstaged/.test(l)));
  // the same rise with unstaged edits in the file says the count includes them
  const roseDirty = setup(
    t,
    { 'plugin/time-id': { 'src/a.ts': 1 } },
    { report, git: staged('src/a.ts\n', 'src/a.ts\n'), files: ['src/a.ts'] },
  );
  assert.equal(roseDirty.go(['--staged']), 1);
  assert.ok(roseDirty.logs.includes('lint ratchet: the counts include unstaged edits in those files.'));
  // a staged source fell and a staged file was deleted; other files' entries stay
  const fell = setup(
    t,
    { 'plugin/time-id': { 'src/a.ts': 3, 'src/other.ts': 4 }, 'plugin/swallowed-error': { 'src/deleted.ts': 1 } },
    { report, git: staged('src/a.ts\nsrc/deleted.ts\n'), files: ['src/a.ts'] },
  );
  assert.equal(fell.go(['--staged']), 0);
  assert.deepEqual(fell.linted, [['src/a.ts']]);
  // the rule whose last warning went stays, at zero
  assert.deepEqual(fell.read(), { 'plugin/swallowed-error': {}, 'plugin/time-id': { 'src/a.ts': 2, 'src/other.ts': 4 } });
  assert.ok(fell.gitCalls.includes(`add ${BASELINE}`));
  assert.match(fell.logs[0], /updated and staged/);
  // unchanged: nothing written or staged
  const same = setup(t, { 'plugin/time-id': { 'src/a.ts': 2 } }, { report, git: staged('src/a.ts\n'), files: ['src/a.ts'] });
  assert.equal(same.go(['--staged']), 0);
  assert.ok(!same.gitCalls.includes(`add ${BASELINE}`));
  // only deletions: nothing to lint, their entries drop (the rule stays, at zero)
  const deleted = setup(t, { 'plugin/time-id': { 'src/deleted.ts': 2 } }, { git: staged('src/deleted.ts\n') });
  assert.equal(deleted.go(['--staged']), 0);
  assert.deepEqual(deleted.linted, []);
  assert.deepEqual(deleted.read(), { 'plugin/time-id': {} });
  // a file with unstaged edits may hold fixes this commit lacks: it does not lower the baseline
  const dirty = setup(
    t,
    { 'plugin/time-id': { 'src/a.ts': 3 } },
    { report, git: staged('src/a.ts\n', 'src/a.ts\ndocs/x.md\n'), files: ['src/a.ts'] },
  );
  assert.equal(dirty.go(['--staged']), 0);
  assert.deepEqual(dirty.read(), { 'plugin/time-id': { 'src/a.ts': 3 } });
  assert.ok(!dirty.gitCalls.includes(`add ${BASELINE}`));
  // a merge commit: the files taken unchanged from the branch merged in (here src/theirs.ts) are that branch's
  const merge = setup(
    t,
    { 'plugin/time-id': { 'src/theirs.ts': 0, 'src/a.ts': 2 } },
    {
      report: { diagnostics: [...report.diagnostics, warn('src/theirs.ts', '[time-id] theirs')] },
      git: {
        'rev-parse -q --verify MERGE_HEAD': { status: 0, stdout: 'mh\n' },
        'diff --cached --name-only MERGE_HEAD': { status: 0, stdout: 'src/a.ts\n' },
        'diff --cached --name-only --diff-filter=ACMRD': { status: 0, stdout: 'src/a.ts\nsrc/theirs.ts\nbiome.json\n' },
      },
      files: ['src/a.ts', 'src/theirs.ts'],
    },
  );
  assert.equal(merge.go(['--staged']), 0);
  assert.deepEqual(merge.linted, [['src/a.ts']]);
  // a lint configuration change re-checks every file but an untracked one, which no commit holds
  const withUntracked = { diagnostics: [...report.diagnostics, warn('src/scratch.ts', '[time-id] mine')] };
  const config = setup(
    t,
    { 'plugin/time-id': { 'src/a.ts': 2 } },
    { report: withUntracked, git: staged('lint/rules/time-id.grit\n', '', 'src/scratch.ts\n') },
  );
  assert.equal(config.go(['--staged']), 0);
  assert.deepEqual(config.linted, [[]]);
  assert.deepEqual(config.read(), { 'plugin/time-id': { 'src/a.ts': 2 } });
  // and lowers the files that went down
  const configFell = setup(t, { 'plugin/time-id': { 'src/a.ts': 5, 'src/b.ts': 1 } }, { report, git: staged('biome.json\n') });
  assert.equal(configFell.go(['--staged']), 0);
  assert.deepEqual(configFell.read(), { 'plugin/time-id': { 'src/a.ts': 2 } });
});

test('the command line checks this checkout’s changes against its baseline, and reports failures as messages', () => {
  const ok = spawnSync(process.execPath, ['scripts/lint-ratchet.mjs', '--base=HEAD'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = spawnSync(process.execPath, ['scripts/lint-ratchet.mjs', '--base=refs/heads/no-such-ref-for-the-ratchet'], {
    encoding: 'utf8',
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /git merge-base refs\/heads\/no-such-ref-for-the-ratchet HEAD failed/);
});

test('lint rejects missing reports and interrupted processes even when stdout is JSON', () => {
  assert.throws(() => lint([], () => ({ status: 0, stdout: '{}' })));
  assert.throws(() => lint([], () => ({ status: null, signal: 'SIGTERM', stdout: '{"diagnostics":[]}' })));
  assert.throws(() => lint([], () => ({ status: 2, stdout: '{"diagnostics":[]}' })));
  const missingSeverity = { message: '[time-id] x', category: 'plugin', location: { path: 'src/a.ts' } };
  assert.throws(() => lint([], () => ({ status: 0, stdout: JSON.stringify({ diagnostics: [missingSeverity] }) })));
  const cause = new Error('spawn ENOBUFS');
  assert.throws(() => lint([], () => ({ status: null, error: cause })), /cause="spawn ENOBUFS"/);
  const valid = lint([], () => ({ status: 1, stdout: JSON.stringify({ diagnostics: [warn('src/a.ts', '[time-id] x')] }) }));
  assert.deepEqual(plain(valid.counts), { 'plugin/time-id': { 'src/a.ts': 1 } });
});
