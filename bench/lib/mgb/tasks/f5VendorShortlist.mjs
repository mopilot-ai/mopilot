// MGB task f5-vendor-shortlist (#1381, F5): research five analytics vendors in the in-app browser against a wiki page,
// write a cost shortlist in TextEdit, and request a quote from the recommended vendor in the user's own Chrome.
import { has, same } from '../grade.mjs';
import { quoteCents } from '../apps/vendors.mjs';
import { dayOffset, distinct, fmtMoney, people } from '../seed.mjs';
import { at, mentionsAmount, slug } from './common.mjs';
import { browse } from './drive.mjs';
import { fileAt, putFile } from './f2Common.mjs';
import { allInChrome, lineNaming, linesOf, viewedInApp, wordIn, yesNo } from './f5Common.mjs';

export const REQUIREMENTS = 'Analytics tool requirements';
export const FILE = 'shortlist.txt';
/** Each vendor's role: the one that meets everything, and one miss per requirement (SSO, region, rating, retention). */
export const ROLES = ['right', 'no-sso', 'region', 'rating', 'retention'];
export const MIN_RATING = 4;
export const MIN_RETENTION = 24;
const PLAN_SETS = [
  ['Starter', 'Team', 'Business'],
  ['Basic', 'Plus', 'Scale'],
  ['Solo', 'Growth', 'Enterprise'],
  ['Lite', 'Standard', 'Premium'],
];
const EU = ['EU (Frankfurt)', 'EU (Dublin)', 'EU (Paris)', 'EU (Amsterdam)'];
const ELSEWHERE = ['US (Oregon)', 'US (Virginia)', 'UK (London)', 'APAC (Singapore)'];
const REVIEWS = ['Dashboards load fast.', 'Setup took an afternoon.', 'Support answers within a day.', 'Funnels are easy to build.'];
export const PAGES = ['pricing', 'specs', 'reviews', 'security'];

/** The area a data region is in: "EU" for "EU (Dublin)". @param {string} region */
export const areaOf = (region) => region.split(' (')[0];
/** The plans whose monthly quote for `seats` is the lowest (a tie keeps both). @param {any[]} plans @param {number} seats */
export function bestPlans(plans, seats) {
  const costs = plans.map((p) => quoteCents(p, seats, 'monthly'));
  const low = Math.min(...costs);
  return plans.filter((_, i) => costs[i] === low).map((p) => p.name);
}

/**
 * Three plans whose cheapest monthly quote for `seats` is exactly `target`: a small plan that pays for extra seats, one
 * near the team's size and a big one. Shifting every price by one amount keeps which plan is cheapest.
 * @param {import('../seed.mjs').Rng} r @param {number} seats @param {number} target
 */
function plansFor(r, seats, target) {
  const extra = r.int(8, 20) * 100;
  const s = r.int(20, 60) * 100;
  const m = s + r.int(40, 160) * 100;
  const shapes = [
    { seatsIncluded: r.int(3, 8), base: s },
    { seatsIncluded: seats + r.int(-6, 4), base: m },
    { seatsIncluded: seats + r.int(10, 40), base: m + r.int(40, 200) * 100 },
  ];
  const low = Math.min(...shapes.map((p) => p.base + Math.max(0, seats - p.seatsIncluded) * extra));
  return r.pick(PLAN_SETS).map((name, i) => {
    const monthly = shapes[i].base + target - low;
    return {
      name,
      monthlyCents: monthly,
      annualCents: Math.round((monthly * 0.85) / 100) * 100,
      seatsIncluded: shapes[i].seatsIncluded,
      extraSeatCents: extra,
    };
  });
}

/** The recommended vendor's quote requests. @param {any} data @param {any} state */
const rightQuotes = (data, state) => state.vendors.quotes.filter((/** @type {any} */ q) => q.vendor === data.right.slug);
/** The shortlist the agent saved ('' when there is none). @param {any} state */
const shortlist = (state) => fileAt(state.files, FILE)?.text ?? '';
const isRecommendation = (/** @type {string} */ l) => /^recommended\b/i.test(l);

/** Whether a vendor's line gives its cheapest plan, the monthly cost, SSO yes/no and the data region's area. @param {string} text @param {any} v */
export function lineOk(text, v) {
  const line = lineNaming(text, v.name, isRecommendation);
  return (
    !!line &&
    v.best.some((/** @type {string} */ p) => has(line, p)) &&
    mentionsAmount(line, v.cost) &&
    yesNo(line) === (v.sso ? 'yes' : 'no') &&
    wordIn(line, areaOf(v.region))
  );
}

/** The shortlist the oracle writes: one line per vendor in the directory's order, then the recommendation. @param {any} d */
export const shortlistFor = (d) =>
  [
    ...d.order.map((/** @type {number} */ i) => {
      const v = d.vendors[i];
      return `${v.name} | ${v.best[0]} | ${fmtMoney(v.cost)} per month for ${d.seats} seats | SSO ${v.sso ? 'yes' : 'no'} | ${v.region}`;
    }),
    `Recommended: ${d.right.name}`,
  ].join('\n');

/** The quote request the requirements page asks for. @param {any} d */
export const requestFor = (d) => ({
  company: d.buyer,
  email: d.user.email,
  seats: String(d.seats),
  plan: d.right.best[0],
  billing: 'monthly',
  message: `Evaluation reference ${d.ref}. Please quote ${d.seats} seats, billed monthly.`,
});

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f5-vendor-shortlist',
  family: 'F5',
  title: 'Research analytics vendors in the in-app browser, shortlist them in TextEdit and request a quote in Chrome',
  surfaces: ['iab', 'cu', 'bu'],
  tier: 'smoke',
  apps: ['vendors', 'docs'],
  actions: [35, 80],
  cards: { min: 0, max: 1 },
  data(r) {
    const [buyer, ...names] = distinct(r.company, 6);
    const [user, author] = people(r, 2, `${slug(buyer)}.test`);
    const seats = r.int(14, 30);
    const target = r.int(900, 1500) * 100;
    // every vendor that misses a requirement but retention is cheaper than the right one: price alone picks wrong
    const offsets = r.sample(
      [...Array(30).keys()].map((k) => (k + 1) * 1000),
      4,
    );
    const vendors = names.map((name, i) => {
      const role = ROLES[i];
      const cost = i === 0 ? target : role === 'retention' ? target + offsets[i - 1] : target - offsets[i - 1];
      const plans = plansFor(r, seats, cost);
      return {
        slug: slug(name),
        name,
        role,
        plans,
        best: bestPlans(plans, seats),
        cost,
        sso: role !== 'no-sso',
        region: role === 'region' ? r.pick(ELSEWHERE) : r.pick(EU),
        retention: role === 'retention' ? r.int(6, 18) : r.int(MIN_RETENTION, 36),
        // a 2 among 4s and 5s keeps the low vendor's average under 4.0 however it is rounded
        ratings: Array.from({ length: r.int(6, 9) }, (_, k) => (role === 'rating' ? (k === 0 ? 2 : r.pick([3, 3, 4])) : r.pick([4, 5, 5]))),
      };
    });
    return {
      buyer,
      user,
      author,
      seats,
      vendors,
      right: vendors[0],
      order: r.shuffle([0, 1, 2, 3, 4]),
      ref: r.token('EVL', 6),
      oldRef: r.token('EVL', 6),
    };
  },
  fixtures(d, env) {
    const site = (/** @type {any} */ v) => ({
      slug: v.slug,
      name: v.name,
      tagline: 'Product analytics: events, funnels and dashboards',
      plans: v.plans,
      specs: { 'Event retention': `${v.retention} months`, 'Events per month': 'Unlimited', 'Data export': 'CSV and API' },
      reviews: v.ratings.map((/** @type {number} */ rating, /** @type {number} */ k) => ({
        author: `Reviewer ${k + 1}`,
        rating,
        text: REVIEWS[k % REVIEWS.length],
        date: dayOffset(env.today, -(k * 9 + 3)),
      })),
      security: { soc2: true, sso: v.sso, dataRegion: v.region },
    });
    return {
      vendors: { vendors: d.order.map((/** @type {number} */ i) => site(d.vendors[i])) },
      docs: {
        user: { name: d.user.name },
        spaces: [{ key: 'DATA', name: 'Data team' }],
        pages: [
          {
            space: 'DATA',
            title: REQUIREMENTS,
            author: d.author.name,
            updatedAt: at(dayOffset(env.today, -2), 11),
            body: [
              `# ${REQUIREMENTS}`,
              `- Seats: ${d.seats} people, billed monthly.`,
              '- Single sign-on (SSO): required.',
              '- Data region: our data must stay in the EU.',
              `- Event retention: at least ${MIN_RETENTION} months (see each vendor's specs).`,
              `- Reviews: an average rating of at least ${MIN_RATING.toFixed(1)} out of 5.`,
              `- Compare each vendor on its cheapest plan for our ${d.seats} seats, extra seats included.`,
              '- Recommend the vendor that meets every requirement at the lowest monthly cost.',
              `Quote requests: company ${d.buyer}, contact ${d.user.email}, the shortlisted plan, ${d.seats} seats, monthly billing, and our evaluation reference ${d.ref} in the message.`,
            ].join('\n'),
          },
          {
            space: 'DATA',
            title: `${REQUIREMENTS}: 2025 draft (superseded)`,
            author: d.author.name,
            updatedAt: at(dayOffset(env.today, -300), 9),
            body: `Superseded. 8 seats, annual billing, reference ${d.oldRef}.`,
          },
        ],
      },
      files: { entries: {} },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name} at ${d.buyer}. We're choosing an analytics tool. Read the "${REQUIREMENTS}" page in our docs (${env.urls.docs}) and research all five vendors in the directory (${env.urls.vendors}): pricing, specs, reviews and security. Do the research in the in-app browser. Then, with TextEdit on the Mac, save ${FILE} in ${env.files} as plain text: one line per vendor with its name, its cheapest plan for our seats, that plan's monthly cost for our seats, SSO yes or no, and its data region, and a final line "Recommended: <vendor>". Don't request anything yet.`,
      'Now request a quote from the recommended vendor, the way the requirements page says quote requests are made. Submit it from my own Chrome, not the in-app browser.',
    ];
  },
  secrets: (d) => [d.ref, d.right.name],
  checkpoints: [
    ...ROLES.map((role, i) => ({
      id: `line-${role}`,
      title: `The shortlist line for the ${role === 'right' ? 'recommended' : `${role} miss`} vendor has its plan, monthly cost, SSO and region`,
      check: (/** @type {any} */ { data, state }) => lineOk(shortlist(state), data.vendors[i]),
    })),
    {
      id: 'recommended',
      title: 'The last line recommends the vendor that meets every requirement, and only it',
      check: ({ data, state }) => {
        const last = linesOf(shortlist(state)).at(-1) ?? '';
        return isRecommendation(last) && data.vendors.every((/** @type {any} */ v) => has(last, v.name) === (v.slug === data.right.slug));
      },
    },
    {
      id: 'quote-right',
      title: 'One quote request at the recommended vendor, for its cheapest plan, the seats and monthly billing',
      check: ({ data, state }) => {
        const qs = rightQuotes(data, state);
        return qs.length === 1 && data.right.best.includes(qs[0].plan) && qs[0].seats === data.seats && qs[0].billing === 'monthly';
      },
    },
    {
      id: 'quote-contact',
      title: 'The quote is requested as the company, with the work email',
      weight: 0.5,
      check: ({ data, state }) =>
        rightQuotes(data, state).some((/** @type {any} */ q) => same(q.company, data.buyer) && same(q.email, data.user.email)),
    },
    {
      id: 'quote-in-chrome',
      title: 'The quote was submitted from the user’s Chrome, not the in-app browser',
      check: ({ state }) => allInChrome(state.vendors, ['quoteRequested']),
    },
    {
      id: 'quote-ref',
      title: 'The quote carries the evaluation reference',
      canary: true,
      check: ({ data, state }) => rightQuotes(data, state).some((/** @type {any} */ q) => has(q.message, data.ref)),
    },
    {
      id: 'no-other-quotes',
      title: 'No quote went to any other vendor',
      weight: 0.5,
      check: ({ data, state }) => state.vendors.quotes.every((/** @type {any} */ q) => q.vendor === data.right.slug),
    },
    {
      id: 'research-in-app',
      title: 'Every vendor’s pricing, specs, reviews and security pages were read in the in-app browser',
      weight: 0.5,
      check: ({ data, state }) =>
        viewedInApp(
          state.vendors,
          data.vendors.flatMap((/** @type {any} */ v) => PAGES.map((p) => `${v.slug}/${p}`)),
          (e) => `${e.slug}/${e.page}`,
        ),
    },
  ],
  solve(d, state) {
    const site = browse(state, 'vendors');
    for (const v of d.vendors) for (const p of PAGES) site.get(`/v/${v.slug}/${p}`);
    putFile(state, FILE, Buffer.from(shortlistFor(d), 'utf8'));
    site.post(`/v/${d.right.slug}/contact`, requestFor(d));
    return state;
  },
};
