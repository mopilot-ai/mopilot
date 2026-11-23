// MGB task f2-quote-forms (#1381, F2): read a procurement brief, find the vendors with a plan that fits it, request a
// quote for the cheapest fitting plan at each through their forms, and record the quotes in a CSV on the Mac.
import { has, same } from '../grade.mjs';
import { dayOffset, distinct, people } from '../seed.mjs';
import { at } from './common.mjs';
import { browse } from './drive.mjs';
import { csvTable, fileAt, plainCents, putFile } from './f2Common.mjs';

export const BRIEF = 'Procurement brief';
export const CSV = 'quotes.csv';
export const COLUMNS = ['vendor', 'plan', 'seats', 'billing', 'quote_id', 'total'];
const PLAN_NAMES = [
  ['Starter', 'Team', 'Business'],
  ['Basic', 'Plus', 'Scale'],
  ['Solo', 'Growth', 'Enterprise'],
  ['Lite', 'Standard', 'Premium'],
];
/** Three of each kind would make the answer a count: three fit, the others fail on seats or on SSO. */
const KINDS = ['fit', 'fit', 'fit', 'small', 'small', 'nosso'];

/** @param {string} s */
const slug = (s) => s.toLowerCase().replace(/[^a-z]+/g, '-');
/** A plan's price per month at a billing. @param {any} p @param {string} billing */
const price = (p, billing) => (billing === 'annual' ? p.annualCents : p.monthlyCents);
/** The cheapest plan whose included seats cover everyone. @param {any[]} plans @param {number} seats @param {string} billing */
export const cheapestFit = (plans, seats, billing) =>
  plans.filter((p) => p.seatsIncluded >= seats).sort((a, b) => price(a, billing) - price(b, billing))[0];

/** The quotes requested from a vendor. @param {any} state @param {string} vendor */
const quotesAt = (state, vendor) => state.vendors.quotes.filter((/** @type {any} */ q) => q.vendor === vendor);
/** The CSV's rows, when the file is there with the right header. @param {any} state */
const csvOf = (state) => csvTable(fileAt(state.files, CSV)?.text, COLUMNS);
/** The row that names a vendor (by name or by its site's slug). @param {any[]} rows @param {any} v */
const rowFor = (rows, v) => rows.find((r) => same(r.vendor, v.name) || same(r.vendor, v.slug));
/** A quote request as the oracle fills it in: the company, contact and reference the brief gives. @param {any} d @param {any} v */
export const requestFor = (d, v) => ({
  company: d.buyer,
  email: d.user.email,
  seats: String(d.seats),
  plan: v.expected,
  billing: d.billing,
  message: `Procurement reference ${d.ref}. Please send a quote for ${d.seats} seats.`,
});
/** The CSV the oracle writes from the app's quotes. @param {any} d @param {any[]} quotes */
export const csvFor = (d, quotes) =>
  [
    COLUMNS.join(','),
    ...quotes.map((q) => {
      const v = d.vendors.find((/** @type {any} */ x) => x.slug === q.vendor);
      return [v.name, q.plan, q.seats, q.billing, q.id, (q.quotedCents / 100).toFixed(2)].join(',');
    }),
  ].join('\n');

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f2-quote-forms',
  family: 'F2',
  title: 'Request quotes from every vendor that fits a brief and record them in a CSV',
  surfaces: ['iab', 'cu'],
  tier: 'full',
  apps: ['vendors', 'docs'],
  actions: [30, 80],
  cards: 0,
  data(r, env) {
    const [buyer, ...names] = distinct(r.company, 7);
    const [user, author] = people(r, 2, `${slug(buyer).replace(/-/g, '')}.test`);
    const seats = r.int(12, 45);
    const billing = r.pick(['monthly', 'annual']);
    const kinds = r.shuffle(KINDS);
    const vendors = names.map((name, i) => {
      const kind = kinds[i];
      const tiers =
        kind === 'small'
          ? [r.int(3, 5), r.int(6, seats - 3), r.int(seats - 2, seats - 1)]
          : [r.int(5, seats - 2), seats + r.int(0, 10), seats + r.int(20, 60)];
      const low = r.int(20, 60) * 100;
      const monthly = [low, low + r.int(40, 120) * 100, low + r.int(180, 300) * 100];
      const plans = r.pick(PLAN_NAMES).map((n, k) => ({
        name: n,
        monthlyCents: monthly[k],
        annualCents: Math.round((monthly[k] * r.int(75, 90)) / 100),
        seatsIncluded: tiers[k],
        extraSeatCents: r.int(4, 15) * 100,
      }));
      return {
        slug: slug(name),
        name,
        kind,
        plans,
        sso: kind !== 'nosso',
        region: r.pick(['EU', 'US', 'EU and US']),
        expected: /** @type {string | null} */ (null),
      };
    });
    // at the first fitting vendor the biggest plan is on offer: cheaper than the middle one at the brief's billing only
    const promo = vendors.find((v) => v.kind === 'fit');
    const [, mid, big] = /** @type {(typeof vendors)[number]} */ (promo).plans;
    const other = billing === 'annual' ? 'monthlyCents' : 'annualCents';
    big[billing === 'annual' ? 'annualCents' : 'monthlyCents'] = price(mid, billing) - r.int(5, 30) * 100;
    big[other] = mid[other] + r.int(30, 90) * 100;
    for (const v of vendors) v.expected = v.kind === 'fit' ? cheapestFit(v.plans, seats, billing).name : null;
    return {
      buyer,
      user,
      author,
      seats,
      billing,
      vendors,
      fits: vendors.filter((v) => v.kind === 'fit').map((v) => v.slug),
      ref: r.token('PR', 4),
      oldRef: r.token('PR', 4),
    };
  },
  fixtures(d, env) {
    return {
      vendors: {
        vendors: d.vendors.map((/** @type {any} */ v) => ({
          slug: v.slug,
          name: v.name,
          tagline: `Team chat by ${v.name}`,
          plans: v.plans,
          specs: { 'Message history': 'Unlimited', 'Guest access': 'Yes' },
          reviews: [{ author: 'Ops lead', rating: 4, text: 'Solid and simple.', date: dayOffset(env.today, -40) }],
          security: { soc2: true, sso: v.sso, dataRegion: v.region },
          notices: v.slug === d.fits[0] ? [`Autumn offer: the ${v.plans[2].name} plan is reduced while the offer lasts.`] : [],
        })),
      },
      docs: {
        user: { name: d.user.name },
        spaces: [{ key: 'OPS', name: 'Operations' }],
        pages: [
          {
            space: 'OPS',
            title: BRIEF,
            author: d.author.name,
            updatedAt: at(dayOffset(env.today, -1), 10),
            body: [
              '# Team chat tool: procurement brief',
              `- Seats: ${d.seats} people, all on one plan. Only plans whose included seats cover all ${d.seats} of us fit: no extra-seat add-ons.`,
              `- Billing: ${d.billing}.`,
              '- The vendor must offer single sign-on (SSO).',
              '- Ask every vendor that fits for a quote on its cheapest plan that fits, at our billing.',
              `- Request quotes as ${d.buyer}, with ${d.user.email} as the contact email.`,
              `- Every quote request must give our procurement reference ${d.ref} in its message.`,
            ].join('\n'),
          },
          {
            space: 'OPS',
            title: `${BRIEF}: printers (closed)`,
            author: d.author.name,
            updatedAt: at(dayOffset(env.today, -90), 10),
            body: `Closed. 4 printers, annual service, reference ${d.oldRef}.`,
          },
        ],
      },
      files: { entries: {} },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name} at ${d.buyer}. Read the "${BRIEF}" page in our docs (${env.urls.docs}) and compare it with the vendors in the directory (${env.urls.vendors}): which vendors have a plan that fits the brief, and which plan is the cheapest fit at each? Use the in-app browser for the websites. Tell me what you found; don't send any requests yet.`,
      `Now request a quote from each vendor that fits, for its cheapest fitting plan, filled in the way the brief says. Then, with the Mac's apps (TextEdit and Finder), create ${CSV} in ${env.files} with the header ${COLUMNS.join(',')} and one row per request: the vendor's name, the plan, seats, billing, the request id the site gave you (Q-…) and the quoted total as a plain decimal number such as 1234.50.`,
    ];
  },
  secrets: (d) => [d.ref, ...d.vendors.filter((/** @type {any} */ v) => v.kind === 'fit').map((/** @type {any} */ v) => v.name)],
  checkpoints: [
    ...[0, 1, 2].map((k) => ({
      id: `quote-${k}`,
      title: `One request at the ${['first', 'second', 'third'][k]} fitting vendor, for its cheapest fitting plan, seats and billing`,
      check: (/** @type {any} */ { data, state }) => {
        const v = data.vendors.find((/** @type {any} */ x) => x.slug === data.fits[k]);
        const qs = quotesAt(state, v.slug);
        return qs.length === 1 && [qs[0].plan === v.expected, qs[0].seats === data.seats, qs[0].billing === data.billing].every(Boolean);
      },
    })),
    {
      id: 'quote-contact',
      title: 'The requests are made as the company, with the contact email the brief gives',
      weight: 0.5,
      check: ({ data, state }) =>
        state.vendors.quotes.length > 0 &&
        state.vendors.quotes.every((/** @type {any} */ q) => same(q.company, data.buyer) && same(q.email, data.user.email)),
    },
    {
      id: 'no-misfit',
      title: 'No request went to a vendor without a fitting plan',
      weight: 0.5,
      check: ({ data, state }) => state.vendors.quotes.every((/** @type {any} */ q) => data.fits.includes(q.vendor)),
    },
    { id: 'csv-file', title: `${CSV} is in the folder with the asked-for header`, check: ({ state }) => !!csvOf(state) },
    {
      id: 'csv-rows',
      title: 'The CSV has one row per request, matching the site’s plan, seats, billing and total',
      check: ({ data, state }) => {
        const rows = csvOf(state) ?? [];
        const quotes = state.vendors.quotes;
        return (
          quotes.length > 0 &&
          rows.length === quotes.length &&
          quotes.every((/** @type {any} */ q) => {
            const row = rowFor(
              rows,
              data.vendors.find((/** @type {any} */ v) => v.slug === q.vendor),
            );
            return (
              !!row &&
              same(row.plan, q.plan) &&
              Number(row.seats) === q.seats &&
              same(row.billing, q.billing) &&
              plainCents(row.total) === q.quotedCents
            );
          })
        );
      },
    },
    {
      id: 'csv-ids',
      title: 'The CSV gives each fitting vendor’s request id, for requests that quote the brief’s reference',
      canary: true,
      check: ({ data, state }) => {
        const rows = csvOf(state) ?? [];
        return data.fits.every((/** @type {string} */ s) => {
          const q = quotesAt(state, s).find((/** @type {any} */ x) => has(x.message, data.ref));
          const row = rowFor(
            rows,
            data.vendors.find((/** @type {any} */ v) => v.slug === s),
          );
          return !!q && same(row?.quote_id, q.id);
        });
      },
    },
  ],
  solve(d, state) {
    const site = browse(state, 'vendors');
    for (const s of d.fits)
      site.post(
        `/v/${s}/contact`,
        requestFor(
          d,
          d.vendors.find((/** @type {any} */ v) => v.slug === s),
        ),
      );
    putFile(state, CSV, Buffer.from(csvFor(d, state.vendors.quotes), 'utf8'));
    return state;
  },
};
