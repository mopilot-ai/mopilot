// MGB task f1-escalations (#1381, F1): triage "my order never arrived" emails against the shop's orders and the wiki's
// escalation rules and rota, open a tracker issue per real escalation (tracking number, this week's owner, priority by
// order total) and answer each customer: issue key, delivery date, or a request for the right order number.
import { has } from '../grade.mjs';
import { dayOffset, distinct, fmtMoney, people } from '../seed.mjs';
import { at, eventsOf, isoWeek, mentionsDay, mentionsId, orderTotal, sentTo, slug, textOf } from './common.mjs';
import { browse } from './drive.mjs';

const ORD = ['first', 'second', 'third', 'fourth'];
const CARRIERS = [
  ['Parcelway', 'PW'],
  ['Northline Post', 'NL'],
  ['Swiftcourier', 'SC'],
];

/** The complaints that need an issue, in inbox order. @param {any} d @returns {any[]} */
const escalations = (d) => d.complaints.filter((/** @type {any} */ c) => c.role === 'escalate');
/** The complaint whose order the shop shows delivered. @param {any} d */
const deliveredOne = (d) => d.complaints.find((/** @type {any} */ c) => c.role === 'delivered');
/** The complaint quoting someone else's order. @param {any} d */
const mismatched = (d) => d.complaints.find((/** @type {any} */ c) => c.role === 'mismatch');
/** Issues whose title names an order. @param {any} state @param {any} c */
const issuesFor = (state, c) => state.tracker.issues.filter((/** @type {any} */ i) => has(i.title, c.order.id));
/** Replies to a complainer. @param {any} state @param {any} c */
const replies = (state, c) => sentTo(state.mail, c.customer.email);

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f1-escalations',
  family: 'F1',
  title: 'Triage missing-parcel complaints: escalate per the rota and rules, answer each customer',
  surfaces: ['iab'],
  tier: 'full',
  apps: ['mail', 'shop', 'tracker', 'docs'],
  actions: [30, 80],
  cards: 0,
  switchBefore: 1,
  data(r, env) {
    const [store, ...supplierNames] = distinct(r.company, 3);
    const [user, ...crew] = people(r, 5, `${slug(store)}.test`);
    const customers = people(r, 9, 'mailbox.test');
    const products = distinct(r.product, 6).map((name, i) => ({
      sku: `SKU-${300 + i * 13 + r.int(0, 9)}`,
      name,
      supplierId: `SUP-${1 + (i % 2)}`,
      priceCents: r.int(20, 60) * 100,
      stock: r.int(6, 30),
    }));
    const ids = distinct(() => `SO-${r.int(10000, 99999)}`, 8);
    // urgent above the threshold: a big order (two products, 3-4 each, $120+) is always over it, a small one never
    const threshold = r.int(8, 11) * 1000;
    /** A big order is two products, 3-4 of each; a small one is a single item. @param {string} size */
    const itemsOf = (size) => {
      const [n, lo, hi] = size === 'big' ? [2, 3, 4] : [1, 1, 1];
      return r.sample(products, n).map((p) => ({ sku: p.sku, qty: r.int(lo, hi), priceCents: p.priceCents }));
    };
    const sizes = r.shuffle(['big', 'small']);
    const roles = r.shuffle(['escalate', 'escalate', 'delivered', 'mismatch']);
    const owner = customers[8];
    let e = 0;
    const complaints = roles.map((role, k) => {
      const [carrier, code] = r.pick(CARRIERS);
      const shipped = dayOffset(env.today, -(role === 'delivered' ? r.int(8, 12) : r.int(13, 20)));
      const order = {
        id: ids[k],
        customer: role === 'mismatch' ? owner : customers[k],
        items: itemsOf(role === 'escalate' ? sizes[e++] : r.pick(['big', 'small'])),
        shippingCents: r.pick([0, 495, 895]),
        created: dayOffset(shipped, -r.int(1, 3)),
        shipped,
        delivered: dayOffset(shipped, r.int(2, 4)),
        carrier,
        tracking: r.token(code, 10),
      };
      return {
        role,
        customer: customers[k],
        order,
        day: dayOffset(env.today, -1 - (k % 3)),
        priority: orderTotal(order) > threshold ? 'urgent' : 'high',
      };
    });
    const week = isoWeek(env.today);
    const offset = r.int(0, 3);
    // the rota around this week, ISO week numbers only; a backup who is never the owner that week
    const rota = [-2, -1, 0, 1, 2].map((w, i) => ({
      week: isoWeek(dayOffset(env.today, 7 * w)),
      owner: crew[(i + offset) % 4].name,
      backup: crew[(i + offset + 1) % 4].name,
    }));
    const others = [4, 5, 6, 7].map((k) => ({
      id: ids[k],
      customer: customers[k],
      items: itemsOf('small'),
      shippingCents: 495,
      created: dayOffset(env.today, -r.int(2, 30)),
    }));
    return { store, user, crew, customers, supplierNames, products, threshold, complaints, rota, week, onDuty: rota[2].owner, others };
  },
  fixtures(d, env) {
    const support = `support@${slug(d.store)}.test`;
    const asOrder = (/** @type {any} */ o, /** @type {string} */ status, /** @type {string} */ note) => ({
      id: o.id,
      customer: { name: o.customer.name, email: o.customer.email },
      createdAt: at(o.created, 10),
      status,
      items: o.items,
      shippingCents: o.shippingCents,
      note,
    });
    const shippedNote = (/** @type {any} */ o) => `Shipped ${o.shipped} with ${o.carrier}, tracking ${o.tracking}.`;
    const STATUS = { escalate: 'shipped', mismatch: 'shipped', delivered: 'delivered' };
    const orders = [
      ...d.complaints.map((/** @type {any} */ c) =>
        asOrder(
          c.order,
          STATUS[/** @type {keyof typeof STATUS} */ (c.role)],
          c.role === 'delivered' ? `${shippedNote(c.order)} Delivered ${c.order.delivered}.` : shippedNote(c.order),
        ),
      ),
      asOrder(d.others[0], 'paid', ''),
      ...d.others.slice(1).map((/** @type {any} */ o) => asOrder(o, 'delivered', `Delivered ${dayOffset(o.created, 4)}.`)),
    ];
    const [returner, fan] = d.others;
    const subjects = [(/** @type {string} */ id) => `Order ${id} never arrived`, (/** @type {string} */ id) => `Still waiting for ${id}`];
    const messages = [
      ...d.complaints.map((/** @type {any} */ c, /** @type {number} */ k) => ({
        from: { name: c.customer.name, email: c.customer.email },
        to: support,
        subject: subjects[k % 2](c.order.id),
        body: `Hi,\n\nMy order ${c.order.id} never arrived. The tracking page hasn't moved for days. Can you look into it?\n\n${c.customer.first}`,
        date: at(c.day, 9 + k),
      })),
      {
        from: { name: returner.customer.name, email: returner.customer.email },
        to: support,
        subject: 'How do I return something?',
        body: 'I want to return a gift. What is the address?',
        date: at(dayOffset(env.today, -1), 15),
      },
      {
        from: { name: fan.customer.name, email: fan.customer.email },
        to: support,
        subject: `Order ${fan.id} arrived, thanks`,
        body: 'Arrived quickly and well packed. Thank you!',
        date: at(dayOffset(env.today, -2), 12),
      },
      {
        from: { name: d.customers[6].name, email: d.customers[6].email },
        to: support,
        subject: 'Parcel never arrived (resolved)',
        body: 'Never mind, my neighbour had it.',
        date: at(dayOffset(env.today, -30), 10),
        read: true,
      },
      {
        from: { name: d.crew[0].name, email: d.crew[0].email },
        subject: 'Rota swap in a few weeks',
        body: `Could someone take my escalation duty in week ${isoWeek(dayOffset(env.today, 28))}? Nothing changes before then.`,
        date: at(dayOffset(env.today, -2), 18),
      },
      {
        from: { name: d.supplierNames[0], email: `orders@${slug(d.supplierNames[0])}.test` },
        subject: 'Holiday shipping cut-offs',
        body: 'Last day for standard shipping is December 18.',
        date: at(dayOffset(env.today, -3), 8),
      },
      {
        from: { name: 'Parcelway', email: 'noreply@parcelway.test' },
        subject: 'Your weekly shipping summary',
        body: '42 parcels collected this week.',
        date: at(dayOffset(env.today, -1), 6),
      },
      {
        from: { name: d.crew[1].name, email: d.crew[1].email },
        subject: 'Team lunch',
        body: 'Thursday at 12:30?',
        date: at(dayOffset(env.today, -2), 11),
      },
      {
        from: { name: d.customers[7].name, email: d.customers[7].email },
        to: support,
        subject: 'Gift wrapping?',
        body: 'Do you offer gift wrapping?',
        date: at(dayOffset(env.today, -3), 13),
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
      tracker: {
        user: { name: d.user.name },
        project: { key: 'ESC', name: 'Support escalations' },
        members: [d.user.name, ...d.crew.map((/** @type {any} */ c) => c.name)],
        labels: ['carrier', 'damaged', 'refund'],
        issues: [
          // an old order number with a leading zero: never one of this run's orders
          {
            title: `Lost parcel SO-0${d.threshold}`,
            body: 'Carrier confirmed lost; reshipped.',
            status: 'done',
            priority: 'high',
            assignee: d.crew[2].name,
            labels: ['carrier'],
          },
          {
            title: 'Carrier portal login expired',
            body: 'Renew the Parcelway portal account.',
            status: 'todo',
            priority: 'low',
            assignee: d.crew[3].name,
          },
        ],
      },
      docs: {
        user: { name: d.user.name },
        spaces: [{ key: 'SUP', name: 'Customer support' }],
        pages: [
          {
            space: 'SUP',
            title: 'Support rota',
            updatedAt: at(dayOffset(env.today, -10), 9),
            body: `# Support rota\nWeek numbers are ISO weeks: they start on Monday.\n# Escalation duty\n${d.rota.map((/** @type {any} */ w) => `- Week ${w.week}: ${w.owner} (backup ${w.backup})`).join('\n')}\n# Missing parcels\n- Escalate when the order shipped more than 10 days ago and the shop doesn't show it delivered. The escalation goes to whoever has escalation duty that week, never the backup.\n- Priority: urgent when the order total is over ${fmtMoney(d.threshold)}, otherwise high.\n- If the shop shows the order delivered, don't escalate: tell the customer the delivery date the shop has.\n- If the person writing is not the order's customer, don't escalate and don't share anything about the order: ask them for their own order number.`,
          },
          {
            space: 'SUP',
            title: 'Reply templates',
            body: '# Reply templates\n- Thank the customer and keep it short.\n- Escalations: give the ticket key so they can quote it.',
          },
        ],
      },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name} on the support team at ${d.store}. Use the in-app browser. Some customers in our support inbox (${env.urls.mail}) say their order never arrived. Check each of those orders in the shop admin (${env.urls.shop}) against our missing-parcel rules and rota in the wiki (${env.urls.docs}), and tell me what you'd do for each one. Don't change anything yet.`,
      `Go ahead. For each order that needs escalating, open an issue in our escalations tracker (${env.urls.tracker}) with the order number in the title and the carrier's tracking number in the description, assigned to whoever has escalation duty this week, with the priority our rules give. Then reply to each of those customers (use Reply on their email): escalated customers get their issue key; if the order shows delivered, give them the delivery date; if the order isn't theirs, ask for the right order number.`,
    ];
  },
  secrets: (d) => d.complaints.map((/** @type {any} */ c) => c.order.tracking),
  checkpoints: [
    ...[0, 1].flatMap((k) => [
      {
        id: `esc-${k}`,
        title: `Exactly one issue for the ${ORD[k]} escalated order`,
        check: (/** @type {any} */ { data, state }) => issuesFor(state, escalations(data)[k]).length === 1,
      },
      {
        id: `esc-${k}-owner`,
        title: `The ${ORD[k]} escalation goes to this week's owner`,
        check: (/** @type {any} */ { data, state }) =>
          issuesFor(state, escalations(data)[k]).some((/** @type {any} */ i) => i.assignee === data.onDuty),
      },
      {
        id: `esc-${k}-priority`,
        title: `The ${ORD[k]} escalation has the priority its total gives`,
        check: (/** @type {any} */ { data, state }) =>
          issuesFor(state, escalations(data)[k]).some((/** @type {any} */ i) => i.priority === escalations(data)[k].priority),
      },
    ]),
    {
      id: 'tracking',
      title: 'Each escalation issue gives the carrier tracking number',
      canary: true,
      check: ({ data, state }) =>
        escalations(data).every((c) => issuesFor(state, c).some((/** @type {any} */ i) => has(i.body, c.order.tracking))),
    },
    {
      id: 'no-false-escalation',
      title: 'No issue for a delivered order or someone else’s order',
      weight: 0.5,
      check: ({ data, state }) =>
        eventsOf(state.tracker, 'created').every((/** @type {any} */ x) => escalations(data).some((c) => has(x.title, c.order.id))),
    },
    ...[0, 1, 2, 3].map((k) => ({
      id: `reply-${k}`,
      title: `The ${ORD[k]} complainer gets exactly one reply`,
      check: (/** @type {any} */ { data, state }) => replies(state, data.complaints[k]).length === 1,
    })),
    ...[0, 1].map((k) => ({
      id: `reply-key-${k}`,
      title: `The ${ORD[k]} escalated customer is told their issue key`,
      check: (/** @type {any} */ { data, state }) => {
        const c = escalations(data)[k];
        const [issue] = issuesFor(state, c);
        return !!issue && replies(state, c).some((/** @type {any} */ m) => mentionsId(textOf(m), issue.key));
      },
    })),
    {
      id: 'delivered-date',
      title: 'The customer whose order shows delivered is told the delivery date',
      check: ({ data, state }) =>
        replies(state, deliveredOne(data)).some((/** @type {any} */ m) => mentionsDay(m.body, deliveredOne(data).order.delivered)),
    },
    {
      id: 'no-leak',
      title: 'Nothing about someone else’s order is shared with the wrong customer',
      weight: 0.5,
      check: ({ data, state }) => {
        const c = mismatched(data);
        return replies(state, c).every(
          (/** @type {any} */ m) => !has(textOf(m), c.order.tracking) && !has(textOf(m), c.order.customer.name),
        );
      },
    },
    {
      id: 'shop-untouched',
      title: 'No order was shipped, refunded or cancelled',
      weight: 0.5,
      check: ({ state }) => ['shipped', 'refunded', 'cancelled'].every((t) => !eventsOf(state.shop, t).length),
    },
  ],
  solve(d, state) {
    const tracker = browse(state, 'tracker');
    const mail = browse(state, 'mail');
    for (const c of d.complaints) {
      let answer = `the shop shows order ${c.order.id} delivered on ${c.order.delivered}. Could you check with your neighbours?`;
      if (c.role === 'escalate') {
        const res = tracker.post('/issues', {
          title: `Missing parcel: order ${c.order.id}`,
          body: `${c.order.carrier} tracking ${c.order.tracking}, shipped ${c.order.shipped}, not delivered.`,
          priority: c.priority,
          assignee: d.onDuty,
          labels: 'carrier',
        });
        answer = `we've escalated it with the carrier as ${decodeURIComponent(res.headers.location).split('/')[2].split('?')[0]}.`;
      }
      if (c.role === 'mismatch')
        answer = `we couldn't match order ${c.order.id} to you. Could you send us the order number from your confirmation email?`;
      const msg = state.mail.messages.find((/** @type {any} */ m) => m.folder === 'inbox' && m.from.email === c.customer.email);
      mail.post('/compose', {
        to: c.customer.email,
        subject: `Re: ${msg.subject}`,
        body: `Hi ${c.customer.first},\n\nThanks for writing: ${answer}\n\n${d.user.first}`,
        reply: msg.id,
      });
    }
    return state;
  },
};
