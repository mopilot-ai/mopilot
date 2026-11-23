// MGB task f2-quote-forms (#1381): beside the audit (benchMgbAudit.test.ts), exactly three vendors fit the brief (one only via
// its promotional plan), the CSV helpers read what a person writes, and plausible wrong agents fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { quoteCents } = await import('../bench/lib/mgb/apps/vendors.mjs');
const { csvRows, csvTable, plainCents, putFile } = await import('../bench/lib/mgb/tasks/f2Common.mjs');
const { CSV, COLUMNS, cheapestFit, csvFor, requestFor, task } = await import('../bench/lib/mgb/tasks/f2QuoteForms.mjs');

const setup = (seed = 's1') => setupTask(task, seed);
const vendor = (data: any, s: string) => data.vendors.find((v: any) => v.slug === s);
/** Requests at these vendors (each request changeable), then the CSV written from the site's quotes. */
function agent(
  data: any,
  state: any,
  slugs: string[],
  o: { plan?: (v: any) => string; message?: string; company?: string; csv?: (text: string) => string } = {},
) {
  for (const s of slugs) {
    const v = vendor(data, s);
    const req = { ...requestFor(data, v), plan: (o.plan ?? ((x: any) => x.expected))(v), company: o.company ?? data.buyer };
    browse(state, 'vendors').post(`/v/${s}/contact`, o.message === undefined ? req : { ...req, message: o.message });
  }
  putFile(state, CSV, Buffer.from((o.csv ?? ((t: string) => t))(csvFor(data, state.vendors.quotes)), 'utf8'));
  return state;
}

test('the data: three vendors fit, the others miss on seats or SSO, and one fit is cheapest on its biggest plan', () => {
  for (const seed of ['s1', 's2', 's3']) {
    const { data } = setup(seed);
    const fits = data.vendors.filter((v: any) => v.sso && v.plans.some((p: any) => p.seatsIncluded >= data.seats));
    assert.deepEqual(
      fits.map((v: any) => v.slug),
      data.fits,
    );
    assert.equal(data.fits.length, 3);
    assert.ok(
      data.vendors.some((v: any) => !v.sso && v.plans.some((p: any) => p.seatsIncluded >= data.seats)),
      'an SSO miss',
    );
    assert.ok(
      data.vendors.some((v: any) => v.sso && v.plans.every((p: any) => p.seatsIncluded < data.seats)),
      'a seats miss',
    );
    const promo = vendor(data, data.fits[0]);
    assert.equal(promo.expected, promo.plans[2].name, 'the offer makes the biggest plan the cheapest fit');
    const other = data.billing === 'annual' ? 'monthly' : 'annual';
    assert.equal(cheapestFit(promo.plans, data.seats, other).name, promo.plans[1].name, 'only at the brief’s billing');
    for (const s of data.fits.slice(1)) assert.equal(vendor(data, s).expected, vendor(data, s).plans[1].name);
  }
});

test('the oracle’s CSV records the site’s ids and totals', () => {
  const { env, data, state } = setup('s2');
  task.solve(data, state, env);
  const rows: any = csvTable(state.files.entries[CSV].text, COLUMNS);
  assert.equal(rows.length, 3);
  for (const q of state.vendors.quotes) {
    const v = vendor(data, q.vendor);
    assert.equal(
      q.quotedCents,
      quoteCents(
        v.plans.find((p: any) => p.name === v.expected),
        data.seats,
        data.billing,
      ),
    );
    assert.ok(rows.some((r: any) => r.quote_id === q.id && plainCents(r.total) === q.quotedCents));
  }
});

test('plausible wrong agents do not pass', () => {
  // a vendor without SSO asked as well: the CSV records it faithfully, but the request should not exist
  {
    const { env, data, state } = setup();
    const noSso = data.vendors.find((v: any) => !v.sso).slug;
    const plan = (v: any) => v.expected ?? cheapestFit(v.plans, data.seats, data.billing).name;
    const g = gradeTask({ task, data, state: agent(data, state, [...data.fits, noSso], { plan }), env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['no-misfit']);
  }
  // the smallest fitting plan instead of the cheapest at the vendor with the offer
  {
    const { env, data, state } = setup('s2');
    const promo = data.fits[0];
    agent(data, state, data.fits, { plan: (v: any) => (v.slug === promo ? v.plans[1].name : v.expected) });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['quote-0']);
  }
  // totals written as money ("$1,234.00", quoted) rather than plain decimals
  {
    const { env, data, state } = setup('s3');
    agent(data, state, data.fits, {
      csv: (t) => t.replace(/,(\d+)\.(\d{2})$/gm, (_m, a, b) => `,"$${Number(a).toLocaleString('en-US')}.${b}"`),
    });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['csv-rows']);
  }
  // no procurement reference in the requests: the canary misses
  {
    const { env, data, state } = setup();
    agent(data, state, data.fits, { message: 'Please quote.' });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['csv-ids']);
    assert.equal(g.verdict, 'FAIL');
  }
  // a header of its own and another company's name and email on the requests
  {
    const { env, data, state } = setup('s2');
    agent(data, state, data.fits, {
      company: 'Someone Else Ltd',
      csv: (t) => t.replace(COLUMNS.join(','), 'Vendor,Plan,Seats,Billing,Quote ID,Total'),
    });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['quote-contact', 'csv-file', 'csv-rows', 'csv-ids']);
  }
});

test('CSV reading: quotes, doubled quotes, CRLF, a BOM, blank and short rows', () => {
  assert.deepEqual(csvRows('a, "b,c" ,"say ""hi"""\r\n\r\n,\nd'), [['a', 'b,c', 'say "hi"'], ['d']]);
  assert.deepEqual(csvTable('﻿Vendor,Total\nAcme\n', ['vendor', 'total']), [{ vendor: 'Acme', total: '' }]);
  assert.equal(csvTable('', ['vendor']), null);
  assert.equal(csvTable('vendor,total', ['vendor']), null);
  assert.deepEqual([plainCents('12'), plainCents('12.5'), plainCents('$12'), plainCents('1,200.00')], [1200, 1250, null, null]);
});
