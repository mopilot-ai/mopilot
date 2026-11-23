// MGB task f6-cross-surface-switch (#1381): beside the audit (benchMgbAudit.test.ts), four of six vendors fit the brief, and
// plausible wrong handoffs (the new harness requesting the first two quotes again, the second half never done, the
// first half's rows lost from the CSV, requests without the reference, a misplaced total line) do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { quoteCents } = await import('../bench/lib/mgb/apps/vendors.mjs');
const { putFile } = await import('../bench/lib/mgb/tasks/f2Common.mjs');
const { requestFor } = await import('../bench/lib/mgb/tasks/f2QuoteForms.mjs');
const { CSV, FIRST, csvText, fits, request, rowFor, task } = await import('../bench/lib/mgb/tasks/f6CrossSurfaceSwitch.mjs');

const setup = (seed = 's1') => setupTask(task, seed);
const grade = ({ env, data, state }: any) => gradeTask({ task, data, state, env });
const firstTwo = (data: any) => fits(data).slice(0, FIRST);
const rest = (data: any) => fits(data).slice(FIRST);
const sum = (quotes: any[]) => quotes.reduce((t, q) => t + q.quotedCents, 0);
/** Writes the CSV from these quotes, with a total line of `total` cents when given. */
const writeCsv = (s: any, quotes: any[], total?: number) =>
  putFile(
    s.state,
    CSV,
    Buffer.from(
      csvText(
        quotes.map((q) => rowFor(s.data, q)),
        total,
      ),
      'utf8',
    ),
  );
/** The part before the switch: the first two requests and a CSV with their rows. */
const beforeSwitch = (s: any) => {
  request(s.data, s.state, firstTwo(s.data));
  writeCsv(s, s.state.vendors.quotes);
};

test('f6-cross-surface-switch runs only in the switch column', () => {
  assert.deepEqual(task.columns, ['switch']);
  assert.deepEqual(task.surfaces, ['iab', 'cu']);
  const { data, env } = setup();
  assert.ok(task.prompt(data, env).length > (task.switchBefore ?? 1));
});

test('the data: four vendors fit in directory order, one misses on seats and one on SSO', () => {
  for (let n = 0; n < 8; n++) {
    const { data } = setup(`vendors-${n}`);
    const fitting = data.vendors.filter((v: any) => v.sso && v.plans.some((p: any) => p.seatsIncluded >= data.seats));
    assert.deepEqual(fitting, fits(data));
    assert.equal(fitting.length, 4);
    assert.deepEqual(
      data.vendors
        .filter((v: any) => !fitting.includes(v))
        .map((v: any) => v.kind)
        .sort(),
      ['nosso', 'small'],
    );
    for (const v of fitting) assert.equal(v.expected, v.plans[1].name, 'the middle plan is the cheapest fit');
  }
});

test('the oracle requests two quotes, then two more, and its CSV ends with the total', () => {
  const s = setup('s2');
  task.solve(s.data, s.state, s.env);
  assert.equal(grade(s).verdict, 'PASS');
  const quotes = s.state.vendors.quotes;
  assert.deepEqual(
    quotes.map((q: any) => q.vendor),
    fits(s.data).map((v: any) => v.slug),
  );
  for (const q of quotes) {
    const v = fits(s.data).find((x: any) => x.slug === q.vendor);
    assert.equal(
      q.quotedCents,
      quoteCents(
        v.plans.find((p: any) => p.name === v.expected),
        s.data.seats,
        s.data.billing,
      ),
    );
  }
  assert.match(s.state.files.entries[CSV].text, new RegExp(`\\nTotal,,,,,${(sum(quotes) / 100).toFixed(2)}$`));
});

test('a harness that requests the first two quotes again after the switch', () => {
  const s = setup();
  beforeSwitch(s);
  request(s.data, s.state, fits(s.data));
  // the CSV faithfully lists every request, duplicates included
  writeCsv(s, s.state.vendors.quotes, sum(s.state.vendors.quotes));
  const g = grade(s);
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['quote-0', 'quote-1']);
});

test('a handoff where the second half is never done', () => {
  const s = setup('s3');
  beforeSwitch(s);
  const g = grade(s);
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['quote-2', 'quote-3', 'csv-total', 'quote-ref']);
});

test('a handoff that loses the first half’s rows: the new harness writes the CSV from its own quotes', () => {
  const s = setup('s4');
  beforeSwitch(s);
  request(s.data, s.state, rest(s.data));
  const mine = s.state.vendors.quotes.slice(FIRST);
  writeCsv(s, mine, sum(mine));
  const g = grade(s);
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['csv-rows', 'csv-total']);
});

test('requests without the reference before the switch, and a total line out of place', () => {
  {
    const s = setup('s5');
    const site = browse(s.state, 'vendors');
    for (const v of firstTwo(s.data)) site.post(`/v/${v.slug}/contact`, { ...requestFor(s.data, v), message: 'Please quote.' });
    request(s.data, s.state, rest(s.data));
    writeCsv(s, s.state.vendors.quotes, sum(s.state.vendors.quotes));
    assert.deepEqual(unmet(grade(s)), ['quote-ref']);
  }
  {
    // the total line written before the second half's rows
    const s = setup('s6');
    beforeSwitch(s);
    request(s.data, s.state, rest(s.data));
    const [a, b, c, d] = s.state.vendors.quotes.map((q: any) => rowFor(s.data, q));
    const text = csvText([a, b, `Total,,,,,${(sum(s.state.vendors.quotes) / 100).toFixed(2)}`, c, d]);
    putFile(s.state, CSV, Buffer.from(text, 'utf8'));
    assert.deepEqual(unmet(grade(s)), ['csv-total']);
  }
  {
    // a vendor without a fitting plan asked too, and the CSV written with a header of its own
    const s = setup('s7');
    task.solve(s.data, s.state, s.env);
    const misfit = s.data.vendors.find((v: any) => v.kind === 'nosso');
    browse(s.state, 'vendors').post(`/v/${misfit.slug}/contact`, { ...requestFor(s.data, misfit), plan: misfit.plans[1].name });
    putFile(s.state, CSV, Buffer.from('Vendor,Plan,Total\n', 'utf8'));
    assert.deepEqual(unmet(grade(s)), ['no-misfit', 'csv-file', 'csv-rows', 'csv-total']);
  }
});
