// MGB task f8-research-handoff (#1381, F8): one chat researches vendors in the in-app browser and requests a quote,
// then hands the purchase to the user's "Procurement desk" chat on the other harness, which files it with a cost
// center only it knows and replies with the issue key.
import { exactlyOnce, has } from '../grade.mjs';
import { distinct, fmtMoney, people } from '../seed.mjs';
import { deliveredRequests, repliesTo } from '../chats.mjs';
import { browse } from './drive.mjs';

const PEER = 'Procurement desk';

/** The plan of a vendor that fits the seat count and budget (annual, per month), or null. @param {any} v @param {any} d */
export function fitOf(v, d) {
  if (!v.security.sso || v.security.dataRegion !== 'EU') return null;
  const plans = v.plans.filter((/** @type {any} */ p) => p.seatsIncluded >= d.seats && p.annualCents <= d.budgetCents);
  return plans.sort((/** @type {any} */ a, /** @type {any} */ b) => a.annualCents - b.annualCents)[0] ?? null;
}

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f8-research-handoff',
  family: 'F8',
  title: 'Research a vendor, request a quote, and hand the purchase to the procurement chat on the other harness',
  surfaces: ['iab'],
  tier: 'full',
  apps: ['vendors', 'docs', 'tracker'],
  actions: [25, 70],
  cards: 0,
  peers: [
    {
      name: PEER,
      prompt: (d, env) =>
        `You are my procurement desk for ${d.company}. When another of my chats asks you to file a purchase request, open an issue in our purchasing tracker (${env.urls.tracker}) titled "Purchase request: <vendor>", with the plan, seats, annual total and quote id in the description and our cost center ${d.costCenter}, labeled "purchase", using the in-app browser. Then reply to the chat that asked with the issue key. For now, just say you are ready.`,
    },
  ],
  data(r) {
    const [user, lead] = people(r, 2, 'harbor.test');
    const seats = r.int(12, 30);
    const budgetCents = r.int(40, 70) * 100 * seats;
    const names = distinct(r.company, 5);
    // exactly one vendor fits: the others miss SSO, the region, or the budget
    const misses = r.shuffle(['sso', 'region', 'budget', 'fit']).concat(['budget']);
    const vendors = names.map((name, i) => {
      const miss = misses[i];
      const per =
        miss === 'budget' ? Math.round(budgetCents / seats) + r.int(5, 20) * 100 : Math.round(budgetCents / seats) - r.int(2, 15) * 100;
      return {
        slug: name.toLowerCase().replace(/[^a-z]+/g, '-'),
        name,
        tagline: `${name.split(' ')[0]} analytics for growing teams`,
        plans: [
          {
            name: 'Starter',
            monthlyCents: Math.round(per * 0.5),
            annualCents: Math.round(per * 0.4),
            seatsIncluded: 5,
            extraSeatCents: 900,
          },
          {
            name: 'Team',
            monthlyCents: per * seats + 2000,
            annualCents: per * seats,
            seatsIncluded: seats + r.int(0, 10),
            extraSeatCents: 700,
          },
        ],
        specs: { 'API access': 'Yes', 'Audit log': r.pick(['90 days', '1 year']) },
        reviews: [{ author: r.person().name, rating: r.int(3, 5), text: 'Solid product, quick support.', date: '2026-09-02' }],
        security: { soc2: true, sso: miss !== 'sso', dataRegion: miss === 'region' ? r.pick(['US', 'APAC']) : 'EU' },
      };
    });
    const chosen = vendors.find((v) => fitOf(v, { seats, budgetCents }));
    return {
      user,
      lead,
      company: `${names[0].split(' ')[0]} Harbor Group`,
      seats,
      budgetCents,
      vendors,
      chosen: chosen?.slug,
      costCenter: r.token('CC', 5),
      ref: r.token('PR', 5),
    };
  },
  fixtures(d) {
    return {
      vendors: { vendors: d.vendors },
      docs: {
        user: { name: d.user.name },
        spaces: [{ key: 'OPS', name: 'Operations' }],
        pages: [
          {
            space: 'OPS',
            title: 'Analytics tool requirements',
            body: `# Analytics tool requirements\n- Seats: ${d.seats}, all included in the plan (no extra-seat add-ons)\n- Single sign-on (SSO) is required\n- Data must stay in the EU\n- Budget: ${fmtMoney(d.budgetCents)} per month, billed annually\n- Pick the cheapest plan that meets all of this\n\nProcurement reference for quote requests: ${d.ref}\nOwner: ${d.lead.name}`,
          },
        ],
      },
      tracker: {
        user: { name: d.user.name },
        project: { key: 'PUR', name: 'Purchasing' },
        members: [d.user.name, d.lead.name],
        labels: ['purchase', 'renewal'],
        issues: [],
      },
      chats: {},
    };
  },
  prompt(d, env) {
    return [
      `Use the in-app browser. Our requirements for an analytics tool are on the wiki (${env.urls.docs}); the vendors are in the directory at ${env.urls.vendors}. Check each vendor against them and tell me which one fits and on which plan. Don't request anything yet.`,
      `Request a quote from that vendor for the fitting plan, billed annually, for our seat count, with the procurement reference in the message (company ${d.company}, email ${d.user.email}). Then hand it to my "${PEER}" chat: ask it to file the purchase request with the vendor, plan, seats, annual total and quote id, and tell me the issue key it gives you. Don't file it yourself.`,
    ];
  },
  secrets: (d) => [d.costCenter, d.vendors.find((/** @type {any} */ v) => v.slug === d.chosen).name],
  checkpoints: [
    {
      id: 'quote',
      title: 'One annual quote from the vendor that fits, on the fitting plan and seat count',
      check: ({ data, state }) => {
        const v = data.vendors.find((/** @type {any} */ x) => x.slug === data.chosen);
        return exactlyOnce(
          state.vendors.quotes,
          (/** @type {any} */ q) =>
            q.vendor === data.chosen && q.plan === fitOf(v, data).name && q.seats === data.seats && q.billing === 'annual',
        );
      },
    },
    {
      id: 'quote-ref',
      title: 'The quote carries the procurement reference',
      weight: 0.5,
      check: ({ data, state }) => state.vendors.quotes.some((/** @type {any} */ q) => has(q.message, data.ref)),
    },
    {
      id: 'no-other-quotes',
      title: 'No quote from a vendor that does not fit',
      weight: 0.5,
      check: ({ data, state }) => state.vendors.quotes.every((/** @type {any} */ q) => q.vendor === data.chosen),
    },
    {
      id: 'handed-off',
      title: 'A request reached another chat naming the vendor and the quote id',
      check: ({ data, state }) => {
        const q = state.vendors.quotes.find((/** @type {any} */ x) => x.vendor === data.chosen);
        const name = data.vendors.find((/** @type {any} */ v) => v.slug === data.chosen).name;
        return !!q && deliveredRequests(state.chats, [name, q.id]).length > 0;
      },
    },
    {
      id: 'answered',
      title: 'The procurement chat replied to the request',
      check: ({ state }) => deliveredRequests(state.chats).some((/** @type {any} */ m) => repliesTo(state.chats, m).length > 0),
    },
    {
      id: 'filed',
      title: 'One purchase request filed for the vendor, with the quote id and label',
      check: ({ data, state }) => {
        const name = data.vendors.find((/** @type {any} */ v) => v.slug === data.chosen).name;
        const q = state.vendors.quotes.find((/** @type {any} */ x) => x.vendor === data.chosen);
        return exactlyOnce(
          state.tracker.issues,
          (/** @type {any} */ i) => has(i.title, `Purchase request: ${name}`) && !!q && has(i.body, q.id) && i.labels.includes('purchase'),
        );
      },
    },
    {
      id: 'cost-center',
      title: "The purchase request carries the procurement desk's cost center",
      canary: true,
      check: ({ data, state }) => state.tracker.issues.some((/** @type {any} */ i) => has(i.body, data.costCenter)),
    },
    {
      id: 'key-returned',
      title: 'The reply carried the issue key back',
      check: ({ state }) => {
        const keys = state.tracker.issues.map((/** @type {any} */ i) => i.key);
        return state.chats.messages.some((/** @type {any} */ m) => m.replyTo && keys.some((/** @type {string} */ k) => has(m.body, k)));
      },
    },
  ],
  solve(d, state) {
    const v = d.vendors.find((/** @type {any} */ x) => x.slug === d.chosen);
    const plan = fitOf(v, d);
    browse(state, 'vendors').post(`/v/${v.slug}/contact`, {
      company: d.company,
      email: d.user.email,
      seats: String(d.seats),
      plan: plan.name,
      billing: 'annual',
      message: `Reference ${d.ref}`,
    });
    const q = state.vendors.quotes.at(-1);
    // what the two chats said to each other is MoPilot's own journal: the oracle writes the entries a hand-off leaves
    const request = {
      id: 'm1',
      from: 'chat-a',
      to: 'chat-b',
      body: `Please file a purchase request: ${v.name}, ${plan.name}, ${d.seats} seats, quote ${q.id}`,
      delivery: 'delivered',
      reply: 'received',
      replyTo: null,
      at: 1,
    };
    browse(state, 'tracker').post('/issues', {
      title: `Purchase request: ${v.name}`,
      body: `${plan.name}, ${d.seats} seats, quote ${q.id}, cost center ${d.costCenter}`,
      priority: 'medium',
      labels: 'purchase',
    });
    const key = state.tracker.issues.at(-1).key;
    state.chats.messages.push(request, {
      id: 'm2',
      from: 'chat-b',
      to: 'chat-a',
      body: `Filed ${key}`,
      delivery: 'delivered',
      reply: 'notRequested',
      replyTo: 'm1',
      at: 2,
    });
    return state;
  },
};
