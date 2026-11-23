// MGB task f5-vendor-shortlist (#1381): audited on every seed; every vendor but one misses a requirement and all but one
// of those are cheaper; the shortlist lines are read the way a person writes them; and plausible wrong agents fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { quoteCents } = await import('../bench/lib/mgb/apps/vendors.mjs');
const { putFile } = await import('../bench/lib/mgb/tasks/f2Common.mjs');
const { FILE, MIN_RATING, MIN_RETENTION, PAGES, areaOf, bestPlans, lineOk, requestFor, shortlistFor, task } = await import(
  '../bench/lib/mgb/tasks/f5VendorShortlist.mjs'
);

const setup = (seed = 's1') => setupTask(task, seed);
const role = (data: any, r: string) => data.vendors.find((v: any) => v.role === r);
const avg = (v: any) => v.ratings.reduce((a: number, b: number) => a + b, 0) / v.ratings.length;
/** Reads every page in the in-app browser, writes the shortlist and requests a quote: each step can be changed. */
function agent(data: any, state: any, o: { text?: (t: string) => string; quoteAt?: any; plan?: string; browser?: string } = {}) {
  const site = browse(state, 'vendors');
  for (const v of data.vendors) for (const p of PAGES) site.get(`/v/${v.slug}/${p}`);
  for (const e of state.vendors.events) Object.assign(e, { via: 'browser', browser: 'app-browser' });
  putFile(state, FILE, Buffer.from((o.text ?? ((t: string) => t))(shortlistFor(data)), 'utf8'));
  const v = o.quoteAt ?? data.right;
  site.post(`/v/${v.slug}/contact`, { ...requestFor(data), plan: o.plan ?? v.best[0] });
  const quoted = state.vendors.events.at(-1);
  Object.assign(quoted, { via: 'browser', browser: o.browser ?? 'chrome' });
  return state;
}

test('f5-vendor-shortlist is a smoke task on every surface', () => {
  assert.equal(task.tier, 'smoke');
  assert.deepEqual(task.surfaces, ['iab', 'cu', 'bu']);
});

test('the data: one vendor meets everything, the misses are cheaper but one, and costs follow the site’s quotes', () => {
  for (const seed of ['s1', 's2', 's3', 's4']) {
    const { data } = setup(seed);
    const right = data.right;
    assert.equal(right.role, 'right');
    const meets = (v: any) => v.sso && areaOf(v.region) === 'EU' && v.retention >= MIN_RETENTION && avg(v) >= MIN_RATING;
    assert.deepEqual(
      data.vendors.filter(meets).map((v: any) => v.slug),
      [right.slug],
    );
    for (const v of data.vendors) {
      const costs = v.plans.map((p: any) => quoteCents(p, data.seats, 'monthly'));
      assert.equal(Math.min(...costs), v.cost, v.role);
      assert.ok(
        v.plans.every((p: any) => p.monthlyCents >= 0),
        'no negative price',
      );
      if (v.role === 'retention') assert.ok(v.cost > right.cost);
      else if (v.role !== 'right') assert.ok(v.cost < right.cost, `${v.role} is cheaper`);
    }
    assert.ok(avg(role(data, 'rating')) < 3.95, 'the low average shows below 4.0');
  }
});

test('bestPlans keeps every plan that ties for the lowest quote', () => {
  const plans = [
    { name: 'A', monthlyCents: 1000, annualCents: 900, seatsIncluded: 1, extraSeatCents: 100 },
    { name: 'B', monthlyCents: 1100, annualCents: 900, seatsIncluded: 2, extraSeatCents: 100 },
    { name: 'C', monthlyCents: 5000, annualCents: 900, seatsIncluded: 9, extraSeatCents: 100 },
  ];
  assert.deepEqual(bestPlans(plans, 3), ['A', 'B']);
  assert.deepEqual(bestPlans(plans, 1), ['A']);
});

test('shortlist lines: any order and spacing, money written either way, and each field matters', () => {
  const { data } = setup();
  const v = { name: 'Harbor Labs', best: ['Team'], cost: 123400, sso: false, region: 'UK (London)' };
  assert.ok(lineOk('Harbor Labs - team plan, 1234 USD/month, SSO: no, region UK', v));
  assert.ok(lineOk('Recommended: Harbor Labs\nharbor labs | Team | $1,234.00 | No | UK (London)', v), 'skips the recommendation');
  assert.ok(!lineOk('Harbor Labs | Team | $1,234.00 | yes | UK', v), 'SSO says yes');
  assert.ok(!lineOk('Harbor Labs | Team | $1,234.00 | yes, no | UK', v), 'SSO says both');
  assert.ok(!lineOk('Harbor Labs | Team | $1,234.00 | no | Europe', v), 'no region area');
  assert.ok(!lineOk('Harbor Labs | Scale | $1,234.00 | no | UK', v), 'another plan');
  assert.ok(!lineOk('Harbor Labs | Team | $1,243.00 | no | UK', v), 'another cost');
  assert.ok(!lineOk('Recommended: Harbor Labs', v), 'only the recommendation');
  assert.ok(!lineOk('', data.right));
});

test('the oracle reads every page and leaves one quote at the right vendor', () => {
  const { env, data, state } = setup('s2');
  task.solve(data, state, env);
  assert.equal(state.vendors.quotes.length, 1);
  assert.equal(state.vendors.quotes[0].vendor, data.right.slug);
  assert.equal(state.vendors.events.filter((e: any) => e.type === 'viewed').length, 20);
  assert.equal(gradeTask({ task, data, state, env }).verdict, 'PASS');
});

test('plausible wrong agents do not pass', () => {
  // the whole job done right, but the quote submitted in the in-app browser instead of the user's Chrome
  {
    const { env, data, state } = setup();
    const g = gradeTask({ task, data, state: agent(data, state, { browser: 'app-browser' }), env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['quote-in-chrome']);
  }
  // the research done in Chrome too: the pages were never read in the in-app browser
  {
    const { env, data, state } = setup('s2');
    agent(data, state);
    for (const e of state.vendors.events) if (e.type === 'viewed') e.browser = 'chrome';
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['research-in-app']);
  }
  // the cheapest vendor recommended and quoted, without checking SSO
  {
    const { env, data, state } = setup('s3');
    const cheap = role(data, 'no-sso');
    agent(data, state, { text: (t) => t.replace(/^Recommended: .*$/m, `Recommended: ${cheap.name}`), quoteAt: cheap });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), [
      'recommended',
      'quote-right',
      'quote-contact',
      'quote-ref',
      'no-other-quotes',
    ]);
  }
  // the low-rated vendor's line left out, and the recommendation not on the last line
  {
    const { env, data, state } = setup();
    const low = role(data, 'rating');
    agent(data, state, {
      text: (t) =>
        `${t
          .split('\n')
          .filter((l) => !l.includes(low.name))
          .join('\n')}\nThanks!`,
    });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['line-rating', 'recommended']);
  }
  // every vendor costed on its smallest plan's sticker price, before extra seats: every line is wrong
  {
    const { env, data, state } = setup('s2');
    const small = (v: any) => v.plans[0];
    agent(data, state, {
      text: () =>
        `${data.vendors
          .map((v: any) => `${v.name} | ${small(v).name} | $${small(v).monthlyCents / 100} | SSO ${v.sso ? 'yes' : 'no'} | ${v.region}`)
          .join('\n')}\nRecommended: ${data.right.name}`,
    });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), [
      'line-right',
      'line-no-sso',
      'line-region',
      'line-rating',
      'line-retention',
    ]);
  }
  // a quote for the vendor's smallest plan when a bigger one is cheaper for the team
  {
    const { env, data, state } = setup();
    const small = data.right.plans[0].name;
    assert.ok(!data.right.best.includes(small));
    agent(data, state, { plan: small });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['quote-right']);
  }
  // nothing done: a do-nothing agent fails on everything but the "no other quotes" check
  {
    const { env, data, state } = setup();
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.ok(!unmet(g).includes('no-other-quotes'));
  }
});
