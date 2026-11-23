// MoPilot 12-Grid Bench (#1381) vendor-directory card checkout (vendors.localhost): a payment form with card autocomplete
// fields, Luhn, expiry and security-code checks, and orders that keep only the card's last four digits.
import { fmtMoney } from '../seed.mjs';
import { field, html, logEvent, nextId, notFound, parseBody, redirect, withFlash } from './kit.mjs';

/** Whether a card number (digits only, 12-19 of them) passes the Luhn check. @param {string} digits */
export function luhn(digits) {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Whether an expiry written MM/YY is a real month that has not ended at `now` (a card works to its month's end). @param {string} text @param {number} now */
export function expiryOk(text, now) {
  const m = /^(0[1-9]|1[0-2])\s*\/\s*(\d{2})$/.exec(text);
  if (!m) return false;
  const today = new Date(now);
  const year = 2000 + Number(m[2]);
  return year > today.getUTCFullYear() || (year === today.getUTCFullYear() && Number(m[1]) >= today.getUTCMonth() + 1);
}

/**
 * The checkout routes, given the directory's shared pieces (they live in vendors.mjs).
 * @param {{ view: Function, find: Function, vendorPage: Function, quoteCents: Function, billing: string[] }} o
 * @returns {[string, string, (req: any, s: any, p: Record<string, string>, now: number) => any][]}
 */
export function checkoutRoutes({ view, find, vendorPage, quoteCents, billing }) {
  /** The payment form; the card number and security code are never filled back in. @param {URL} url @param {any} v @param {Record<string, string>} d */
  const form = (url, v, d, error = '') => {
    const opt = (/** @type {string} */ value, /** @type {string} */ label, /** @type {string} */ current) =>
      html`<option value="${value}"${value === current ? html` selected` : ''}>${label}</option>`;
    const plan = v.plans.find((/** @type {any} */ p) => p.name === d.plan);
    return view(
      url,
      v,
      'Checkout',
      html`<h1>Buy ${v.name}</h1>${plan ? html`<p>${plan.name}: ${fmtMoney(plan.monthlyCents)} per month, or ${fmtMoney(plan.annualCents)} per month billed annually; ${plan.seatsIncluded} seats included, ${fmtMoney(plan.extraSeatCents)} per extra seat per month.</p>` : ''}
<form method="post" action="/v/${v.slug}/checkout">
<label for="plan">Plan</label><select id="plan" name="plan">${opt('', 'Choose a plan', d.plan)}${v.plans.map((/** @type {any} */ p) => opt(p.name, p.name, d.plan))}</select>
<label for="seats">Seats</label><input id="seats" name="seats" inputmode="numeric" value="${d.seats}">
<label for="billing">Billing</label><select id="billing" name="billing">${billing.map((b) => opt(b, b === 'annual' ? 'Annual' : 'Monthly', d.billing))}</select>
<fieldset><legend>Payment card</legend>
<label for="cardName">Name on card</label><input id="cardName" name="cardName" autocomplete="cc-name" value="${d.cardName}">
<label for="cardNumber">Card number</label><input id="cardNumber" name="cardNumber" autocomplete="cc-number" inputmode="numeric" value="">
<label for="expiry">Expiry (MM/YY)</label><input id="expiry" name="expiry" autocomplete="cc-exp" placeholder="MM/YY" value="${d.expiry}">
<label for="cvc">Security code</label><input id="cvc" name="cvc" autocomplete="cc-csc" inputmode="numeric" value=""></fieldset>
<p><button>Pay and subscribe</button></p></form>`,
      error,
    );
  };
  return [
    [
      'GET',
      '/v/:slug/checkout',
      vendorPage('checkout', (/** @type {any} */ req, /** @type {any} */ _s, /** @type {any} */ v) =>
        form(req.url, v, { plan: req.url.searchParams.get('plan') ?? '', seats: '', billing: 'monthly', cardName: '', expiry: '' }),
      ),
    ],
    [
      'POST',
      '/v/:slug/checkout',
      (req, s, p, now) => {
        const v = find(s, p.slug);
        if (!v) return notFound('No such vendor');
        const { fields } = parseBody(req);
        const d = {
          plan: field(fields, 'plan'),
          seats: field(fields, 'seats'),
          billing: field(fields, 'billing'),
          cardName: field(fields, 'cardName'),
          expiry: field(fields, 'expiry'),
        };
        const number = field(fields, 'cardNumber').replace(/[\s-]/g, '');
        const cvc = field(fields, 'cvc');
        const plan = v.plans.find((/** @type {any} */ x) => x.name === d.plan);
        const seats = /^\d+$/.test(d.seats) ? Number(d.seats) : 0;
        const errors = [
          !plan && 'Choose a plan.',
          seats < 1 && 'Seats must be a whole number of at least 1.',
          !billing.includes(d.billing) && 'Choose monthly or annual billing.',
          !d.cardName && 'Enter the name on the card.',
          !luhn(number) && 'Enter a valid card number.',
          !expiryOk(d.expiry, now) && 'Enter an expiry date MM/YY that has not passed.',
          !/^\d{3,4}$/.test(cvc) && 'Enter the 3 or 4 digit security code.',
        ].filter(Boolean);
        if (errors.length) return { ...form(req.url, v, d, errors.join(' ')), status: 422 };
        const id = nextId(s, 'ORD');
        // only the last four digits are kept: the full number and the security code never reach the state
        const order = {
          id,
          vendor: v.slug,
          plan: plan.name,
          seats,
          billing: d.billing,
          totalCents: quoteCents(plan, seats, d.billing),
          last4: number.slice(-4),
          at: new Date(now).toISOString(),
        };
        s.orders.push(order);
        const { at: _at, ...logged } = order;
        logEvent(s, 'purchased', logged, now);
        return redirect(withFlash(`/v/${v.slug}/orders/${id}`, `Order ${id} confirmed.`));
      },
    ],
    [
      'GET',
      '/v/:slug/orders/:id',
      (req, s, p) => {
        const o = s.orders.find((/** @type {any} */ x) => x.id === p.id && x.vendor === p.slug);
        if (!o) return notFound('No such order');
        return view(
          req.url,
          find(s, o.vendor),
          `Order ${o.id}`,
          html`<div class="card"><h1>Order ${o.id} confirmed</h1><p>${o.seats} seat${o.seats === 1 ? '' : 's'} on the ${o.plan} plan, billed ${o.billing}, paid with the card ending ${o.last4}.</p>
<p>Total: <strong>${fmtMoney(o.totalCents)}</strong> per ${o.billing === 'annual' ? 'year' : 'month'}</p></div>`,
        );
      },
    ],
  ];
}
