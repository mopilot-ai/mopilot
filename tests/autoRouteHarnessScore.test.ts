// Global Auto's harness scores from HM-Router's results: the table build, benchmark weights and per-harness scores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseCsv, buildTable, HARNESSES } from '../scripts/build-hm-table.mjs';

const require = createRequire(import.meta.url);
const { createHarnessScorer, normalize } = require('../electron/autoRoute/harnessScore.cjs');
const { termsOf } = require('../electron/autoRoute/hmTerms.cjs');
const shipped = require('../electron/autoRoute/hmTable.json');

const bench = [
  'benchmark,query_id,model,harness,scaffold,acc',
  'terminal,t1,claude-opus-4-8,Claude Code,claudecode,1.0',
  'terminal,t2,claude-opus-4-8,Claude Code,claudecode,0.0',
  'terminal,t1,gpt-5.5,Codex,codex,1.0',
  'terminal,t2,gpt-5.5,Codex,codex,1.0',
  'terminal,t1,gpt-5-5,Codex,codex,1.0',
  'web,w1,claude-opus-4-8,Claude Code,claudecode,1.0',
  'web,w1,gemini-3-flash,Gemini CLI,geminicli,0.0',
  'web,w1,some-model,OpenHands,openhands,1.0',
  'web,w2,,Codex,codex,1.0',
  'web,w3,gpt-5.5,Codex,codex,n/a',
  'solo,s1,gpt-5.5,Codex,codex,1.0',
].join('\r\n');
const queries = [
  'benchmark,query_id,query',
  'terminal,t1,"Compile the kernel, then run ""make test"" in the shell"',
  'terminal,t2,"Fix the failing shell build\nwith make"',
  'web,w1,Browse the website and book a flight',
  'other,o1,Not a benchmark any harness here ran',
  'web,w9,!!! ???',
].join('\n');

test('the CSV reader keeps quoted commas, quotes and newlines', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n\n1,\n'), [
    { a: 'x, y', b: 'say "hi"\nthere' },
    { a: '1', b: '' },
  ]);
  assert.deepEqual(parseCsv('a,b\n1,2'), [{ a: '1', b: '2' }]);
  // a short row leaves the rest empty
  assert.deepEqual(parseCsv('a,b,c\n1,2\n'), [{ a: '1', b: '2', c: '' }]);
});

test('the table keeps only harnesses MoPilot runs, with each cell’s mean and count', () => {
  const t = buildTable(bench, queries);
  assert.deepEqual(t.benchmarks, ['solo', 'terminal', 'web']);
  // a benchmark with no queries has no centroid words
  assert.deepEqual(t.centroids.solo, []);
  assert.deepEqual(Object.keys(t.results).sort(), ['acp:gemini', 'claude', 'codex']);
  assert.deepEqual(t.results.claude['claude-opus-4-8'], { terminal: [0.5, 2], web: [1, 1] });
  assert.deepEqual(t.results.codex['gpt-5.5'], { solo: [1, 1], terminal: [1, 2] });
  assert.ok(t.centroids.terminal.some((e: any) => e[0] === 'shell'));
  assert.ok(t.idf.shell > 0);
  assert.ok(Object.values(HARNESSES).flat().includes('Claude Code'));
});

test('terms are Latin words of two or more letters and CJK characters, without stop words', () => {
  assert.deepEqual(termsOf('Fix the build: 修复 a bug in x2y'), ['fix', 'build', '修', '复', 'bug', 'in', 'x2y']);
  assert.deepEqual(termsOf(null as any), []);
});

test('benchmark weights follow the request’s words, uniform with none known', () => {
  const s = createHarnessScorer(buildTable(bench, queries));
  const w = s.benchmarkWeights('the shell build fails under make');
  assert.ok(w.terminal > 0.9);
  const flat = s.benchmarkWeights('zzz qqq');
  assert.equal(Math.round(flat.terminal * 1000), 333);
  assert.equal(Math.round(flat.web * 1000), 333);
});

test('each measured harness scores by its best offered model’s lead over the benchmark average, less the price weight', () => {
  const s = createHarnessScorer(buildTable(bench, queries));
  const ranked = s.score(
    'the shell build fails under make',
    [
      { kind: 'claude', models: ['claude-opus-4-8'] },
      { kind: 'codex', models: ['gpt-5.5', 'unknown'] },
      { kind: 'acp:gemini', models: [] },
      { kind: 'acp:cline', models: ['x'] },
    ],
    0,
  );
  assert.deepEqual(
    ranked.map((r: any) => r.kind),
    ['codex', 'acp:gemini', 'claude'],
  );
  assert.equal(ranked[0].model, 'gpt-5-5');
  assert.ok(ranked[0].score > 0 && ranked[0].success > ranked[0].score);
  assert.equal(ranked[0].estimated, false);
  // a harness with none of its measured models here is judged by those together
  assert.equal(ranked[1].estimated, true);
  // the price weight counts a larger model against it
  const priced = s.score('book a flight on the website', [{ kind: 'claude', models: ['claude-opus-4-8'] }], 1);
  assert.ok(priced[0].score < s.score('book a flight on the website', [{ kind: 'claude', models: ['claude-opus-4-8'] }], 0)[0].score);
  assert.equal(s.measured('codex'), true);
  assert.equal(s.measured('acp:cline'), false);
  // a candidate without its models listed is judged by the measured ones
  assert.equal(s.score('x', [{ kind: 'codex' } as any], 0)[0].estimated, true);
  // a newer release than the paper's counts as its family's newest measured version
  assert.equal(s.score('x', [{ kind: 'claude', models: ['claude-opus-5-5'] }], 0)[0].model, 'claude-opus-4-8');
});

test('a benchmark a harness never ran neither helps nor hurts it', () => {
  const table = {
    benchmarks: ['a', 'b', 'c'],
    idf: {},
    centroids: {},
    results: { claude: { m: { a: [1, 4] } }, codex: { n: { a: [0, 4], b: [0.5, 2] } } },
  } as any;
  const s = createHarnessScorer(table);
  // a: average 0.5 over both; claude 1.0 smoothed to (4 + 1) / 6, codex 0 smoothed to 1 / 6; b: only codex, at average
  const [claude, codex] = s.score(
    'anything',
    [
      { kind: 'claude', models: ['m'] },
      { kind: 'codex', models: ['n'] },
    ],
    0,
  );
  assert.equal(claude.kind, 'claude');
  assert.equal(Math.round(claude.score * 1000), Math.round(((5 / 6 - 0.5) / 3) * 1000));
  assert.equal(Math.round(codex.score * 1000), Math.round(((1 / 6 - 0.5) / 3) * 1000));
  // c, with no results at all, adds nothing
  assert.equal(Math.round(claude.success * 1000), Math.round(((5 / 6 + 0.5 + 0) / 3) * 1000));
});

test('on the shipped table, no harness wins every request, and none wins by being measured on easy benchmarks only', () => {
  const s = createHarnessScorer(shipped);
  const cands = [
    { kind: 'claude', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
    { kind: 'codex', models: ['gpt-5.5', 'gpt-5.4-mini'] },
    { kind: 'acp:gemini', models: [] },
    { kind: 'acp:opencode', models: [] },
    { kind: 'acp:hermes', models: [] },
  ];
  const requests = ['Fix the failing unit test in src/parser.ts', 'Reproduce the results of this paper', 'hello'];
  const winners = requests.map((r) => s.score(r, cands, 0.12)[0].kind);
  assert.ok(new Set(winners).size > 1, winners.join());
  for (const r of requests) assert.notEqual(s.score(r, cands, 0.12)[0].kind, 'acp:opencode', r);
});

test('harnesses that score the same are ordered by kind', () => {
  const s = createHarnessScorer({
    benchmarks: ['a'],
    idf: {},
    centroids: {},
    results: { codex: { m: { a: [0.5, 2] } }, claude: { m: { a: [0.5, 2] } } },
  } as any);
  assert.deepEqual(
    s
      .score(
        'x',
        [
          { kind: 'codex', models: ['m'] },
          { kind: 'claude', models: ['m'] },
        ],
        0,
      )
      .map((r: any) => r.kind),
    ['claude', 'codex'],
  );
});

test('model names compare across spellings, and the shipped table is HM-Router’s', () => {
  assert.equal(normalize('GPT-5.5'), 'gpt-5-5');
  assert.equal(normalize('opus[1m]'), 'opus');
  assert.equal(normalize(undefined as any), '');
  assert.match(shipped.source.repository, /hmarkc\/HM-Router/);
  const s = createHarnessScorer(shipped);
  const ranked = s.score(
    'Fix the failing pytest in this repository',
    [
      { kind: 'claude', models: [] },
      { kind: 'codex', models: [] },
    ],
    0.12,
  );
  assert.equal(ranked.length, 2);
});

test('the build writes the table with the CSVs’ hashes, and refuses without a data folder', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { main } = await import('../scripts/build-hm-table.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'hm-table-'));
  try {
    writeFileSync(path.join(dir, 'hm_router_bench.csv'), bench);
    writeFileSync(path.join(dir, 'queries.csv'), queries);
    const out = path.join(dir, 'table.json');
    assert.equal(main([dir, '--commit', 'abc', '--out', out]), out);
    const t = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(t.source.commit, 'abc');
    assert.match(t.source.files['data/queries.csv'], /^sha256:[0-9a-f]{64}$/);
    main([dir, '--out', out]);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).source.commit, null);
    assert.throws(() => main([]), /Usage/);
    // without --out it writes the shipped table of the checkout it is given
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(dir, 'electron/autoRoute'), { recursive: true });
    assert.equal(main([dir], dir), path.join(dir, 'electron/autoRoute/hmTable.json'));
    assert.throws(() => main(['--out', out]), /Usage/);
    const run = spawnSync(process.execPath, ['scripts/build-hm-table.mjs'], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
