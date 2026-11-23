// bench/lib/mgb/apps/vendorsCheckout.mjs (#1381): the vendor directory's card checkout: autocomplete fields, Luhn,
// expiry and security-code checks, 422s that never echo the card number or code, and orders that keep only the last four.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { form, req, text } from './support/mgb-app-kit.ts';

const { vendors, init } = await import('../bench/lib/mgb/apps/vendors.mjs');
const { expiryOk, luhn } = await import('../bench/lib/mgb/apps/vendorsCheckout.mjs');

const NOW = Date.parse('2026-10-19T12:00:00Z');
const PLANS = [
  { name: 'Starter', monthlyCents: 2000, annualCents: 1600, seatsIncluded: 5, extraSeatCents: 400 },
  { name: 'Team Plus', monthlyCents: 9900, annualCents: 7900, seatsIncluded: 3, extraSeatCents: 350 },
];
const load = () =>
  init({
    vendors: [
      { slug: 'northwind-crm', name: 'Northwind CRM', plans: PLANS },
      { slug: 'brightdesk', plans: [PLANS[0]] },
    ],
  });
const go = (s: any, method: string, path: string, o: any = {}) =>
  vendors.handle(req(method, path, { app: 'vendors', ...o }), s, { now: NOW });
const CARD = { cardName: 'Ada Abara', cardNumber: '4242 4242 4242 4242', expiry: '12/28', cvc: '123' };

test('luhn: accepts test card numbers, refuses a wrong check digit and bad lengths', () => {
  for (const n of ['4242424242424242', '5555555555554444', '378282246310005', '6011111111111117', '4000056655665556'])
    assert.ok(luhn(n), n);
  assert.equal(luhn('4242424242424241'), false);
  assert.equal(luhn('42424242424'), false);
  assert.equal(luhn('42424242424242424242'), false);
  assert.equal(luhn('4242-4242-4242-4242'), false);
});

test('expiry: MM/YY to the end of its month; the past, a bad month or another format is refused', () => {
  assert.ok(expiryOk('10/26', NOW));
  assert.ok(expiryOk('11 / 26', NOW));
  assert.ok(expiryOk('01/27', NOW));
  assert.equal(expiryOk('09/26', NOW), false);
  assert.equal(expiryOk('12/25', NOW), false);
  assert.equal(expiryOk('13/27', NOW), false);
  assert.equal(expiryOk('00/27', NOW), false);
  assert.equal(expiryOk('1/27', NOW), false);
  assert.equal(expiryOk('01/2027', NOW), false);
});

test('pricing links each plan to its checkout; the form has card autocomplete fields and the plan preselected', () => {
  const s = load();
  const pricing = go(s, 'GET', '/v/northwind-crm/pricing');
  assert.match(pricing.body, /href="\/v\/northwind-crm\/checkout\?plan=Team%20Plus">Team Plus/);
  assert.match(text(pricing), /Buy online: Starter Team Plus/);
  const page = go(s, 'GET', '/v/northwind-crm/checkout?plan=Team%20Plus');
  assert.equal(page.status, 200);
  assert.match(page.body, /<option value="Team Plus" selected>/);
  assert.match(
    text(page),
    /Team Plus: \$99\.00 per month, or \$79\.00 per month billed annually; 3 seats included, \$3\.50 per extra seat/,
  );
  assert.match(page.body, /name="cardName" autocomplete="cc-name"/);
  assert.match(page.body, /name="cardNumber" autocomplete="cc-number" inputmode="numeric"/);
  assert.match(page.body, /name="expiry" autocomplete="cc-exp" placeholder="MM\/YY"/);
  assert.match(page.body, /name="cvc" autocomplete="cc-csc"/);
  assert.match(page.body, /<option value="monthly" selected>Monthly/);
  const none = go(s, 'GET', '/v/northwind-crm/checkout');
  assert.match(none.body, /<option value="" selected>Choose a plan/);
  assert.ok(!text(none).includes('seats included'));
  assert.deepEqual(
    s.events.map((e: any) => e.page),
    ['pricing', 'checkout', 'checkout'],
  );
});

test('a bad payment answers 422 with what was typed, except the card number and security code', () => {
  const s = load();
  const bad = go(
    s,
    'POST',
    '/v/northwind-crm/checkout',
    form({ plan: 'Gold', seats: 'two', billing: 'weekly', cardName: '', cardNumber: '4242 4242 4242 4241', expiry: '09/26', cvc: '12' }),
  );
  assert.equal(bad.status, 422);
  assert.match(
    text(bad),
    /Choose a plan\. Seats must be a whole number of at least 1\. Choose monthly or annual billing\. Enter the name on the card\. Enter a valid card number\. Enter an expiry date MM\/YY that has not passed\. Enter the 3 or 4 digit security code\./,
  );
  assert.match(bad.body, /name="seats" inputmode="numeric" value="two"/);
  assert.match(bad.body, /name="expiry" autocomplete="cc-exp" placeholder="MM\/YY" value="09\/26"/);
  const zero = go(s, 'POST', '/v/northwind-crm/checkout', form({ ...CARD, plan: 'Starter', seats: '0', billing: 'annual' }));
  assert.deepEqual([zero.status, /Seats must be/.test(text(zero))], [422, true]);
  const kept = go(s, 'POST', '/v/northwind-crm/checkout', form({ ...CARD, plan: 'Starter', seats: '4', billing: 'annual', cvc: '12345' }));
  assert.equal(kept.status, 422);
  assert.match(text(kept), /^((?!Enter a valid card number).)*Enter the 3 or 4 digit security code/);
  assert.match(kept.body, /value="Ada Abara"/);
  assert.match(kept.body, /<option value="annual" selected>Annual/);
  assert.match(kept.body, /<option value="Starter" selected>/);
  for (const r of [bad, kept]) {
    assert.ok(!r.body.includes('4242'), 'the card number is never echoed');
    assert.match(r.body, /name="cardNumber" autocomplete="cc-number" inputmode="numeric" value=""/);
    assert.match(r.body, /name="cvc" autocomplete="cc-csc" inputmode="numeric" value=""/);
  }
  assert.ok(!kept.body.includes('12345'));
  assert.deepEqual([s.orders, s.events], [[], []]);
});

test('a good payment records an order with the last four digits only, logs it and confirms it', () => {
  const s = load();
  const ok = go(s, 'POST', '/v/northwind-crm/checkout', form({ ...CARD, plan: 'Team Plus', seats: '5', billing: 'monthly' }));
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/v/northwind-crm/orders/ORD-1?flash=Order%20ORD-1%20confirmed.');
  const order = {
    id: 'ORD-1',
    vendor: 'northwind-crm',
    plan: 'Team Plus',
    seats: 5,
    billing: 'monthly',
    totalCents: 9900 + 2 * 350,
    last4: '4242',
  };
  assert.deepEqual(s.orders, [{ ...order, at: '2026-10-19T12:00:00.000Z' }]);
  assert.deepEqual(s.events, [{ at: NOW, type: 'purchased', ...order }]);
  const json = JSON.stringify(s);
  assert.ok(!json.includes('4242424242424242') && !json.includes('4242 4242') && !json.includes('"123"'), 'no full number or code');
  const conf = text(go(s, 'GET', '/v/northwind-crm/orders/ORD-1'));
  assert.match(conf, /Order ORD-1 confirmed/);
  assert.match(conf, /5 seats on the Team Plus plan, billed monthly, paid with the card ending 4242/);
  assert.match(conf, /Total: \$106\.00 per month/);

  go(
    s,
    'POST',
    '/v/brightdesk/checkout',
    form({ ...CARD, cardNumber: '378282246310005', cvc: '1234', plan: 'Starter', seats: '1', billing: 'annual' }),
  );
  assert.deepEqual([s.orders[1].id, s.orders[1].totalCents, s.orders[1].last4], ['ORD-2', 1600 * 12, '0005']);
  assert.match(text(go(s, 'GET', '/v/brightdesk/orders/ORD-2')), /1 seat on the Starter plan.*Total: \$192\.00 per year/);
  assert.equal(go(s, 'GET', '/v/brightdesk/orders/ORD-1').status, 404);
});

test('unknown vendors and orders are 404s without events', () => {
  const s = load();
  for (const [m, p] of [
    ['GET', '/v/nope/checkout'],
    ['POST', '/v/nope/checkout'],
    ['GET', '/v/northwind-crm/orders/ORD-9'],
  ])
    assert.equal(go(s, m, p).status, 404, `${m} ${p}`);
  assert.deepEqual(s.events, []);
});
