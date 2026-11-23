// MGB task f6-cross-surface-switch (#1381, F6): quotes from four fitting vendors in the in-app browser and a CSV of
// them on the Mac (computer use); two quotes and the CSV's first rows before the chat switches harness, the other two,
// every row and a total line after. Graded on each quote existing once and the CSV matching the site's quotes.
import { has, same } from '../grade.mjs';
import { dayOffset, distinct, people } from '../seed.mjs';
import { at } from './common.mjs';
import { browse } from './drive.mjs';
import { csvTable, fileAt, plainCents, putFile } from './f2Common.mjs';
import { CSV, cheapestFit, COLUMNS, requestFor } from './f2QuoteForms.mjs';
import { ORD } from './f6Common.mjs';

export { COLUMNS, CSV };
export const BRIEF = 'Meeting tool brief';
/** Fitting vendors asked before the switch: the first two the directory lists. */
export const FIRST = 2;
const PLAN_NAMES = [
  ['Starter', 'Team', 'Business'],
  ['Basic', 'Plus', 'Scale'],
  ['Solo', 'Growth', 'Enterprise'],
  ['Lite', 'Standard', 'Premium'],
];
/** Four fit; one misses on seats and one on SSO. */
const KINDS = ['fit', 'fit', 'fit', 'fit', 'small', 'nosso'];

/** @param {string} s */
const slugOf = (s) => s.toLowerCase().replace(/[^a-z]+/g, '-');
/** The quotes requested from a vendor. @param {any} state @param {string} vendor */
const quotesAt = (state, vendor) => state.vendors.quotes.filter((/** @type {any} */ q) => q.vendor === vendor);
/** The CSV's rows, when the file is there with the right header. @param {any} state */
const csvOf = (state) => csvTable(fileAt(state.files, CSV)?.text, COLUMNS);
/** A total line. @param {any} row */
const isTotal = (row) => same(row.vendor, 'total');
/** The fitting vendors, in directory order. @param {any} d @returns {any[]} */
export const fits = (d) => d.vendors.filter((/** @type {any} */ v) => v.kind === 'fit');

/** One CSV row for a quote of the site. @param {any} d @param {any} q */
export const rowFor = (d, q) =>
  [
    d.vendors.find((/** @type {any} */ v) => v.slug === q.vendor).name,
    q.plan,
    q.seats,
    q.billing,
    q.id,
    (q.quotedCents / 100).toFixed(2),
  ].join(',');
/** A CSV with these rows, and a total line when `total` is a number of cents. @param {string[]} rows @param {number} [total] */
export const csvText = (rows, total) =>
  [COLUMNS.join(','), ...rows, ...(total === undefined ? [] : [`Total,,,,,${(total / 100).toFixed(2)}`])].join('\n');

/** Requests a quote at each vendor the way the brief says. @param {any} d @param {any} state @param {any[]} vendors */
export function request(d, state, vendors) {
  const site = browse(state, 'vendors');
  for (const v of vendors) site.post(`/v/${v.slug}/contact`, requestFor(d, v));
}

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f6-cross-surface-switch',
  family: 'F6',
  title: 'Request vendor quotes in the browser and record them in a Mac CSV, split across a harness switch',
  surfaces: ['iab', 'cu'],
  columns: ['switch'],
  tier: 'full',
  apps: ['vendors', 'docs'],
  actions: [30, 80],
  cards: 0,
  switchBefore: 2,
  data(r) {
    const [buyer, ...names] = distinct(r.company, 7);
    const [user, author] = people(r, 2, `${slugOf(buyer).replace(/-/g, '')}.test`);
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
      return { slug: slugOf(name), name, kind, plans, sso: kind !== 'nosso', expected: '' };
    });
    for (const v of vendors) if (v.kind === 'fit') v.expected = cheapestFit(v.plans, seats, billing).name;
    return { buyer, user, author, seats, billing, vendors, ref: r.token('PR', 4), oldRef: r.token('PR', 4) };
  },
  fixtures(d, env) {
    return {
      vendors: {
        vendors: d.vendors.map((/** @type {any} */ v) => ({
          slug: v.slug,
          name: v.name,
          tagline: `Video meetings by ${v.name}`,
          plans: v.plans,
          specs: { Recording: 'Cloud', 'Max participants': '300' },
          reviews: [{ author: 'IT lead', rating: 4, text: 'Reliable calls.', date: dayOffset(env.today, -30) }],
          security: { soc2: true, sso: v.sso, dataRegion: 'EU and US' },
        })),
      },
      docs: {
        user: { name: d.user.name },
        spaces: [{ key: 'IT', name: 'IT' }],
        pages: [
          {
            space: 'IT',
            title: BRIEF,
            author: d.author.name,
            updatedAt: at(dayOffset(env.today, -1), 10),
            body: [
              '# Meeting tool: procurement brief',
              `- Seats: ${d.seats} people, all on one plan. Only plans whose included seats cover all ${d.seats} of us fit: no extra-seat add-ons.`,
              `- Billing: ${d.billing}.`,
              '- The vendor must offer single sign-on (SSO).',
              '- Ask every vendor that fits for a quote on its cheapest plan that fits, at our billing.',
              `- Request quotes as ${d.buyer}, with ${d.user.email} as the contact email.`,
              `- Every quote request must give our procurement reference ${d.ref} in its message.`,
            ].join('\n'),
          },
          {
            space: 'IT',
            title: `${BRIEF}: webinars (closed)`,
            author: d.author.name,
            updatedAt: at(dayOffset(env.today, -120), 10),
            body: `Closed. Webinar add-on, reference ${d.oldRef}.`,
          },
        ],
      },
      files: { entries: {} },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name} at ${d.buyer}. Use the in-app browser for the websites. Read the "${BRIEF}" page in our docs (${env.urls.docs}) and compare it with the vendors in the directory (${env.urls.vendors}): which vendors have a plan that fits the brief, and which plan is the cheapest fit at each? Tell me what you found; don't send any requests yet.`,
      `Let's start with the first two vendors that fit, in the order the directory lists them: request a quote from each for its cheapest fitting plan, filled in the way the brief says. Then, with the Mac's apps (TextEdit and Finder), start ${CSV} in ${env.files} with the header ${COLUMNS.join(',')} and a row for each of those two requests: the vendor's name, the plan, seats, billing, the request id the site gave you (Q-…) and the quoted total as a plain decimal number such as 1234.50.`,
      `Now finish the rest: request quotes from the other vendors that fit, add their rows to ${CSV}, and end the file with a total line: Total in the vendor column, the sum of all the quoted totals in the total column, and the other cells empty.`,
    ];
  },
  secrets: (d) => [d.ref, ...fits(d).map((v) => v.name)],
  checkpoints: [
    ...[0, 1, 2, 3].map((k) => ({
      id: `quote-${k}`,
      title: `One request at the ${ORD[k]} fitting vendor, for its cheapest fitting plan, seats and billing`,
      check: (/** @type {any} */ { data, state }) => {
        const v = fits(data)[k];
        const qs = quotesAt(state, v.slug);
        return qs.length === 1 && qs[0].plan === v.expected && qs[0].seats === data.seats && qs[0].billing === data.billing;
      },
    })),
    {
      id: 'no-misfit',
      title: 'No request went to a vendor without a fitting plan',
      weight: 0.5,
      check: ({ data, state }) => state.vendors.quotes.every((/** @type {any} */ q) => fits(data).some((v) => v.slug === q.vendor)),
    },
    { id: 'csv-file', title: `${CSV} is in the folder with the asked-for header`, check: ({ state }) => !!csvOf(state) },
    {
      id: 'csv-rows',
      title: 'The CSV has one row per request on the site, with its id, vendor, plan, seats, billing and total',
      check: ({ data, state }) => {
        const rows = (csvOf(state) ?? []).filter((r) => !isTotal(r));
        const quotes = state.vendors.quotes;
        return (
          quotes.length > 0 &&
          rows.length === quotes.length &&
          quotes.every((/** @type {any} */ q) => {
            const mine = rows.filter((r) => same(r.quote_id, q.id));
            const v = data.vendors.find((/** @type {any} */ x) => x.slug === q.vendor);
            return (
              mine.length === 1 &&
              same(mine[0].vendor, v.name) &&
              same(mine[0].plan, q.plan) &&
              Number(mine[0].seats) === q.seats &&
              same(mine[0].billing, q.billing) &&
              plainCents(mine[0].total) === q.quotedCents
            );
          })
        );
      },
    },
    {
      id: 'csv-total',
      title: 'The CSV ends with one total line, the sum of every quote on the site',
      check: ({ state }) => {
        const rows = csvOf(state) ?? [];
        const totals = rows.filter(isTotal);
        const sum = state.vendors.quotes.reduce((/** @type {number} */ t, /** @type {any} */ q) => t + q.quotedCents, 0);
        return totals.length === 1 && isTotal(rows[rows.length - 1]) && sum > 0 && plainCents(totals[0].total) === sum;
      },
    },
    {
      id: 'quote-ref',
      title: 'Every fitting vendor has a request that quotes the brief’s reference',
      canary: true,
      check: ({ data, state }) => fits(data).every((v) => quotesAt(state, v.slug).some((/** @type {any} */ q) => has(q.message, data.ref))),
    },
  ],
  solve(d, state) {
    const [first, rest] = [fits(d).slice(0, FIRST), fits(d).slice(FIRST)];
    request(d, state, first);
    putFile(state, CSV, Buffer.from(csvText(state.vendors.quotes.map((/** @type {any} */ q) => rowFor(d, q))), 'utf8'));
    request(d, state, rest);
    const all = state.vendors.quotes;
    const total = all.reduce((/** @type {number} */ t, /** @type {any} */ q) => t + q.quotedCents, 0);
    putFile(
      state,
      CSV,
      Buffer.from(
        csvText(
          all.map((/** @type {any} */ q) => rowFor(d, q)),
          total,
        ),
        'utf8',
      ),
    );
    return state;
  },
};
