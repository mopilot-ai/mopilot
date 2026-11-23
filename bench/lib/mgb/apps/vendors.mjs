// MoPilot 12-Grid Bench (#1381) vendor-research fixture (vendors.localhost): a directory of vendor sites with pricing
// (monthly/annual), specs, paged reviews, security facts, notices, a quote-request form and a card checkout (orders keep
// only the card's last four digits), whose quotes and orders graders read.
import { fmtMoney } from '../seed.mjs';
import { checkoutRoutes } from './vendorsCheckout.mjs';
import { field, flashOf, html, logEvent, nextId, notFound, ok, page, paginate, parseBody, redirect, route, withFlash } from './kit.mjs';

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const BILLING = ['monthly', 'annual'];
const cents = (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;

/** A vendor from a fixture, checked so a broken fixture fails at load rather than mid-task. @param {any} v */
function vendor(v) {
  const slug = String(v?.slug ?? '');
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`vendor slug "${slug}" must be lowercase letters, digits and dashes`);
  if (!Array.isArray(v.plans) || !v.plans.length) throw new Error(`vendor ${slug} needs plans`);
  for (const p of v.plans) {
    if (
      !p.name ||
      ![p.monthlyCents, p.annualCents, p.extraSeatCents].every(cents) ||
      !(Number.isInteger(p.seatsIncluded) && p.seatsIncluded >= 0)
    )
      throw new Error(`vendor ${slug} plan "${p.name}" needs a name, whole-cent prices and seatsIncluded`);
  }
  const reviews = v.reviews ?? [];
  if (reviews.some((/** @type {any} */ r) => !(Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5)))
    throw new Error(`vendor ${slug} has a rating outside 1-5`);
  const sec = v.security ?? {};
  return {
    slug,
    name: String(v.name ?? slug),
    tagline: String(v.tagline ?? ''),
    plans: v.plans.map((/** @type {any} */ p) => ({ ...p, name: String(p.name) })),
    specs: { ...v.specs },
    reviews: reviews.map((/** @type {any} */ r) => ({
      author: String(r.author ?? 'Anonymous'),
      rating: r.rating,
      text: String(r.text ?? ''),
      date: String(r.date ?? '2026-01-01'),
    })),
    security: { soc2: !!sec.soc2, sso: !!sec.sso, dataRegion: String(sec.dataRegion ?? 'Unspecified'), notes: String(sec.notes ?? '') },
    notices: (v.notices ?? []).map(String),
  };
}

/**
 * The directory from a task's fixture: `{ vendors: [{ slug, name, tagline, plans: [{ name, monthlyCents, annualCents,
 * seatsIncluded, extraSeatCents }], specs, reviews: [{ author, rating, text, date }], security: { soc2, sso,
 * dataRegion, notes? }, notices? }] }`. Orders start empty: only the checkout makes them.
 * @param {any} f
 */
export function init(f) {
  if (!Array.isArray(f?.vendors) || !f.vendors.length) throw new Error('vendors fixture needs a vendors list');
  const vendors = f.vendors.map(vendor);
  if (new Set(vendors.map((/** @type {any} */ v) => v.slug)).size !== vendors.length) throw new Error('two vendors share a slug');
  return { vendors, quotes: /** @type {any[]} */ ([]), orders: /** @type {any[]} */ ([]), seq: 0, events: /** @type {any[]} */ ([]) };
}

/**
 * The quoted total in cents: the plan's per-month price plus extra seats beyond those included; annual billing uses the
 * annual per-month price and quotes twelve months. @param {any} plan @param {number} seats @param {string} billing
 */
export function quoteCents(plan, seats, billing) {
  const extra = Math.max(0, seats - plan.seatsIncluded) * plan.extraSeatCents;
  return billing === 'annual' ? (plan.annualCents + extra) * 12 : plan.monthlyCents + extra;
}

const TITLE = 'Vendor directory';
const SECTIONS = /** @type {[string, string][]} */ ([
  ['', 'Overview'],
  ['/pricing', 'Pricing'],
  ['/specs', 'Specs'],
  ['/reviews', 'Reviews'],
  ['/security', 'Security'],
  ['/contact', 'Contact sales'],
]);
const nav = (/** @type {any} */ v) =>
  /** @type {[string, string][]} */ ([['/', 'Directory'], ...(v ? SECTIONS.map(([path, label]) => [`/v/${v.slug}${path}`, label]) : [])]);
const view = (/** @type {URL} */ url, /** @type {any} */ v, /** @type {string} */ title, /** @type {unknown} */ body, error = '') =>
  ok(page({ app: TITLE, title: v ? `${title} · ${v.name}` : title, nav: nav(v), flash: flashOf(url), error, body }));
const find = (/** @type {any} */ s, /** @type {string} */ slug) => s.vendors.find((/** @type {any} */ v) => v.slug === slug);
const yes = (/** @type {boolean} */ b) => (b ? 'Yes' : 'No');

/** @typedef {(req: any, s: any, v: any, p: Record<string, string>, now: number) => any} VendorPage */

/** A vendor page: 404 for an unknown slug, otherwise logs the visit and renders. @param {string} name @param {VendorPage} render */
const vendorPage =
  (name, render) => (/** @type {any} */ req, /** @type {any} */ s, /** @type {Record<string, string>} */ p, /** @type {number} */ now) => {
    const v = find(s, p.slug);
    if (!v) return notFound('No such vendor');
    logEvent(s, 'viewed', { slug: v.slug, page: name }, now);
    return render(req, s, v, p, now);
  };

/** @type {[string, string, (req: any, s: any, p: Record<string, string>, now: number) => any][]} */
const ROUTES = [
  [
    'GET',
    '/',
    (req, s) => {
      const from = (/** @type {any} */ v) => Math.min(...v.plans.map((/** @type {any} */ p) => p.monthlyCents));
      return view(
        req.url,
        null,
        'Vendors',
        html`<h1>Vendor directory</h1>${s.vendors.map(
          (/** @type {any} */ v) =>
            html`<div class="card"><h2><a href="/v/${v.slug}">${v.name}</a></h2><p>${v.tagline}</p><p class="muted">From ${fmtMoney(from(v))} per month</p></div>`,
        )}`,
      );
    },
  ],
  [
    'GET',
    '/v/:slug',
    vendorPage('overview', (req, _s, v) =>
      view(
        req.url,
        v,
        'Overview',
        html`<h1>${v.name}</h1><p>${v.tagline}</p>${v.notices.map((/** @type {string} */ n) => html`<div class="card" role="note"><strong>Notice</strong><pre class="body">${n}</pre></div>`)}
<ul>${SECTIONS.slice(1).map(([path, label]) => html`<li><a href="/v/${v.slug}${path}">${label}</a></li>`)}</ul>`,
      ),
    ),
  ],
  [
    'GET',
    '/v/:slug/pricing',
    vendorPage('pricing', (req, _s, v) => {
      const billing = req.url.searchParams.get('billing') === 'annual' ? 'annual' : 'monthly';
      const other = billing === 'annual' ? 'monthly' : 'annual';
      const price = (/** @type {any} */ p) => (billing === 'annual' ? p.annualCents : p.monthlyCents);
      return view(
        req.url,
        v,
        'Pricing',
        html`<h1>${v.name} pricing</h1><p>Showing <strong>${billing}</strong> billing. <a href="/v/${v.slug}/pricing?billing=${other}">Show ${other} billing</a></p>
<table><thead><tr><th>Plan</th><th>Price per month${billing === 'annual' ? ' (billed annually)' : ''}</th><th>Seats included</th><th>Extra seat per month</th></tr></thead>
<tbody>${v.plans.map((/** @type {any} */ p) => html`<tr><td>${p.name}</td><td>${fmtMoney(price(p))}</td><td>${p.seatsIncluded}</td><td>${fmtMoney(p.extraSeatCents)}</td></tr>`)}</tbody></table>
<p>Buy online: ${v.plans.map((/** @type {any} */ p) => html`<a href="/v/${v.slug}/checkout?plan=${encodeURIComponent(p.name)}">${p.name}</a> `)}</p>`,
      );
    }),
  ],
  [
    'GET',
    '/v/:slug/specs',
    vendorPage('specs', (req, _s, v) => {
      const rows = Object.entries(v.specs).map(([k, x]) => html`<tr><th>${k}</th><td>${x}</td></tr>`);
      return view(
        req.url,
        v,
        'Specs',
        html`<h1>${v.name} specifications</h1><table><tbody>${rows.length ? rows : html`<tr><td>No specifications published.</td></tr>`}</tbody></table>`,
      );
    }),
  ],
  [
    'GET',
    '/v/:slug/reviews',
    vendorPage('reviews', (req, _s, v) => {
      const all = [...v.reviews].sort((a, b) => b.date.localeCompare(a.date));
      const avg = all.length ? (all.reduce((n, r) => n + r.rating, 0) / all.length).toFixed(1) : null;
      const { items, pager } = paginate(all, req.url, 5);
      return view(
        req.url,
        v,
        'Reviews',
        html`<h1>${v.name} reviews</h1><p>${avg ? `Average rating ${avg} out of 5 from ${all.length} review${all.length === 1 ? '' : 's'}` : 'No reviews yet.'}</p>
${items.map((/** @type {any} */ r) => html`<div class="card"><strong>${r.rating}/5</strong> ${r.author} <span class="muted">${r.date}</span><pre class="body">${r.text}</pre></div>`)}${pager}`,
      );
    }),
  ],
  [
    'GET',
    '/v/:slug/security',
    vendorPage('security', (req, _s, v) =>
      view(
        req.url,
        v,
        'Security',
        html`<h1>${v.name} security</h1><table><tbody><tr><th>SOC 2 report</th><td>${yes(v.security.soc2)}</td></tr><tr><th>Single sign-on (SSO)</th><td>${yes(v.security.sso)}</td></tr><tr><th>Data region</th><td>${v.security.dataRegion}</td></tr></tbody></table>${v.security.notes ? html`<p>${v.security.notes}</p>` : ''}`,
      ),
    ),
  ],
  [
    'GET',
    '/v/:slug/contact',
    vendorPage('contact', (req, _s, v) =>
      contact(req.url, v, { company: '', email: '', seats: '', plan: '', billing: 'monthly', message: '' }),
    ),
  ],
  [
    'POST',
    '/v/:slug/contact',
    (req, s, p, now) => {
      const v = find(s, p.slug);
      if (!v) return notFound('No such vendor');
      const { fields } = parseBody(req);
      const d = {
        company: field(fields, 'company'),
        email: field(fields, 'email'),
        seats: field(fields, 'seats'),
        plan: field(fields, 'plan'),
        billing: field(fields, 'billing'),
        message: fields.message?.[0] ?? '',
      };
      const plan = v.plans.find((/** @type {any} */ x) => x.name === d.plan);
      const seats = /^\d+$/.test(d.seats) ? Number(d.seats) : 0;
      const errors = [
        !d.company && 'Enter your company.',
        !EMAIL.test(d.email) && 'Enter a valid email address.',
        seats < 1 && 'Seats must be a whole number of at least 1.',
        !plan && 'Choose a plan.',
        !BILLING.includes(d.billing) && 'Choose monthly or annual billing.',
      ].filter(Boolean);
      // the request stays on the page with the errors: nothing typed is lost
      if (errors.length) return { ...contact(req.url, v, d, errors.join(' ')), status: 422 };
      const id = nextId(s, 'Q');
      const quotedCents = quoteCents(plan, seats, d.billing);
      s.quotes.push({
        id,
        vendor: v.slug,
        company: d.company,
        email: d.email,
        seats,
        plan: plan.name,
        billing: d.billing,
        quotedCents,
        message: d.message,
        at: new Date(now).toISOString(),
      });
      logEvent(s, 'quoteRequested', { id, vendor: v.slug, plan: plan.name, seats }, now);
      return redirect(withFlash(`/v/${v.slug}/quotes/${id}`, `Request ${id} received.`));
    },
  ],
  [
    'GET',
    '/v/:slug/quotes/:id',
    (req, s, p) => {
      const q = s.quotes.find((/** @type {any} */ x) => x.id === p.id && x.vendor === p.slug);
      if (!q) return notFound('No such request');
      const v = find(s, q.vendor);
      return view(
        req.url,
        v,
        `Request ${q.id}`,
        html`<div class="card"><h1>Request ${q.id} received</h1><p>${v.name} will contact ${q.email} about ${q.seats} seat${q.seats === 1 ? '' : 's'} on the ${q.plan} plan, billed ${q.billing}.</p>
<p>Quoted total: <strong>${fmtMoney(q.quotedCents)}</strong> per ${q.billing === 'annual' ? 'year' : 'month'}</p></div>`,
      );
    },
  ],
  ...checkoutRoutes({ view, find, vendorPage, quoteCents, billing: BILLING }),
];

/** The quote-request form. @param {URL} url @param {any} v @param {Record<string, string>} d */
function contact(url, v, d, error = '') {
  const opt = (/** @type {string} */ value, /** @type {string} */ label, /** @type {string} */ current) =>
    html`<option value="${value}"${value === current ? html` selected` : ''}>${label}</option>`;
  return view(
    url,
    v,
    'Contact sales',
    html`<h1>Request a quote from ${v.name}</h1><form method="post" action="/v/${v.slug}/contact">
<label for="company">Company</label><input id="company" name="company" value="${d.company}">
<label for="email">Work email</label><input id="email" name="email" value="${d.email}">
<label for="seats">Seats</label><input id="seats" name="seats" value="${d.seats}">
<label for="plan">Plan</label><select id="plan" name="plan">${opt('', 'Choose a plan', d.plan)}${v.plans.map((/** @type {any} */ p) => opt(p.name, p.name, d.plan))}</select>
<label for="billing">Billing</label><select id="billing" name="billing">${BILLING.map((b) => opt(b, b === 'annual' ? 'Annual' : 'Monthly', d.billing))}</select>
<label for="message">Message</label><textarea id="message" name="message">${d.message}</textarea>
<p><button>Request quote</button></p></form>`,
    error,
  );
}

/** @type {import('./server.mjs').App} */
export const vendors = {
  name: 'vendors',
  title: TITLE,
  init,
  handle(req, state, { now }) {
    const hit = route(req.method, req.url.pathname, ROUTES);
    return hit ? hit.handler(req, state, hit.params, now) : notFound();
  },
};
