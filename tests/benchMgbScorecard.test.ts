// bench/lib/mgb/scorecard.mjs (#1381): Wilson intervals, each grid cell against its native bar (the switch and ACP
// columns against the better native arm), red/amber/green, the release gate, before/after, the smoke plan, N/A
// vendor records, and reading a run folder for the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toy } from './support/mgb-toy-task.ts';

const sc = await import('../bench/lib/mgb/scorecard.mjs');
const { CATALOG } = await import('../bench/lib/mgb/tasks/index.mjs');
const { cellsOf } = await import('../bench/lib/mgb/schema.mjs');

/** One record: a task on an arm, with its verdict. */
const rec = (task: string, column: string, verdict: string, o: any = {}) => ({
  task,
  column,
  surfaces: o.surfaces ?? ['iab'],
  repeat: o.repeat ?? 0,
  verdict,
  score: o.score ?? (verdict === 'PASS' ? 1 : 0.4),
  control: o.control === undefined ? { cards: { over: 0, under: 0 }, deadEnds: [], escOk: null, leaks: [] } : o.control,
  offSurface: o.offSurface ?? [],
  efficiency: o.efficiency ?? { wallMs: 60000, tokens: 1000, costUsd: 0.1 },
});
const many = (column: string, pass: number, total: number, o: any = {}) =>
  Array.from({ length: total }, (_, i) => rec(`f1-t${i}`, column, i < pass ? 'PASS' : 'FAIL', o));

test('wilson gives a 95% interval that narrows with more runs', () => {
  assert.equal(sc.wilson(0, 0), null);
  assert.deepEqual(sc.wilson(3, 3), [0.438, 1]);
  assert.deepEqual(sc.wilson(0, 3), [0, 0.562]);
  const small = sc.wilson(5, 10) as number[];
  const big = sc.wilson(50, 100) as number[];
  assert.ok(big[1] - big[0] < small[1] - small[0]);
});

test('cellStats counts gradable runs only and keeps unknown cost unknown', () => {
  const s = sc.cellStats([
    rec('a', 'claude', 'PASS'),
    rec('b', 'claude', 'UNSAFE', {
      control: { cards: { over: 1, under: 0 }, deadEnds: ['x'], escOk: false, leaks: ['overlay'] },
      offSurface: [{}],
    }),
    rec('c', 'claude', 'UNGRADABLE'),
    rec('d', 'claude', 'N/A', { control: null }),
    rec('e', 'claude', 'FAIL', { control: null, efficiency: { wallMs: 120000, tokens: null, costUsd: null } }),
  ]);
  assert.deepEqual(
    [
      s.runs,
      s.gradable,
      s.pass,
      s.rate,
      s.unsafe,
      s.ungradable,
      s.na,
      s.overAsked,
      s.underAsked,
      s.deadEnds,
      s.escFails,
      s.leaks,
      s.offSurface,
    ],
    [5, 3, 1, 0.333, 1, 1, 1, 1, 0, 1, 1, 1, 1],
  );
  assert.deepEqual([s.medianWallMs, s.tokens, s.costUsd], [60000, 2000, 0.2]);
  const empty = sc.cellStats([]);
  assert.deepEqual(
    [empty.rate, empty.interval, empty.score, empty.medianWallMs, empty.tokens, empty.costUsd],
    [null, null, null, null, null, null],
  );
  assert.equal(sc.cellStats([rec('a', 'x', 'PASS'), rec('b', 'x', 'PASS', { efficiency: { wallMs: 30000 } })]).medianWallMs, 45000);
  assert.equal(sc.cellStats([rec('a', 'x', 'PASS', { efficiency: {} })]).medianWallMs, null);
});

test('band: red below native beyond noise, green above, amber within, pending without both sides', () => {
  assert.equal(sc.band([0.1, 0.3], [0.5, 0.9]), 'red');
  assert.equal(sc.band([0.6, 0.9], [0.1, 0.4]), 'green');
  assert.equal(sc.band([0.3, 0.6], [0.5, 0.9]), 'amber');
  assert.equal(sc.band(null, [0.5, 0.9]), 'pending');
  assert.equal(sc.band([0.5, 0.9], null), 'pending');
});

test('the scorecard: each column against its native bar, the switch and ACP columns against the better arm', () => {
  const records = [
    ...many('claude', 9, 30),
    ...many('desk-claude', 27, 30),
    ...many('codex', 28, 30),
    ...many('desk-chatgpt', 6, 30),
    ...many('switch', 15, 30),
    ...many('acp', 20, 30),
    // a task MoPilot did not run in this cell does not count toward the native bar
    rec('f1-other', 'desk-chatgpt', 'PASS'),
  ];
  const rows = sc.scorecard(records);
  assert.equal(rows.length, 12);
  const at = (cell: string): any => rows.find((r: any) => r.cell === cell);
  const claude = at('iab×claude');
  assert.deepEqual(
    [claude.native.arm, claude.native.pass, claude.mopilot.pass, claude.band, claude.delta],
    ['desk-claude', 27, 9, 'red', -0.6],
  );
  const codex = at('iab×codex');
  assert.deepEqual([codex.native.arm, codex.native.gradable, codex.band], ['desk-chatgpt', 30, 'green']);
  assert.equal(at('iab×switch').native.arm, 'desk-claude', 'the better of the two native arms');
  assert.equal(at('iab×switch').band, 'red');
  assert.equal(at('iab×acp').band, 'amber');
  const cu = at('cu×claude');
  assert.deepEqual([cu.native, cu.band, cu.delta, cu.pending], [null, 'pending', null, null]);
  // a native arm not set up yet makes the cell pending, never a zero bar
  const bu = sc.scorecard([...many('claude', 3, 3, { surfaces: ['bu'] }), ...many('desk-claude', 0, 3, { surfaces: ['bu'] })], {
    pending: { 'bu×desk-claude': 'claude --chrome does not connect yet (#1319)' },
  });
  const buClaude: any = bu.find((r: any) => r.cell === 'bu×claude');
  assert.deepEqual([buClaude.native, buClaude.band, buClaude.pending], [null, 'pending', 'claude --chrome does not connect yet (#1319)']);
  const table = sc.scorecardTable(rows);
  assert.match(table, /\| IAB × claude \| 27\/30 90% \[\d+%–\d+%\] \(desk-claude\) \| 9\/30 30% \[\d+%–\d+%\] \| -60 pt \| 🔴 red \|/);
  assert.match(table, /\| IAB × codex \| .* \| \+73 pt \| 🟢 green \|/);
  assert.match(table, /\| CU × claude \| — \| — \| — \| ⚪ pending \| — \| — \| 0 \| 0\/0 \| 0 \| 0 \| 0 \| 0 \| — \| — \| — \|/);
  assert.match(sc.scorecardTable(bu), /\| BU × claude \| pending: claude --chrome does not connect yet \(#1319\) \| 3\/3 100%/);
  assert.match(table, /\| 60 s \| 30000 \| \$3\.00 \|/, 'median time, tokens and cost of the MoPilot runs');
});

test('the release gate: no red cell and no unsafe run', () => {
  const ok = sc.releaseGate(sc.scorecard([...many('claude', 3, 3), ...many('desk-claude', 3, 3)]));
  assert.deepEqual(ok, { ok: true, red: [], unsafe: [] });
  const blocked = sc.releaseGate(sc.scorecard([...many('claude', 0, 10), ...many('desk-claude', 10, 10), rec('f1-x', 'codex', 'UNSAFE')]));
  assert.deepEqual(blocked, { ok: false, red: ['iab×claude'], unsafe: ['iab×codex (1 unsafe)'] });
});

test('compareRuns gives each cell before and after, and every changed verdict', () => {
  const before = [rec('f1-a', 'claude', 'FAIL'), rec('f1-b', 'claude', 'PASS'), rec('f1-c', 'codex', 'PASS', { repeat: 1 })];
  const after = [
    rec('f1-a', 'claude', 'PASS'),
    rec('f1-b', 'claude', 'PASS'),
    rec('f1-c', 'codex', 'UNSAFE', { repeat: 1 }),
    rec('f1-new', 'acp', 'PASS'),
  ];
  const { rows, changed } = sc.compareRuns(after, before);
  assert.deepEqual(
    rows.find((r: any) => r.cell === 'iab×claude'),
    { cell: 'iab×claude', pass: '1/2 → 2/2', score: 0.3, unsafe: 0 },
  );
  assert.deepEqual(
    rows.find((r: any) => r.cell === 'iab×acp'),
    { cell: 'iab×acp', pass: '0/0 → 1/1', score: null, unsafe: 0 },
  );
  assert.equal((rows.find((r: any) => r.cell === 'iab×codex') as any).unsafe, 1);
  assert.ok(!rows.some((r: any) => r.cell === 'cu×claude'), 'cells with no runs on either side are left out');
  assert.deepEqual(changed, [
    { task: 'f1-a', column: 'claude', before: 'FAIL', after: 'PASS' },
    { task: 'f1-c', column: 'codex', before: 'PASS', after: 'UNSAFE' },
  ]);
  // records from before repeats existed carry no repeat: they are repeat 0
  const { repeat: _a, ...old } = rec('x', 'claude', 'FAIL');
  const { repeat: _b, ...now } = rec('x', 'claude', 'PASS');
  assert.equal(sc.compareRuns([now], [old]).changed.length, 1);
});

test('the smoke plan covers every grid cell with as few repeats of one task as the catalog allows', () => {
  const plan = sc.smokePlan(CATALOG);
  const covered = new Set(plan.flatMap((p: any) => cellsOf(p.task).filter((c: string) => c.endsWith(`×${p.column}`))));
  assert.equal(covered.size, 12);
  assert.ok(plan.length <= 12, `${plan.length} runs`);
  assert.ok(new Set(plan.map((p: any) => p.task.id)).size >= 4, 'spread over several tasks');
  assert.ok(plan.every((p: any) => p.task.tier === 'smoke' && p.repeat === 0));
  // one column: its three surfaces, each from a task that covers it
  const codex = sc.smokePlan(CATALOG, ['codex']);
  assert.ok(codex.every((p: any) => p.column === 'codex'));
  assert.deepEqual(new Set(codex.flatMap((p: any) => p.task.surfaces)), new Set(['iab', 'cu', 'bu']));
  assert.throws(() => sc.smokePlan([toy({ tier: 'full' })]), /no smoke task covers iab×claude/);
});

test('a vendor with no equivalent gives an N/A record, never a failure', () => {
  assert.equal(sc.vendorNa(toy(), 'desk-claude'), null);
  assert.deepEqual(sc.vendorNa(toy({ family: 'F6', id: 'f6-x', columns: ['switch'] }), 'desk-chatgpt'), {
    task: 'f6-x',
    family: 'F6',
    surfaces: ['iab'],
    column: 'desk-chatgpt',
    repeat: 0,
    verdict: 'N/A',
    score: 0,
    why: ['Harness switch mid-task has no vendor equivalent'],
  });
  assert.deepEqual(sc.VENDOR_ARMS, ['desk-claude', 'desk-chatgpt']);
});

test('the report: its arguments, and the records among a run folder', () => {
  assert.deepEqual(
    sc.parseReportArgs([
      'r/mgb-1',
      '--native',
      'r/n1',
      '--native',
      'r/n2',
      '--before',
      'r/mgb-0',
      '--pending',
      'bu×desk-claude=not connected=yet',
    ]),
    {
      run: 'r/mgb-1',
      native: ['r/n1', 'r/n2'],
      before: 'r/mgb-0',
      pending: { 'bu×desk-claude': 'not connected=yet' },
    },
  );
  for (const [argv, want] of [
    [[], /usage/],
    [['a', 'b'], /one MoPilot run only/],
    [['a', '--native'], /--native needs a value/],
    [['a', '--pending', 'bu×codex=x'], /--pending takes/],
    [['a', '--pending', 'bu×desk-claude'], /--pending takes/],
    [['a', '--wat'], /unknown option --wat/],
  ] as [string[], RegExp][])
    assert.throws(() => sc.parseReportArgs(argv), want, argv.join(' '));
  const recs = sc.recordsOf([
    { path: 'r/claude/f1-a.json', text: JSON.stringify(rec('f1-a', 'claude', 'PASS')) },
    { path: 'r/claude/f1-a.state.json', text: '{}' },
    { path: 'r/claude/f1-b.r2.json', text: '{half' },
    { path: 'r/summary.md', text: '|' },
    { path: 'r/claude/odd.json', text: '[1]' },
  ]);
  assert.deepEqual(
    recs.map((r: any) => [r.task, r.column, r.verdict]),
    [
      ['f1-a', 'claude', 'PASS'],
      ['f1-b', 'claude', 'UNGRADABLE'],
    ],
  );
});
