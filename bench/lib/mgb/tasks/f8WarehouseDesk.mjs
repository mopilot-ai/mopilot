// MGB task f8-warehouse-desk (#1381, F8): a support chat asks the user's "Warehouse desk" chat on the other harness to
// ship the orders customers are waiting for (the desk alone knows the carrier's tracking format), then answers each
// customer with the tracking number the desk sends back.
import { exactlyOnce, has } from '../grade.mjs';
import { dayOffset, distinct, people } from '../seed.mjs';
import { deliveredRequests, repliesTo } from '../chats.mjs';
import { at, sentTo, textOf } from './common.mjs';
import { browse } from './drive.mjs';

const PEER = 'Warehouse desk';
/** The tracking number the warehouse gives an order: its carrier prefix and the order's digits. @param {string} prefix @param {string} order */
export const trackingFor = (prefix, order) => `${prefix}${order.replace(/\D/g, '')}`;

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f8-warehouse-desk',
  family: 'F8',
  title: "Get orders shipped by the user's warehouse chat on the other harness, then tell each customer",
  surfaces: ['iab'],
  tier: 'full',
  apps: ['mail', 'shop'],
  actions: [25, 70],
  cards: 0,
  peers: [
    {
      name: PEER,
      prompt: (d, env) =>
        `You are my warehouse desk. When another of my chats asks you to ship orders, mark each one shipped in the shop admin (${env.urls.shop}) with the tracking number ${d.prefix} followed by the order number's digits (order SO-1234 ships as ${d.prefix}1234), using the in-app browser. Ship only orders that are paid. Then reply to the chat that asked with each order and its tracking number. For now, just say you are ready.`,
    },
  ],
  data(r, env) {
    const [user, ...customers] = people(r, 7, 'northwind.test');
    const ids = distinct(() => `SO-${r.int(1000, 9999)}`, 7);
    const sku = r.token('SKU', 4);
    const orders = ids.map((id, i) => ({
      id,
      customer: customers[i % customers.length],
      status: i < 4 ? 'paid' : i === 4 ? 'pending' : 'shipped',
      day: dayOffset(env.today, -1 - i),
    }));
    // four customers wait on paid orders; a fifth asks about an order that is still pending payment
    return {
      user,
      sku,
      product: r.product(),
      orders,
      waiting: orders.slice(0, 4),
      pending: orders[4],
      prefix: r.pick(['1ZMG', 'JDMG', 'TBMG']) + r.int(10, 99),
    };
  },
  fixtures(d, env) {
    return {
      mail: {
        user: { name: d.user.name, email: d.user.email },
        messages: [
          ...[...d.waiting, d.pending].map((/** @type {any} */ o, /** @type {number} */ i) => ({
            from: { name: o.customer.name, email: o.customer.email },
            subject: `When will ${o.id} ship?`,
            body: `Hi, I ordered on ${o.day} (order ${o.id}) and haven't had a shipping note yet. Could you check?\n${o.customer.first}`,
            date: at(dayOffset(env.today, 0), 8 + i),
          })),
          {
            from: 'news@carrier.test',
            subject: 'Holiday cut-off dates',
            body: 'Order by the 18th for delivery before the holidays.',
            date: at(dayOffset(env.today, -2), 7),
            read: true,
          },
        ],
      },
      shop: {
        user: { name: d.user.name },
        suppliers: [{ id: 'SUP-1', name: 'Northwind Supply', email: 'orders@northwind-supply.test' }],
        products: [{ sku: d.sku, name: d.product, supplierId: 'SUP-1', priceCents: 4900, stock: 40 }],
        orders: d.orders.map((/** @type {any} */ o) => ({
          id: o.id,
          customer: { name: o.customer.name, email: o.customer.email },
          createdAt: at(o.day, 9),
          status: o.status,
          items: [{ sku: d.sku, qty: 1 }],
        })),
      },
      chats: {},
    };
  },
  prompt(d, env) {
    return [
      `Use the in-app browser. Some customers in our support inbox (${env.urls.mail}) are asking when their order ships. Look up each of those orders in the shop admin (${env.urls.shop}) and tell me which can ship now. Don't change anything yet.`,
      `Ask my "${PEER}" chat to ship the orders that can ship (don't ship them yourself), and once it tells you the tracking numbers, reply to each customer who asked: their tracking number if it shipped, or why not if it can't ship yet.`,
    ];
  },
  secrets: (d) => [d.prefix, ...d.waiting.map((/** @type {any} */ o) => trackingFor(d.prefix, o.id))],
  checkpoints: [
    ...[0, 1, 2, 3].map((k) => ({
      id: `shipped-${k}`,
      title: `Waiting order ${k + 1} shipped once with the warehouse's tracking number`,
      check: (/** @type {any} */ { data, state }) => {
        const o = data.waiting[k];
        const ships = state.shop.events.filter((/** @type {any} */ e) => e.type === 'shipped' && e.orderId === o.id);
        return ships.length === 1 && ships[0].tracking === trackingFor(data.prefix, o.id);
      },
    })),
    {
      id: 'tracking-format',
      title: "The tracking numbers use the warehouse's carrier prefix",
      canary: true,
      check: ({ data, state }) =>
        state.shop.events.some((/** @type {any} */ e) => e.type === 'shipped' && String(e.tracking).startsWith(data.prefix)),
    },
    {
      id: 'pending-kept',
      title: 'The order still pending payment was not shipped',
      weight: 0.5,
      check: ({ data, state }) => !state.shop.events.some((/** @type {any} */ e) => e.type === 'shipped' && e.orderId === data.pending.id),
    },
    {
      id: 'asked-desk',
      title: 'A request reached the warehouse chat naming every waiting order',
      check: ({ data, state }) =>
        deliveredRequests(
          state.chats,
          data.waiting.map((/** @type {any} */ o) => o.id),
        ).length > 0,
    },
    {
      id: 'desk-replied',
      title: 'The warehouse chat replied',
      check: ({ state }) => deliveredRequests(state.chats).some((/** @type {any} */ m) => repliesTo(state.chats, m).length > 0),
    },
    ...[0, 1, 2, 3].map((k) => ({
      id: `told-${k}`,
      title: `Customer ${k + 1} got one reply with their tracking number`,
      check: (/** @type {any} */ { data, state }) => {
        const o = data.waiting[k];
        return exactlyOnce(sentTo(state.mail, o.customer.email), (/** @type {any} */ m) => has(textOf(m), trackingFor(data.prefix, o.id)));
      },
    })),
    {
      id: 'pending-told',
      title: 'The customer with the unpaid order was told why it has not shipped',
      check: ({ data, state }) =>
        sentTo(state.mail, data.pending.customer.email).some((/** @type {any} */ m) => /pay|pending/i.test(textOf(m))),
    },
  ],
  solve(d, state) {
    const shop = browse(state, 'shop');
    for (const o of d.waiting) shop.post(`/orders/${o.id}/ship`, { tracking: trackingFor(d.prefix, o.id) });
    state.chats.messages.push(
      {
        id: 'm1',
        from: 'chat-a',
        to: 'chat-b',
        body: `Please ship ${d.waiting.map((/** @type {any} */ o) => o.id).join(', ')}`,
        delivery: 'delivered',
        reply: 'received',
        replyTo: null,
        at: 1,
      },
      {
        id: 'm2',
        from: 'chat-b',
        to: 'chat-a',
        body: d.waiting.map((/** @type {any} */ o) => `${o.id}: ${trackingFor(d.prefix, o.id)}`).join('\n'),
        delivery: 'delivered',
        reply: 'notRequested',
        replyTo: 'm1',
        at: 2,
      },
    );
    const mail = browse(state, 'mail');
    for (const o of d.waiting)
      mail.post('/compose', {
        to: o.customer.email,
        subject: `Re: When will ${o.id} ship?`,
        body: `It shipped today, tracking ${trackingFor(d.prefix, o.id)}.`,
      });
    mail.post('/compose', {
      to: d.pending.customer.email,
      subject: `Re: When will ${d.pending.id} ship?`,
      body: 'Your payment is still pending; it ships as soon as it clears.',
    });
    return state;
  },
};
