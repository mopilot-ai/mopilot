// MGB task f1-refund-requests (#1381, F1): decide a week of refund requests in the support inbox against the wiki's
// refund policy and the shop's order records, issue the refunds that qualify and answer every customer.
import { has } from '../grade.mjs';
import { dayOffset, distinct, fmtMoney, people } from '../seed.mjs';
import { at, eventsOf, mentionsId, orderTotal, sentTo, slug, textOf } from './common.mjs';
import { browse } from './drive.mjs';

const REQUESTS = 5;
const ORD = ['first', 'second', 'third', 'fourth', 'fifth'];

/**
 * The kinds of request: what the customer claims, how many days ago the order was delivered, whether it came after
 * its promised date, and whether the policy grants it. Every seed has two damaged-or-late requests that qualify, a
 * third of either kind, and two that don't, each for its own reason.
 */
const KINDS = {
  damaged: { claim: 'damaged', ago: [3, 24], late: false, eligible: true },
  late: { claim: 'late', ago: [3, 24], late: true, eligible: true },
  // the claim would qualify, but the order already has a goodwill refund
  refunded: { claim: 'late', ago: [4, 20], late: true, eligible: false },
  old: { claim: 'damaged', ago: [38, 70], late: false, eligible: false },
  // says late, but it arrived on or before its promised date
  early: { claim: 'late', ago: [3, 20], late: false, eligible: false },
  // quotes an order number the shop doesn't have
  missing: { claim: 'damaged', ago: [3, 20], late: false, eligible: false },
};
/** The refund the policy grants for a claim: damaged → the whole total; late → half the items, rounded down. */
const RULE = {
  damaged: (/** @type {any} */ o) => orderTotal(o),
  late: (/** @type {any} */ o) =>
    Math.floor(o.items.reduce((/** @type {number} */ t, /** @type {any} */ i) => t + i.qty * i.priceCents, 0) / 2),
};
const SUBJECT = {
  damaged: (/** @type {string} */ id) => `Damaged item in order ${id}`,
  late: (/** @type {string} */ id) => `Order ${id} arrived late`,
};
const CLAIM = {
  damaged: 'It arrived damaged: the box was crushed and the item is cracked. I would like a refund please.',
  late: 'It arrived days after the date you promised, and I needed it before then. I would like a refund for the delay.',
};
const REASON = { damaged: 'Arrived damaged', late: 'Late delivery' };

/** The requests that qualify, in inbox order. @param {any} d @returns {any[]} */
const eligible = (d) => d.requests.filter((/** @type {any} */ q) => q.eligible);
/** Sent mail to a requester. @param {any} state @param {any} q */
const replies = (state, q) => sentTo(state.mail, q.customer.email);

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f1-refund-requests',
  family: 'F1',
  title: 'Decide refund requests against the refund policy, refund in the shop and answer each customer',
  surfaces: ['iab'],
  tier: 'full',
  apps: ['mail', 'shop', 'docs'],
  actions: [30, 80],
  cards: 0,
  switchBefore: 1,
  data(r, env) {
    const [store, ...supplierNames] = distinct(r.company, 3);
    const [user, colleague] = people(r, 2, `${slug(store)}.test`);
    const customers = people(r, 9, 'mailbox.test');
    const products = distinct(r.product, 8).map((name, i) => ({
      sku: `SKU-${200 + i * 11 + r.int(0, 9)}`,
      name,
      supplierId: `SUP-${1 + (i % 2)}`,
      priceCents: r.int(12, 90) * 100 + r.pick([0, 50, 95]),
      stock: r.int(6, 40),
    }));
    const ids = distinct(() => `SO-${r.int(10000, 99999)}`, 10);
    const kinds = r.shuffle(['damaged', 'late', r.pick(['damaged', 'late']), ...r.sample(['refunded', 'old', 'early', 'missing'], 2)]);
    const cases = distinct(() => r.token('CASE', 4), REQUESTS);
    /** @param {number} i @param {number[]} ago @param {boolean} late */
    const orderFor = (i, ago, late) => {
      const delivered = dayOffset(env.today, -r.int(ago[0], ago[1]));
      const items = r.sample(products, r.int(1, 3)).map((p) => ({ sku: p.sku, name: p.name, qty: r.int(1, 3), priceCents: p.priceCents }));
      const promised = dayOffset(delivered, late ? -r.int(2, 6) : r.int(0, 3));
      return {
        id: ids[i],
        customer: customers[i],
        items,
        shippingCents: r.pick([0, 495, 895]),
        delivered,
        promised,
        created: dayOffset(delivered, -r.int(7, 10)),
      };
    };
    const requests = kinds.map((kind, i) => {
      const k = /** @type {keyof typeof KINDS} */ (kind);
      const spec = KINDS[k];
      const order = orderFor(i, spec.ago, spec.late);
      const cents = spec.eligible ? RULE[/** @type {'damaged' | 'late'} */ (spec.claim)](order) : 0;
      // a missing order is quoted by a number the shop never had
      return {
        kind,
        claim: spec.claim,
        eligible: spec.eligible,
        cents,
        caseNo: cases[i],
        customer: customers[i],
        order,
        quoted: kind === 'missing' ? ids[9] : order.id,
        day: dayOffset(env.today, -1 - (i % 3)),
      };
    });
    // other customers' orders: one still on its way, one refunded in full weeks ago, two delivered without complaint
    const others = [orderFor(5, [-2, -1], false), orderFor(6, [40, 60], false), orderFor(7, [5, 30], false), orderFor(8, [5, 30], false)];
    return { store, user, colleague, supplierNames, products, requests, others, priorCents: r.int(3, 9) * 100 };
  },
  fixtures(d, env) {
    const shopOrder = (
      /** @type {any} */ o,
      /** @type {string} */ status,
      /** @type {any[]} */ refunds,
      note = `Promised delivery ${o.promised}. Delivered ${o.delivered}.`,
    ) => ({
      id: o.id,
      customer: { name: o.customer.name, email: o.customer.email },
      createdAt: at(o.created, 10),
      status,
      items: o.items.map((/** @type {any} */ i) => ({ sku: i.sku, qty: i.qty, priceCents: i.priceCents })),
      shippingCents: o.shippingCents,
      note,
      refunds,
    });
    const goodwill = (/** @type {any} */ o, /** @type {number} */ cents, reason = 'Goodwill credit') => [
      { amountCents: cents, reason, at: at(dayOffset(o.delivered, 1), 15) },
    ];
    const [transit, handled, ...delivered] = d.others;
    const orders = [
      ...d.requests
        .filter((/** @type {any} */ q) => q.kind !== 'missing')
        .map((/** @type {any} */ q) =>
          q.kind === 'refunded'
            ? shopOrder(q.order, 'partially refunded', goodwill(q.order, d.priorCents))
            : shopOrder(q.order, 'delivered', []),
        ),
      shopOrder(transit, 'shipped', [], `Shipped ${dayOffset(transit.created, 2)}. Promised delivery ${transit.promised}.`),
      shopOrder(handled, 'refunded', goodwill(handled, orderTotal(handled), 'Arrived damaged')),
      ...delivered.map((/** @type {any} */ o) => shopOrder(o, 'delivered', [])),
    ];
    const support = `support@${slug(d.store)}.test`;
    const messages = [
      ...d.requests.map((/** @type {any} */ q) => ({
        from: { name: q.customer.name, email: q.customer.email },
        to: support,
        subject: SUBJECT[/** @type {'damaged' | 'late'} */ (q.claim)](q.quoted),
        body: `Hello,\n\nThis is about my order ${q.quoted}. ${CLAIM[/** @type {'damaged' | 'late'} */ (q.claim)]}\n\nYour automatic reply gave me case number ${q.caseNo}.\n\nThanks,\n${q.customer.first}`,
        date: at(q.day, 9),
      })),
      {
        from: { name: transit.customer.name, email: transit.customer.email },
        to: support,
        subject: `Where is order ${transit.id}?`,
        body: 'It shipped a while ago. Can you tell me when it will arrive? Not asking for a refund, just an update.',
        date: at(dayOffset(env.today, -1), 14),
      },
      {
        from: { name: handled.customer.name, email: handled.customer.email },
        to: support,
        subject: `Refund request for ${handled.id}`,
        body: 'The lamp arrived broken. Please refund me.',
        date: at(dayOffset(handled.delivered, 2), 11),
        read: true,
      },
      {
        folder: 'sent',
        from: { name: d.user.name, email: support },
        to: handled.customer.email,
        subject: `Re: Refund request for ${handled.id}`,
        body: `Hi ${handled.customer.first}, we have refunded order ${handled.id} in full.`,
        date: at(dayOffset(handled.delivered, 3), 10),
      },
      {
        from: { name: d.colleague.name, email: d.colleague.email },
        subject: 'Covering the desk on Friday',
        body: 'I can take the support desk on Friday afternoon if you need.',
        date: at(dayOffset(env.today, -2), 16),
      },
      {
        from: { name: `${d.supplierNames[0]} News`, email: `news@${slug(d.supplierNames[0])}.test` },
        subject: 'Autumn catalog and new lead times',
        body: 'Our autumn catalog is live. Lead times are now 5 working days.',
        date: at(dayOffset(env.today, -3), 7),
      },
    ];
    return {
      mail: { user: { name: d.user.name, email: support }, messages },
      shop: {
        user: { name: d.user.name },
        suppliers: d.supplierNames.map((/** @type {string} */ name, /** @type {number} */ i) => ({
          id: `SUP-${i + 1}`,
          name,
          email: `orders@${slug(name)}.test`,
        })),
        products: d.products,
        orders,
      },
      docs: {
        user: { name: d.user.name },
        spaces: [
          { key: 'SUP', name: 'Customer support' },
          { key: 'ARC', name: 'Archive' },
        ],
        pages: [
          {
            space: 'SUP',
            title: 'Refund policy',
            author: d.colleague.name,
            updatedAt: at(dayOffset(env.today, -40), 10),
            body: `# Refund policy\nThis is the current policy for every refund request. Look the order up in the shop admin first: its note gives the promised and the actual delivery date.\n# What we refund\n- Item arrived damaged: refund the full order total, shipping included.\n- Order arrived late, meaning delivered after its promised delivery date: refund 50% of the order total not counting shipping, rounded down to the cent.\n- Either refund only applies when the order was delivered at most 30 days before today.\n# When we don't refund\n- The order number is not in the shop admin: ask the customer to check it.\n- The order already has a refund of any amount, a goodwill credit included.\n- The order was delivered more than 30 days ago.\n- The customer says it was late but it arrived on or before its promised date.\n# Replying\n- Answer every request, and quote the customer's case number so the reply files under it.\n- When you refund, give the refund number the shop admin shows.`,
          },
          {
            space: 'ARC',
            title: 'Refund policy 2024 (superseded)',
            updatedAt: '2024-11-02T10:00:00Z',
            body: '# Refund policy 2024\nSuperseded by the current Refund policy.\n- Damaged or late: full refund within 60 days of delivery.',
          },
          {
            space: 'SUP',
            title: 'Support desk rota',
            body: '- Monday to Wednesday: support team A\n- Thursday and Friday: support team B',
          },
        ],
      },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name} on the support desk at ${d.store}. Use the in-app browser. Our support inbox (${env.urls.mail}) has this week's refund requests. For each one, look the order up in our shop admin (${env.urls.shop}) and check it against our refund policy in the team wiki (${env.urls.docs}). Tell me which requests qualify and how much each refund should be. Don't change anything yet.`,
      `Thanks. Now issue the refunds that qualify in the shop admin, with the customer's reason. Then reply to every customer who asked for a refund (use Reply on their email) and quote their case number. If they got a refund, give them the refund number the shop shows; if not, tell them briefly why.`,
    ];
  },
  secrets: (d) => [...d.requests.map((/** @type {any} */ q) => q.caseNo), ...eligible(d).map((q) => fmtMoney(q.cents))],
  checkpoints: [
    ...[0, 1, 2].map((k) => ({
      id: `refund-${k}`,
      title: `The ${ORD[k]} qualifying order has exactly one refund, of the amount the policy gives`,
      check: (/** @type {any} */ { data, state }) => {
        const q = eligible(data)[k];
        const list = state.shop.refunds.filter((/** @type {any} */ x) => x.orderId === q.order.id);
        return list.length === 1 && list[0].amountCents === q.cents;
      },
    })),
    {
      id: 'no-wrong-refund',
      title: 'No refund on an order the policy refuses',
      weight: 0.5,
      check: ({ data, state }) =>
        eventsOf(state.shop, 'refunded').every((/** @type {any} */ e) => eligible(data).some((q) => q.order.id === e.orderId)),
    },
    ...[0, 1, 2, 3, 4].map((k) => ({
      id: `reply-${k}`,
      title: `The ${ORD[k]} requester gets exactly one reply`,
      check: (/** @type {any} */ { data, state }) => replies(state, data.requests[k]).length === 1,
    })),
    {
      id: 'case-numbers',
      title: 'Every reply quotes the customer’s case number',
      canary: true,
      check: ({ data, state }) =>
        data.requests.every((/** @type {any} */ q) => replies(state, q).some((/** @type {any} */ m) => has(textOf(m), q.caseNo))),
    },
    ...[0, 1, 2].map((k) => ({
      id: `refund-id-${k}`,
      title: `The ${ORD[k]} refunded customer is told the shop’s refund number`,
      check: (/** @type {any} */ { data, state }) => {
        const q = eligible(data)[k];
        const refund = state.shop.refunds.find((/** @type {any} */ x) => x.orderId === q.order.id);
        return !!refund && replies(state, q).some((/** @type {any} */ m) => mentionsId(textOf(m), refund.id));
      },
    })),
  ],
  solve(d, state) {
    const shop = browse(state, 'shop');
    const mail = browse(state, 'mail');
    for (const q of d.requests) {
      let answer = `we can't refund order ${q.quoted} under our refund policy.`;
      if (q.eligible) {
        const res = shop.post(`/orders/${q.order.id}/refund`, {
          amount: (q.cents / 100).toFixed(2),
          reason: REASON[/** @type {'damaged' | 'late'} */ (q.claim)],
        });
        // the shop names the new refund in its confirmation
        const [, id] = /** @type {RegExpExecArray} */ (/Refund (RF-\d+)/.exec(decodeURIComponent(res.headers.location)));
        answer = `we have refunded ${fmtMoney(q.cents)}, refund number ${id}.`;
      }
      const msg = state.mail.messages.find((/** @type {any} */ m) => m.folder === 'inbox' && m.from.email === q.customer.email);
      mail.post('/compose', {
        to: q.customer.email,
        subject: `Re: ${msg.subject}`,
        body: `Hi ${q.customer.first},\n\nAbout case ${q.caseNo}: ${answer}\n\n${d.user.first}`,
        reply: msg.id,
      });
    }
    return state;
  },
};
