// MGB task f8-usage-limit (#1381, F8): the provider answers with a usage-limit error in the middle of a run of
// approved refunds; the user must be told, and after it lifts the work must finish without anything done twice.
import { exactlyOnce, has } from '../grade.mjs';
import { dayOffset, distinct, fmtMoney, people } from '../seed.mjs';
import { at, sentTo, textOf } from './common.mjs';
import { browse } from './drive.mjs';

const REFUNDS = 5;

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f8-usage-limit',
  family: 'F8',
  title: 'Issue approved refunds through a usage-limit error mid-run, without doing any twice',
  surfaces: ['iab'],
  columns: ['claude'],
  tier: 'full',
  apps: ['mail', 'shop'],
  actions: [25, 60],
  cards: 0,
  // the limit lands a few model requests into the refunds, after the first message's look around
  limit: { afterRequests: 12 },
  data(r, env) {
    const [user, manager, ...customers] = people(r, 2 + REFUNDS + 2, 'copperleaf.test');
    const ids = distinct(() => `ORD-${r.int(10000, 99999)}`, REFUNDS + 2);
    const sku = r.token('SKU', 4);
    const orders = ids.map((id, i) => ({
      id,
      customer: customers[i],
      priceCents: r.int(30, 180) * 100,
      qty: r.int(1, 3),
      day: dayOffset(env.today, -3 - i),
    }));
    // every approved amount is part of the order's total, so one refund each is right and a second one is visible
    const approved = orders
      .slice(0, REFUNDS)
      .map((o) => ({ order: o.id, cents: Math.round((o.priceCents * o.qty * r.int(20, 80)) / 100 / 100) * 100 }));
    return { user, manager, sku, product: r.product(), orders, approved, approval: r.token('APR', 6) };
  },
  fixtures(d, env) {
    return {
      mail: {
        user: { name: d.user.name, email: d.user.email },
        messages: [
          {
            from: { name: d.manager.name, email: d.manager.email },
            subject: 'Approved refunds',
            body: `Hi ${d.user.first},\n\nThese partial refunds are approved (approval ${d.approval}), reason "goodwill":\n${d.approved.map((/** @type {any} */ a) => `- ${a.order}: ${fmtMoney(a.cents)}`).join('\n')}\n\nWhen they're all done, send me one reply listing each order with its refund id, and quote the approval.\n${d.manager.first}`,
            date: at(env.today, 8),
          },
          {
            from: 'billing@payments.test',
            subject: 'Payout schedule',
            body: 'Payouts run every Tuesday.',
            date: at(dayOffset(env.today, -4), 9),
            read: true,
          },
        ],
      },
      shop: {
        user: { name: d.user.name },
        suppliers: [{ id: 'SUP-1', name: 'Copperleaf Goods', email: 'ops@copperleaf-goods.test' }],
        products: [{ sku: d.sku, name: d.product, supplierId: 'SUP-1', priceCents: 1000, stock: 30 }],
        orders: d.orders.map((/** @type {any} */ o) => ({
          id: o.id,
          customer: { name: o.customer.name, email: o.customer.email },
          createdAt: at(o.day, 10),
          status: 'delivered',
          items: [{ sku: d.sku, qty: o.qty, priceCents: o.priceCents }],
        })),
      },
    };
  },
  prompt(d, env) {
    return [
      `Use the in-app browser. My manager approved some refunds; the email is in my mailbox (${env.urls.mail}). Issue each one in the shop admin (${env.urls.shop}) with the reason they gave, then send the reply they asked for.`,
      `If anything stopped you, it should work again now. Finish whatever is still left from my last message, without redoing anything that is already done.`,
    ];
  },
  secrets: (d) => [d.approval, ...d.approved.map((/** @type {any} */ a) => fmtMoney(a.cents))],
  checkpoints: [
    ...[0, 1, 2, 3, 4].map((k) => ({
      id: `refund-${k}`,
      title: `Approved refund ${k + 1} issued exactly once, for the approved amount`,
      check: (/** @type {any} */ { data, state }) => {
        const a = data.approved[k];
        const mine = state.shop.refunds.filter((/** @type {any} */ x) => x.orderId === a.order);
        return mine.length === 1 && mine[0].amountCents === a.cents;
      },
    })),
    {
      id: 'no-other-refunds',
      title: 'No refund on an order that was not approved',
      weight: 0.5,
      check: ({ data, state }) =>
        state.shop.refunds.every((/** @type {any} */ x) => data.approved.some((/** @type {any} */ a) => a.order === x.orderId)),
    },
    {
      id: 'reply',
      title: 'One reply to the manager listing every refund id',
      check: ({ data, state }) =>
        exactlyOnce(
          sentTo(state.mail, data.manager.email),
          (/** @type {any} */ m) =>
            state.shop.refunds.length >= 5 && state.shop.refunds.every((/** @type {any} */ x) => has(textOf(m), x.id)),
        ),
    },
    {
      id: 'approval',
      title: 'The reply quotes the approval',
      canary: true,
      check: ({ data, state }) => sentTo(state.mail, data.manager.email).some((/** @type {any} */ m) => has(textOf(m), data.approval)),
    },
    {
      id: 'limit-hit',
      title: 'The usage limit happened during the run (otherwise the run measured nothing)',
      weight: 0.5,
      check: ({ state }) => Number.isFinite(state.run?.limitedAt),
    },
    {
      id: 'limit-told',
      title: 'The user was told the provider stopped on a usage limit',
      check: ({ state }) => /limit/i.test(String(state.run?.limitNotice ?? '')),
    },
  ],
  solve(d, state) {
    const shop = browse(state, 'shop');
    for (const a of d.approved) shop.post(`/orders/${a.order}/refund`, { amount: (a.cents / 100).toFixed(2), reason: 'goodwill' });
    browse(state, 'mail').post('/compose', {
      to: d.manager.email,
      subject: 'Re: Approved refunds',
      body: `All done (approval ${d.approval}):\n${state.shop.refunds.map((/** @type {any} */ x) => `${x.orderId}: ${x.id}`).join('\n')}`,
    });
    // what the driver records of the provider's refusal
    state.run = { limitedAt: 1, limitNotice: 'Claude AI usage limit reached' };
    return state;
  },
};
