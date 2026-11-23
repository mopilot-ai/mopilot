// bench/lib/mgb run.mjs and files.mjs (#1381): run arguments, columns and plans, each run's environment, the request
// ledger's tokens and cost, Esc timing, the record and summary, and the task folder as the `files` source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { toy } from './support/mgb-toy-task.ts';

const run = await import('../bench/lib/mgb/run.mjs');
const files = await import('../bench/lib/mgb/files.mjs');
const { pdfDoc } = await import('../bench/lib/edgePages.mjs');
const {
  MGB_COLUMNS,
  ESC_FALLBACK_MS,
  chromeMarkError,
  chromeMarkUrl,
  errorText,
  escDue,
  vendorSetupError,
  resultName,
  ledgerUsage,
  mgbRecord,
  mgbTable,
  parseMgbArgs,
  planRuns,
  prepareRun,
  runEnv,
  runTag,
  usageCost,
} = run;

const catalog = [toy(), toy({ id: 'f1-toy-two', tier: 'full', columns: ['claude', 'codex'] })];
const clock = () => new Date('2026-10-19T08:00:00Z');

test("parseMgbArgs: today defaults to the machine's own date, which the model reads, not UTC's (G4: a run after UTC midnight)", () => {
  // 03:00 UTC on the 9th is still the 8th in Pacific time: the runner's tasks are made for "today" and the model reads the
  // machine's clock, so the two must agree or a "this week" task grades against another week (#4268's pair: week 45 vs 46)
  const night = () => new Date('2026-11-09T03:00:00Z');
  const here = (d: Date) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  assert.equal(parseMgbArgs([], catalog, night).today, here(night()));
  // an explicit --today is taken as it is
  assert.equal(parseMgbArgs(['--today', '2026-11-09'], catalog, night).today, '2026-11-09');
});

test("todayFor: each column's fixtures use the date its model reads (Codex: GMT; others: the machine's), an explicit --today for all", () => {
  // 03:00 UTC on the 9th is still the 8th on the machine in Pacific time; Codex's environment context says GMT (the 9th)
  const night = () => new Date('2026-11-09T03:00:00Z');
  const here = (d: Date) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  const cfg = parseMgbArgs([], catalog, night);
  assert.equal(run.todayFor(cfg, 'codex'), '2026-11-09');
  for (const c of ['claude', 'switch', 'acp']) assert.equal(run.todayFor(cfg, c), here(night()), c);
  const set = parseMgbArgs(['--today', '2026-11-03'], catalog, night);
  for (const c of ['codex', 'claude']) assert.equal(run.todayFor(set, c), '2026-11-03', c);
});

test('parseMgbArgs: defaults, tiers, columns, models and every refusal', () => {
  const d = parseMgbArgs([], catalog, clock);
  assert.deepEqual(
    [d.tier, d.tasks.map((t: any) => t.id), d.columns, d.run, d.seed, d.today, d.port, d.timeoutS, d.repeats, d.skipChrome, d.prices],
    ['smoke', ['f1-toy-reconcile'], ['claude', 'codex', 'switch', 'acp'], 'mgb', 'mgb', '2026-10-19', 8820, 900, 1, false, ''],
  );
  assert.match(d.resultsDir, /bench\/results\/mgb$/);
  assert.deepEqual(d.cells, MGB_COLUMNS);
  assert.notEqual(d.cells, MGB_COLUMNS, 'a copy: overrides never change the defaults');
  const full = parseMgbArgs(
    [
      '--tier',
      'full',
      '--columns',
      'codex',
      '--run',
      'r1',
      '--seed',
      's',
      '--today',
      '2026-11-02',
      '--port',
      '9000',
      '--timeout',
      '60',
      '--repeats',
      '3',
      '--skip-chrome',
      '--prices',
      'p.json',
      '--results',
      '/tmp/r',
    ],
    catalog,
    clock,
  );
  assert.deepEqual(
    [
      full.tasks.length,
      full.columns,
      full.seed,
      full.today,
      full.port,
      full.timeoutS,
      full.repeats,
      full.skipChrome,
      full.prices,
      full.resultsDir,
    ],
    [2, ['codex'], 's', '2026-11-02', 9000, 60, 3, true, 'p.json', '/tmp/r/r1'],
  );
  assert.deepEqual(
    parseMgbArgs(['--tasks', 'f1-toy-two'], catalog, clock).tasks.map((t: any) => t.id),
    ['f1-toy-two'],
  );
  const m = parseMgbArgs(
    ['--model-claude', 'Haiku 5.5', '--model-codex', 'GPT-6 Sol', '--model-acp', 'OpenCode/Beam'],
    catalog,
    clock,
  ).cells;
  assert.deepEqual(
    [m.claude.model, m.switch.model, m.codex.model, m.switch.switchModel, m.acp.model],
    ['Haiku 5.5', 'Haiku 5.5', 'GPT-6 Sol', 'GPT-6 Sol', 'OpenCode/Beam'],
  );
  assert.equal(parseMgbArgs([], catalog).today.length, 10, 'today from the real clock');
  const bad: [string[], RegExp][] = [
    [['--nope'], /Unknown option/],
    [['--tier', 'nightly'], /--tier must be/],
    [['--columns', ' , '], /names no column/],
    [['--columns', 'gemini'], /unknown column gemini/],
    [['--tasks', 'f9-x'], /unknown task f9-x/],
    [['--run', '..'], /--run must be a plain name/],
    [['--today', '19/10/2026'], /--today must be/],
    [['--port', '80'], /--port must be/],
    [['--port', 'x'], /--port must be/],
    [['--timeout', '0'], /--timeout must be/],
    [['--repeats', '0'], /--repeats must be/],
    [['--repeats', '11'], /--repeats must be/],
  ];
  for (const [argv, want] of bad)
    assert.throws(
      () => parseMgbArgs(argv, catalog, clock),
      (e: any) => want.test(e.message) && /usage:/.test(e.message),
      argv.join(' '),
    );
});

test('planRuns, tags, environments and preparing a run', () => {
  const plan = planRuns(catalog, ['codex', 'switch']);
  assert.deepEqual(
    plan.map((p: any) => `${p.task.id}:${p.column}`),
    ['f1-toy-reconcile:codex', 'f1-toy-reconcile:switch', 'f1-toy-two:codex'],
  );
  assert.deepEqual(
    planRuns([toy()], ['claude'], 3).map((p: any) => p.repeat),
    [0, 1, 2],
  );
  assert.deepEqual([resultName('f1-a', 0), resultName('f1-a', 2)], ['f1-a', 'f1-a.r3']);
  assert.equal(runTag('f1-a', 'codex', 36 ** 3), 'f1-a.codex.1000');
  assert.match(runTag('f1-a', 'acp'), /^f1-a\.acp\.[0-9a-z]+$/);
  const env = runEnv({ seed: 'run-1', today: '2026-10-19', port: 8820 }, toy(), 'tag-1', '/Users/x/mgb-files', 120);
  assert.deepEqual(env, {
    runSeed: 'run-1',
    today: '2026-10-19',
    urls: { mail: 'http://mail.localhost:8820/', tracker: 'http://tracker.localhost:8820/' },
    files: '/Users/x/mgb-files/tag-1',
    tz: 120,
  });
  assert.equal(
    runEnv({ seed: 's', today: '2026-10-19', port: 1 }, toy(), 't', '/f').tz,
    -new Date().getTimezoneOffset(),
    "the Mac's own clock",
  );
  const a = prepareRun(toy(), env);
  const b = prepareRun(toy(), env);
  assert.deepEqual(a, b, 'every column of a run sees the same data');
  assert.equal(a.prompts.length, 2);
  assert.deepEqual(Object.keys(a.fixtures), ['mail', 'tracker']);
});

test('ledgerUsage sums a turn per model; usageCost needs a price for every model', () => {
  const t = (s: number) => new Date(Date.parse('2026-10-19T10:00:00Z') + s * 1000).toISOString();
  const lines = [
    { t: t(-5), served: 'claude-sonnet-5-5', in: 999 },
    { t: t(1), served: 'claude-sonnet-5-5', in: 1000, out: 200, cacheRead: 5000, cacheWrite: 100, reasoning: 50, chat: 'c1' },
    { t: t(2), served: 'claude-sonnet-5-5', in: 10, out: 'x' },
    { t: t(3), served: 'gpt-6-luna', in: 300, out: 30, chat: 'c2' },
    { t: t(4), in: 7 },
    // Codex names the model that answered only when it reroutes: the one asked for counts
    { t: t(5), req: 'gpt-6-luna', in: 2, chat: 'c2' },
    { t: 'nope', in: 1 },
    null,
  ];
  const from = Date.parse(t(0));
  const to = Date.parse(t(10));
  const u = ledgerUsage(lines, { from, to }) as any;
  assert.equal(u.requests, 5);
  assert.deepEqual(u.byModel['claude-sonnet-5-5'], { in: 1010, out: 200, cacheRead: 5000, cacheWrite: 100, reasoning: 50 });
  assert.deepEqual(u.byModel['gpt-6-luna'], { in: 302, out: 30, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  assert.deepEqual(u.byModel['?'], { in: 7, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  assert.equal(u.tokens, 1010 + 200 + 5000 + 100 + 330 + 7 + 2);
  assert.equal(ledgerUsage(lines, { from, to, chat: 'c1' })?.requests, 3, 'lines of another chat are left out; lines naming none stay');
  assert.equal(ledgerUsage(lines, { from: to, to: to + 1 }), null, 'no line is unknown, never zero');
  const prices = {
    'claude-sonnet-5-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'gpt-6-luna': { in: 1, out: 4 },
    '?': { in: 0, out: 0 },
  };
  assert.equal(
    usageCost(u, prices),
    Math.round(((1010 * 3 + 200 * 15 + 5000 * 0.3 + 100 * 3.75 + 300 * 1 + 30 * 4) / 1e6) * 10000) / 10000,
  );
  assert.equal(usageCost(u, { 'claude-sonnet-5-5': prices['claude-sonnet-5-5'] }), null, 'an unpriced model is not free');
  assert.equal(usageCost(null, prices), null);
  assert.equal(
    usageCost(ledgerUsage([{ t: t(1), served: 'gpt-6-luna', in: 100, cacheRead: 100, cacheWrite: 100 }], { from, to }), prices),
    0.0003,
    'cache prices default to the input price',
  );
});

test('chromeMarkUrl and chromeMarkError: one tab marks every app; a browser-use plan needs every mark', () => {
  assert.equal(chromeMarkUrl(8820, 'm1', ['mail', 'crm', 'shop']), 'http://mail.localhost:8820/__mgb/mark?k=m1&next=crm,shop');
  assert.equal(chromeMarkUrl(8820, 'm1', ['mail']), 'http://mail.localhost:8820/__mgb/mark?k=m1');
  const iab = { task: { id: 'f1-a', surfaces: ['iab'] } };
  const bu = { task: { id: 'f3-b', surfaces: ['bu', 'cu'] } };
  assert.equal(chromeMarkError([iab, bu, bu], ['mail', 'crm'], ['crm', 'mail']), null, 'all marked');
  assert.equal(chromeMarkError([iab], ['mail', 'crm'], []), null, 'no browser-use task needs it');
  assert.equal(
    chromeMarkError([iab, bu, bu], ['mail', 'crm'], ['mail']),
    "the user's Chrome carries no bench mark on crm, so f3-b cannot tell it from the in-app browser: check the Chrome profile, or run with --skip-chrome",
  );
});

test('errorText: the message with each cause, its code first, at most four deep', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8820'), { code: 'ECONNREFUSED' });
  assert.equal(
    errorText(new TypeError('fetch failed', { cause: refused })),
    'fetch failed <- ECONNREFUSED connect ECONNREFUSED 127.0.0.1:8820',
  );
  assert.equal(errorText(new Error('x', { cause: 'plain reason' })), 'x <- plain reason');
  assert.equal(errorText('thrown text'), 'thrown text');
  const deep = [1, 2, 3, 4, 5].reduceRight((c: unknown, n) => new Error(`e${n}`, { cause: c }), undefined);
  assert.equal(errorText(deep), 'e1 <- e2 <- e3 <- e4');
});

test("vendorSetupError: a native run counts only in its arm's permission mode", () => {
  const claude = { app: 'Claude', permission: 'auto' };
  assert.equal(vendorSetupError(claude, { permission: 'auto' }), null);
  assert.equal(
    vendorSetupError(claude, { permission: 'default' }),
    'Claude ran in permission mode default, not auto: set it in the app and rerun',
  );
  assert.match(String(vendorSetupError(claude, { permission: null })), /permission mode \(unknown\), not auto/);
  assert.match(String(vendorSetupError(claude, null)), /\(unknown\)/);
  assert.match(String(vendorSetupError(claude, undefined)), /\(unknown\)/);
  // an arm with no agreed mode is not checked
  assert.equal(vendorSetupError({ app: 'Other' }, { permission: 'default' }), null);
});

test('escDue: once, after the named event, or 20 s into the last message', () => {
  const base = { state: {}, message: 1, messages: 2, messageStartedAt: 0, now: ESC_FALLBACK_MS };
  assert.equal(escDue(toy(), base), false, 'no Esc step');
  const timed = toy({ escape: { budgetMs: 2000 } });
  assert.equal(escDue(timed, base), true);
  assert.equal(escDue(timed, { ...base, escAt: 5 }), false, 'only once');
  assert.equal(escDue(timed, { ...base, now: ESC_FALLBACK_MS - 1 }), false);
  assert.equal(escDue(timed, { ...base, message: 0 }), false, 'not before the last message');
  const after = toy({ escape: { budgetMs: 2000, after: { app: 'mail', event: 'sent' } } });
  assert.equal(escDue(after, { ...base, now: 0 }), false);
  assert.equal(escDue(after, { ...base, now: 0, state: { mail: { events: [{ type: 'opened' }] } } }), false);
  assert.equal(escDue(after, { ...base, now: 0, message: 0, state: { mail: { events: [{ type: 'sent' }] } } }), true);
});

test('mgbRecord keeps the grade, the turn and the cost; mgbTable sums each column', () => {
  const grade = {
    verdict: 'PASS',
    success: true,
    score: 1,
    why: [],
    checkpoints: [],
    violations: [],
    control: null,
    efficiency: { wallMs: 5, steps: 3, tokens: null, costUsd: null },
  };
  const cfg = { run: 'r', seed: 's', today: '2026-10-19' };
  const r = mgbRecord({
    task: toy(),
    column: 'switch',
    cell: MGB_COLUMNS.switch,
    cfg,
    tag: 't',
    grade,
    turn: { model: 'Sonnet 5.5', answer: 'x'.repeat(5000), approvals: 1, answers: ['read-only'] },
    offSurface: [],
    usage: { requests: 1, tokens: 99, byModel: {} },
    costUsd: 0.01,
  });
  assert.deepEqual(
    [r.task, r.family, r.harness, r.model, r.verdict, r.answer.length],
    ['f1-toy-reconcile', 'F1', 'Claude Code → Codex', 'Sonnet 5.5', 'PASS', 4000],
  );
  assert.deepEqual(r.efficiency, { wallMs: 5, steps: 3, tokens: 99, costUsd: 0.01 });
  assert.deepEqual(r.turn, {
    approvals: 1,
    approvalLog: [],
    askLog: [],
    answers: ['read-only'],
    strips: [],
    switch: null,
    offered: [],
    error: null,
    timedOut: false,
    setup: null,
    archived: null,
  });
  const r2 = mgbRecord({
    task: toy(),
    column: 'codex',
    cell: MGB_COLUMNS.codex,
    cfg,
    tag: 't',
    grade: { ...grade, verdict: 'FAIL', score: 0.5 },
    turn: { driverError: true, error: 'no home view', timedOut: true },
    offSurface: [{ app: 'mail', type: 'sent', via: 'script' }],
    usage: null,
    costUsd: null,
  });
  assert.deepEqual(
    [r2.harness, r2.model, r2.answer, r2.efficiency.tokens, r2.turn.error, r2.turn.timedOut],
    ['Codex', null, '', null, 'no home view', true],
  );
  assert.equal(r.repeat, 0);
  // a native arm: the model and setup its transcript recorded
  const setup = { permission: 'auto', model: 'claude-sonnet-5-5', effort: null };
  const native = mgbRecord({
    task: toy(),
    column: 'desk-claude',
    cell: { harness: 'Claude', userData: '' },
    cfg,
    tag: 't',
    grade,
    turn: { setup, archived: true },
    offSurface: [],
    usage: null,
    costUsd: null,
  });
  assert.deepEqual([native.harness, native.model, native.turn.setup, native.turn.archived], ['Claude', 'claude-sonnet-5-5', setup, true]);
  const table = mgbTable([r, r2, { ...r2, task: 'f1-other', column: 'switch' }], ['codex', 'switch', 'acp']);
  assert.match(table, /\| f1-toy-reconcile \| FAIL 50% ⚠ \| PASS 100% \| — \|/);
  assert.match(table, /\| \*\*Total\*\* \| 0\/1 pass \| 1\/2 pass \| 0\/0 pass \|/);
  const reps = mgbTable([r, { ...r, repeat: 1, verdict: 'UNSAFE', score: 0.5 }, { ...r, repeat: 2, offSurface: [{}] }], ['switch']);
  assert.match(reps, /\| f1-toy-reconcile \| 2\/3 PASS 83% UNSAFE ⚠ \|/);
  assert.match(mgbTable([r, { ...r, repeat: 1 }], ['switch']), /\| 2\/2 PASS 100% \|/);
});

test('files: text, PDF text (plain and compressed), seeded folders and safe paths', () => {
  const t = files.describeFile('notes.md', Buffer.from('# Hi'));
  assert.equal(t.text, '# Hi');
  assert.equal(t.size, 4);
  assert.match(t.sha256, /^[0-9a-f]{64}$/);
  const pdf = files.describeFile('signed copy.PDF', Buffer.from(pdfDoc(['Confirmation: ONB-12AB', 'Name (x)']), 'latin1'));
  assert.match(pdf.pdfText ?? '', /Confirmation: ONB-12AB\nName \(x\)/);
  assert.equal(files.describeFile('a.bin', Buffer.from([1, 2])).text, undefined);
  const stream = 'BT [(Total ) -20 (42.00)] TJ ET BT (line\\nbreak) Tj ET';
  const z = deflateSync(Buffer.from(stream, 'latin1'));
  const compressed = Buffer.concat([
    Buffer.from('%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode /Length 9 >>\nstream\n', 'latin1'),
    z,
    Buffer.from('\nendstream\n', 'latin1'),
  ]);
  assert.equal(files.pdfText(compressed), 'Total 42.00\nline\nbreak');
  const broken = Buffer.from('%PDF-1.7\n<< /Filter /FlateDecode >>\nstream\nnot zlib\nendstream\n', 'latin1');
  assert.equal(files.pdfText(broken), '');
  const seeded = files.initFiles({
    entries: { 'in/ledger.csv': { text: 'a,b' }, 'logo.png': { base64: Buffer.from([7]).toString('base64') }, 'empty.txt': {} },
  });
  assert.deepEqual(Object.keys(seeded.entries), ['in/ledger.csv', 'logo.png', 'empty.txt']);
  assert.deepEqual(
    [seeded.entries['in/ledger.csv'].text, seeded.entries['logo.png'].size, seeded.entries['empty.txt'].text],
    ['a,b', 1, ''],
  );
  assert.deepEqual(files.initFiles(undefined), { entries: {} });
  assert.throws(() => files.initFiles({ entries: [] }), /entries object/);
  assert.throws(() => files.initFiles({ entries: { '../x': { text: '' } } }), /leaves the task folder/);
  for (const p of ['/etc/x', 'a//b', './a', 'a/..', '']) assert.equal(files.safePath(p), false, p);
  assert.equal(files.safePath('a/b.c'), true);
  assert.deepEqual(
    files.named(seeded, 'LEDGER.csv').map((e: any) => e.path),
    ['in/ledger.csv'],
  );
  assert.deepEqual(files.named(undefined, 'x'), []);
});

test('native arms: --arm, the prompts they get, and what each kind of run plans', async () => {
  const { CATALOG } = await import('../bench/lib/mgb/tasks/index.mjs');
  const { armPrompts, runPlan } = run;
  assert.deepEqual(armPrompts(['Use the in-app browser. Open it in the In-app browser.', 'Then in-app browser again'], 'f1-a.claude.1'), [
    'Use your built-in browser. Open it in your built-in browser.\n\n(Run f1-a.claude.1.)',
    'Then built-in browser again',
  ]);
  assert.throws(() => parseMgbArgs(['--arm', 'desk-gemini'], CATALOG, clock), /--arm must be mopilot or desk-claude, desk-chatgpt/);
  const native = parseMgbArgs(['--arm', 'desk-chatgpt', '--tier', 'full', '--repeats', '2'], CATALOG, clock);
  const np = runPlan(native, CATALOG);
  assert.equal(np.length, CATALOG.length * 2);
  assert.ok(np.every((p: any) => p.column === 'desk-chatgpt'));
  // the MoPilot smoke tier is one run per grid cell; naming tasks runs them on each of their columns
  const smoke = runPlan(parseMgbArgs([], CATALOG, clock), CATALOG);
  assert.ok(smoke.length <= 12 && smoke.length >= 4);
  const named = runPlan(parseMgbArgs(['--tasks', 'f1-invoice-reconcile', '--columns', 'claude,codex'], CATALOG, clock), CATALOG);
  assert.deepEqual(
    named.map((p: any) => p.column),
    ['claude', 'codex'],
  );
  // a VM whose Chrome is busy leaves browser-use tasks out
  const noChrome = runPlan(parseMgbArgs(['--tier', 'full', '--skip-chrome'], CATALOG, clock), CATALOG);
  assert.ok(noChrome.length > 0 && noChrome.every((p: any) => !p.task.surfaces.includes('bu')));
  assert.ok(runPlan(parseMgbArgs(['--skip-chrome'], CATALOG, clock), CATALOG).every((p: any) => !p.task.surfaces.includes('bu')));
  assert.ok(
    runPlan(parseMgbArgs(['--arm', 'desk-claude', '--skip-chrome'], CATALOG, clock), CATALOG).every(
      (p: any) => !p.task.surfaces.includes('bu'),
    ),
  );
});

test('--ports moves columns onto other instances; the switch cell follows Claude Code unless named', () => {
  const p = parseMgbArgs(['--ports', 'claude=9401,codex=9402'], catalog, clock).cells;
  assert.deepEqual([p.claude.port, p.switch.port, p.codex.port, p.acp.port], ['9401', '9401', '9402', '9383']);
  assert.equal(parseMgbArgs(['--ports', 'switch=9500,claude=9401'], catalog, clock).cells.switch.port, '9500');
  for (const bad of ['claude', 'gemini=9401', 'claude=x', 'claude=12'])
    assert.throws(() => parseMgbArgs(['--ports', bad], catalog, clock), /--ports takes/, bad);
});
