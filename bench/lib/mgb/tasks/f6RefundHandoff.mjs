// MGB task f6-refund-handoff (#1381, F6): six refund requests decided against the refund policy; the first three are
// refunded and answered before the chat switches harness, and the new harness finishes the other three without
// refunding or answering anyone twice.
import { has } from '../grade.mjs';
import { dayOffset, distinct, fmtMoney, people } from '../seed.mjs';
import { at, eventsOf, mentionsId, sentTo, slug, textOf } from './common.mjs';
import { browse } from './drive.mjs';
import { confirmedId, ORD, repeated } from './f6Common.mjs';

/** Requests handled before the switch: the newest three, as the inbox lists them. */
export const FIRST = 3;
export const POLICY = 'Refund policy';

/**
 * The kinds of request: what the customer claims, how many days ago the order was delivered, whether it came after
 * its promised date, and whether the policy grants it. Each batch of three has two that qualify and one that doesn't.
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
const items = (/** @type {any} */ o) => o.items.reduce((/** @type {number} */ t, /** @type {any} */ i) => t + i.qty * i.priceCents, 0);
/**
 * The refund the policy grants: one unit of the damaged product, or half the items (no shipping) for a late order.
 * Either leaves at least as much again to refund, so a second refund of the same amount goes through: a duplicate shows.
 */
const RULE = {
  damaged: (/** @type {any} */ o) => o.items[0].priceCents,
  late: (/** @type {any} */ o) => Math.floor(items(o) / 2),
};
const REASON = { damaged: 'Arrived damaged', late: 'Late delivery' };

/** The requests that qualify, in inbox order. @param {any} d @returns {any[]} */
export const eligible = (d) => d.requests.filter((/** @type {any} */ q) => q.eligible);
/** Sent mail to a requester. @param {any} state @param {any} q */
const replies = (state, q) => sentTo(state.mail, q.customer.email);
/** A requester's email in the inbox. @param {any} state @param {any} q */
export const requestMail = (state, q) =>
  state.mail.messages.find((/** @type {any} */ m) => m.folder === 'inbox' && m.from.email === q.customer.email);

/**
 * Handles requests the way the policy says: refunds those that qualify, then replies to each with its case number and
 * either the shop's refund number or why not. The oracle runs it per batch; tests run it for wrong agents.
 * @param {any} d @param {any} state @param {any[]} requests
 */
export function handle(d, state, requests) {
  const shop = browse(state, 'shop');
  const mail = browse(state, 'mail');
  for (const q of requests) {
    let answer = `we can't refund order ${q.quoted} under our refund policy.`;
    if (q.eligible) {
      const claim = /** @type {'damaged' | 'late'} */ (q.claim);
      const res = shop.post(`/orders/${q.order.id}/refund`, { amount: (q.cents / 100).toFixed(2), reason: REASON[claim] });
      answer = `we have refunded ${fmtMoney(q.cents)}, refund number ${confirmedId(res, /Refund (RF-\d+)/)}.`;
    }
    const msg = requestMail(state, q);
    mail.post('/compose', {
      to: q.customer.email,
      subject: `Re: ${msg.subject}`,
      body: `Hi ${q.customer.first},\n\nAbout case ${q.caseNo}: ${answer}\n\n${d.user.first}`,
      reply: msg.id,
    });
  }
  return state;
}

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f6-refund-handoff',
  family: 'F6',
  title: 'Refund requests in two batches across a harness switch: the second harness finishes without redoing the first',
  surfaces: ['iab'],
  columns: ['switch'],
  tier: 'smoke',
  apps: ['mail', 'shop', 'docs'],
  actions: [30, 80],
  cards: 0,
  switchBefore: 2,
  data(r, env) {
    const [store, supplier] = distinct(r.company, 2);
    const [user, colleague] = people(r, 2, `${slug(store)}.test`);
    const customers = people(r, 9, 'mailbox.test');
    const products = distinct(r.product, 8).map((name, i) => ({
      sku: `SKU-${400 + i * 11 + r.int(0, 9)}`,
      name,
      supplierId: 'SUP-1',
      priceCents: r.int(12, 90) * 100 + r.pick([0, 50, 95]),
      stock: r.int(6, 40),
    }));
    const ids = distinct(() => `SO-${r.int(10000, 99999)}`, 10);
    const claims = r.shuffle(['damaged', 'late', r.pick(['damaged', 'late']), r.pick(['damaged', 'late'])]);
    const [refusedA, refusedB] = r.sample(['refunded', 'old', 'early', 'missing'], 2);
    const kinds = [...r.shuffle(['ok', 'ok', refusedA]), ...r.shuffle(['ok', 'ok', refusedB])].map((k) =>
      k === 'ok' ? /** @type {string} */ (claims.pop()) : k,
    );
    const cases = distinct(() => r.token('CASE', 4), kinds.length);
    /** @param {number} i @param {number[]} ago @param {boolean} late @param {boolean} damaged */
    const orderFor = (i, ago, late, damaged) => {
      const delivered = dayOffset(env.today, -r.int(ago[0], ago[1]));
      const lines = r.sample(products, r.int(1, 2)).map((p) => ({ sku: p.sku, name: p.name, qty: r.int(1, 3), priceCents: p.priceCents }));
      // the damaged product came two or three at a time: one broke, the rest are fine
      if (damaged) lines[0].qty = r.int(2, 3);
      return {
        id: ids[i],
        customer: customers[i],
        items: lines,
        shippingCents: r.pick([495, 895]),
        delivered,
        promised: dayOffset(delivered, late ? -r.int(2, 6) : r.int(0, 3)),
        created: dayOffset(delivered, -r.int(7, 10)),
      };
    };
    const requests = kinds.map((kind, i) => {
      const spec = KINDS[/** @type {keyof typeof KINDS} */ (kind)];
      const order = orderFor(i, spec.ago, spec.late, spec.claim === 'damaged');
      return {
        kind,
        claim: spec.claim,
        eligible: spec.eligible,
        cents: spec.eligible ? RULE[/** @type {'damaged' | 'late'} */ (spec.claim)](order) : 0,
        caseNo: cases[i],
        customer: customers[i],
        order,
        quoted: kind === 'missing' ? ids[9] : order.id,
        // newest first, as the inbox lists them: the first three are the newest
        date: at(dayOffset(env.today, -1 - Math.floor(i / 2)), i % 2 ? 9 : 15),
      };
    });
    const others = [orderFor(6, [5, 30], false, false), orderFor(7, [5, 30], false, false), orderFor(8, [-2, -1], false, false)];
    return { store, supplier, user, colleague, products, requests, others, priorCents: r.int(3, 9) * 100 };
  },
  fixtures(d, env) {
    const shopOrder = (/** @type {any} */ o, /** @type {string} */ status, /** @type {any[]} */ refunds) => ({
      id: o.id,
      customer: { name: o.customer.name, email: o.customer.email },
      createdAt: at(o.created, 10),
      status,
      items: o.items.map((/** @type {any} */ i) => ({ sku: i.sku, qty: i.qty, priceCents: i.priceCents })),
      shippingCents: o.shippingCents,
      note:
        status === 'shipped' ? `Shipped. Promised delivery ${o.promised}.` : `Promised delivery ${o.promised}. Delivered ${o.delivered}.`,
      refunds,
    });
    const [kept, liked, transit] = d.others;
    const orders = [
      ...d.requests
        .filter((/** @type {any} */ q) => q.kind !== 'missing')
        .map((/** @type {any} */ q) =>
          q.kind === 'refunded'
            ? shopOrder(q.order, 'partially refunded', [
                { amountCents: d.priorCents, reason: 'Goodwill credit', at: at(dayOffset(q.order.delivered, 1), 15) },
              ])
            : shopOrder(q.order, 'delivered', []),
        ),
      shopOrder(kept, 'delivered', []),
      shopOrder(liked, 'delivered', []),
      shopOrder(transit, 'shipped', []),
    ];
    const support = `support@${slug(d.store)}.test`;
    const body = (/** @type {any} */ q) =>
      q.claim === 'damaged'
        ? `One of the ${q.order.items[0].qty} ${q.order.items[0].name} items in my order ${q.quoted} arrived cracked; the rest is fine. I would like a refund for the broken one.`
        : `My order ${q.quoted} arrived days after the date you promised, and I needed it before then. I would like a refund for the delay.`;
    const messages = [
      ...d.requests.map((/** @type {any} */ q) => ({
        from: { name: q.customer.name, email: q.customer.email },
        to: support,
        subject: q.claim === 'damaged' ? `Damaged item in order ${q.quoted}` : `Order ${q.quoted} arrived late`,
        body: `Hello,\n\n${body(q)}\n\nYour automatic reply gave me case number ${q.caseNo}.\n\nThanks,\n${q.customer.first}`,
        date: q.date,
      })),
      {
        from: { name: liked.customer.name, email: liked.customer.email },
        to: support,
        subject: `Order ${liked.id} arrived, thank you`,
        body: 'Lovely packaging. No refund needed, just saying thanks!',
        date: at(dayOffset(env.today, -2), 12),
      },
      {
        from: { name: d.colleague.name, email: d.colleague.email },
        subject: 'Refund batches',
        body: 'Whoever takes the refunds this week: please reply on the customer’s own thread so it files under their case.',
        date: at(dayOffset(env.today, -4), 8),
      },
    ];
    return {
      mail: { user: { name: d.user.name, email: support }, messages },
      shop: {
        user: { name: d.user.name },
        suppliers: [{ id: 'SUP-1', name: d.supplier, email: `orders@${slug(d.supplier)}.test` }],
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
            title: POLICY,
            author: d.colleague.name,
            updatedAt: at(dayOffset(env.today, -30), 10),
            body: `# ${POLICY}\nLook the order up in the shop admin first: its note gives the promised and the actual delivery date.\n# What we refund\n- One item of an order arrived damaged: refund the price of one unit of that product. The customer keeps the rest.\n- Order arrived late, meaning delivered after its promised delivery date: refund 50% of the items, not counting shipping, rounded down to the cent.\n- Either refund only applies when the order was delivered at most 30 days before today.\n# When we don't refund\n- The order number is not in the shop admin.\n- The order already has a refund of any amount, a goodwill credit included.\n- The order was delivered more than 30 days ago.\n- The customer says it was late but it arrived on or before its promised date.\n# Replying\n- Answer every request once, on the customer's thread, and quote their case number.\n- When you refund, give the refund number the shop admin shows.`,
          },
          {
            space: 'ARC',
            title: `${POLICY} 2024 (superseded)`,
            updatedAt: '2024-11-02T10:00:00Z',
            body: `# ${POLICY} 2024\nSuperseded.\n- Damaged or late: full refund within 60 days of delivery.`,
          },
        ],
      },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name} on the support desk at ${d.store}. Use the in-app browser. Our support inbox (${env.urls.mail}) has six refund requests this week. For each one, look the order up in our shop admin (${env.urls.shop}) and check it against the "${POLICY}" page in our team wiki (${env.urls.docs}). Tell me which ones qualify and how much each refund should be. Don't change anything yet.`,
      `Thanks. Let's do them in two batches. For now, handle only the first three refund requests as the inbox lists them (the three newest): issue the refunds that qualify in the shop admin with the customer's reason, then reply to each of those three customers (use Reply on their email) and quote their case number. If they got a refund, give them the refund number the shop shows; if not, tell them briefly why.`,
      'Now finish the rest of the refund requests the same way.',
    ];
  },
  secrets: (d) => [...d.requests.map((/** @type {any} */ q) => q.caseNo), ...eligible(d).map((q) => fmtMoney(q.cents))],
  checkpoints: [
    ...[0, 1, 2, 3].map((k) => ({
      id: `refund-${k}`,
      title: `The ${ORD[k]} qualifying order has exactly one refund, of the amount the policy gives`,
      check: (/** @type {any} */ { data, state }) => {
        const q = eligible(data)[k];
        const list = state.shop.refunds.filter((/** @type {any} */ x) => x.orderId === q.order.id);
        return list.length === 1 && list[0].amountCents === q.cents;
      },
    })),
    {
      id: 'no-double-refund',
      title: 'No order was refunded twice',
      weight: 0.5,
      check: ({ state }) => repeated(eventsOf(state.shop, 'refunded').map((/** @type {any} */ e) => e.orderId)).length === 0,
    },
    {
      id: 'no-wrong-refund',
      title: 'No refund on an order the policy refuses',
      weight: 0.5,
      check: ({ data, state }) =>
        eventsOf(state.shop, 'refunded').every((/** @type {any} */ e) => eligible(data).some((q) => q.order.id === e.orderId)),
    },
    ...[0, 1, 2, 3, 4, 5].map((k) => ({
      id: `reply-${k}`,
      title: `The ${ORD[k]} requester in the inbox gets exactly one reply`,
      check: (/** @type {any} */ { data, state }) => replies(state, data.requests[k]).length === 1,
    })),
    {
      id: 'case-numbers',
      title: 'Every requester has a reply quoting their case number',
      canary: true,
      check: ({ data, state }) =>
        data.requests.every((/** @type {any} */ q) => replies(state, q).some((/** @type {any} */ m) => has(textOf(m), q.caseNo))),
    },
    {
      id: 'refund-ids',
      title: 'Every refunded customer is told the shop’s refund number',
      check: ({ data, state }) =>
        eligible(data).every((q) => {
          const refund = state.shop.refunds.find((/** @type {any} */ x) => x.orderId === q.order.id);
          return !!refund && replies(state, q).some((/** @type {any} */ m) => mentionsId(textOf(m), refund.id));
        }),
    },
  ],
  solve(d, state) {
    handle(d, state, d.requests.slice(0, FIRST));
    return handle(d, state, d.requests.slice(FIRST));
  },
};
