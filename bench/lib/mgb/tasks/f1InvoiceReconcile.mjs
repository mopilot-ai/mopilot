// MGB task f1-invoice-reconcile (#1381, F1): reconcile the supplier's invoices of the last 7 days in webmail against the shop
// admin's orders, file each mismatch in the tracker with a screenshot, and send the supplier one dispute summary.
// #3571: the task said "this week's invoices" while the invoices are 1 to 6 days old, so on most days of the week some of them lie in the
// calendar week before and an agent that read "this week" as the calendar week skipped them (G12 invoice r1 never compared the price
// mismatch, dated 10-30 on 11-05). It now says "the last 7 days", which every invoice is in. Results of this task from before that change
// are not comparable with results after it.
import { exactlyOnce, has } from '../grade.mjs';
import { dayOffset, distinct, fmtMoney, people } from '../seed.mjs';
import { at, eventsOf, invoiceText, isImage, issuesMentioning, mentionsAmount, orderTotal, sentTo, textOf } from './common.mjs';
import { browse } from './drive.mjs';

const ORDERS = 7;

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f1-invoice-reconcile',
  family: 'F1',
  title: 'Reconcile supplier invoices against orders and dispute the mismatches',
  surfaces: ['iab'],
  tier: 'smoke',
  apps: ['mail', 'shop', 'tracker'],
  actions: [35, 80],
  cards: 0,
  switchBefore: 1,
  data(r, env) {
    const [buyer, supplierName, ...others] = distinct(r.company, 4);
    const slug = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z]+/g, '');
    const [user, contact, colleague] = people(r, 3, `${slug(buyer)}.test`);
    const supplier = {
      id: 'SUP-1',
      name: supplierName,
      domain: `${slug(supplierName)}.test`,
      contact: { ...contact, email: `${contact.first.toLowerCase()}@${slug(supplierName)}.test` },
    };
    const products = distinct(r.product, 9).map((name, i) => ({
      sku: `SKU-${100 + i * 7 + r.int(0, 6)}`,
      name,
      supplierId: i < 6 ? 'SUP-1' : `SUP-${2 + (i % 2)}`,
      priceCents: r.int(15, 120) * 100 + r.pick([0, 50, 95]),
      stock: r.int(3, 40),
    }));
    const mine = products.filter((p) => p.supplierId === 'SUP-1');
    const ids = distinct(() => `PO-${r.int(1000, 9999)}`, ORDERS + 4);
    const orders = ids.map((id, i) => {
      const pool = i < ORDERS ? mine : products.filter((p) => p.supplierId !== 'SUP-1');
      const items = r
        .sample(pool, r.int(1, Math.min(3, pool.length)))
        .map((p) => ({ sku: p.sku, name: p.name, qty: r.int(1, 4), priceCents: p.priceCents }));
      const supplierId = products.find((p) => p.sku === items[0].sku)?.supplierId;
      return {
        id,
        supplierId,
        items,
        shippingCents: r.pick([0, 795, 1250]),
        day: dayOffset(env.today, -1 - (i % 6)),
        customer: r.person(),
      };
    });
    const invNumbers = distinct(() => `INV-${r.int(20000, 99999)}`, ORDERS);
    const [overIdx, qtyIdx] = r.sample([...Array(ORDERS).keys()], 2);
    const invoices = orders.slice(0, ORDERS).map((o, i) => {
      const lines = o.items.map((it) => ({ name: it.name, qty: it.qty, priceCents: it.priceCents }));
      if (i === overIdx) lines[0] = { ...lines[0], priceCents: lines[0].priceCents + r.int(3, 40) * 25 };
      if (i === qtyIdx) lines[lines.length - 1] = { ...lines[lines.length - 1], qty: lines[lines.length - 1].qty + 1 };
      const totalCents = lines.reduce((t, l) => t + l.qty * l.priceCents, 0) + o.shippingCents;
      return {
        number: invNumbers[i],
        order: o.id,
        lines,
        shippingCents: o.shippingCents,
        totalCents,
        expectedCents: orderTotal(o),
        day: o.day,
      };
    });
    const disputed = [overIdx, qtyIdx].map((i) => invoices[i]);
    return { buyer, user, colleague, supplier, products, orders, invoices, disputed, others, disputeCode: r.canary() };
  },
  fixtures(d, env) {
    const billing = `billing@${d.supplier.domain}`;
    const messages = [
      ...d.invoices.map((/** @type {any} */ inv) => ({
        from: { name: `${d.supplier.name} Billing`, email: billing },
        subject: `Invoice ${inv.number} for order ${inv.order}`,
        body: `Hello,\n\nPlease find the invoice below.\n\n${invoiceText(inv)}\n\nPayment terms: net 30.\n${d.supplier.name} Billing`,
        date: at(inv.day, 9),
      })),
      {
        from: { name: d.supplier.contact.name, email: d.supplier.contact.email },
        subject: 'Billing questions and disputes',
        body: `Hi ${d.user.first},\n\nI'm your account manager now. If anything on an invoice looks wrong, email me one summary and quote our billing-dispute code ${d.disputeCode} so it reaches the right queue.\n\nThanks,\n${d.supplier.contact.name}`,
        date: at(dayOffset(env.today, -9), 11),
        read: true,
      },
      {
        from: { name: `${d.supplier.name} News`, email: `news@${d.supplier.domain}` },
        subject: 'New autumn catalog is here',
        body: 'Browse 40 new products. Unsubscribe any time.',
        date: at(dayOffset(env.today, -2), 7),
      },
      {
        from: { name: d.colleague.name, email: d.colleague.email },
        subject: 'Lunch on Thursday?',
        body: 'The usual place at noon?',
        date: at(dayOffset(env.today, -1), 12),
      },
      {
        from: { name: `${d.others[0]} Billing`, email: `billing@${d.others[0].toLowerCase().replace(/[^a-z]+/g, '')}.test` },
        subject: `Statement for ${d.orders[ORDERS].id}`,
        body: `Statement total ${fmtMoney(orderTotal(d.orders[ORDERS]))}. Nothing is due.`,
        date: at(dayOffset(env.today, -3), 10),
      },
    ];
    return {
      mail: { user: { name: d.user.name, email: d.user.email }, messages },
      shop: {
        user: { name: d.user.name },
        suppliers: [
          { id: 'SUP-1', name: d.supplier.name, email: billing },
          { id: 'SUP-2', name: d.others[0], email: `orders@${d.others[0].toLowerCase().replace(/[^a-z]+/g, '')}.test` },
          { id: 'SUP-3', name: d.others[1], email: `orders@${d.others[1].toLowerCase().replace(/[^a-z]+/g, '')}.test` },
        ],
        products: d.products,
        orders: d.orders.map((/** @type {any} */ o) => ({
          id: o.id,
          supplierId: o.supplierId,
          customer: { name: o.customer.name, email: `${o.customer.first.toLowerCase()}@example.test` },
          createdAt: at(o.day, 8),
          status: 'paid',
          items: o.items.map((/** @type {any} */ i) => ({ sku: i.sku, qty: i.qty, priceCents: i.priceCents })),
          shippingCents: o.shippingCents,
        })),
      },
      tracker: {
        user: { name: d.user.name },
        project: { key: 'AP', name: 'Accounts payable' },
        members: [d.user.name, d.colleague.name],
        labels: ['invoice', 'supplier', 'urgent'],
        issues: [
          { title: 'Close September books', body: 'Month-end checklist.', status: 'done', priority: 'medium', assignee: d.colleague.name },
          { title: 'Update vendor bank details form', body: 'Old form still links to the 2024 template.', status: 'todo', priority: 'low' },
        ],
      },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name} in accounts payable at ${d.buyer}. ${d.supplier.name} sent me invoices over the last 7 days (my mailbox: ${env.urls.mail}). Compare every one of them with the matching order in our shop admin (${env.urls.shop}): items, quantities, prices, shipping and the total. Use the in-app browser. For now just tell me which invoices you checked; don't change anything yet.`,
      `For each invoice that doesn't match its order, open an issue in the AP tracker (${env.urls.tracker}) titled "Invoice mismatch: <invoice number>", labeled "invoice". In its description give the order number, the invoiced total and the total it should be, and attach a screenshot of the invoice email. Then send ${d.supplier.contact.name} one email listing the disputed invoices the way they asked for disputes, and add the label "disputed" to each disputed invoice email. Leave the orders themselves alone.`,
    ];
  },
  secrets: (d) => [
    ...d.disputed.map((/** @type {any} */ i) => i.number),
    d.disputeCode,
    ...d.disputed.map((/** @type {any} */ i) => fmtMoney(i.totalCents)),
  ],
  checkpoints: [
    ...[0, 1].flatMap((k) => {
      const issue = (/** @type {any} */ d, /** @type {any} */ s) => issuesMentioning(s.tracker, [d.disputed[k].number]);
      const which = k ? 'second' : 'first';
      return [
        {
          id: `issue-${k}`,
          title: `One issue for the ${which} disputed invoice`,
          check: (/** @type {any} */ { data, state }) => issue(data, state).length === 1,
        },
        {
          id: `issue-${k}-order`,
          title: `The ${which} issue names its order`,
          check: (/** @type {any} */ { data, state }) => issue(data, state).some((i) => has(i.body, data.disputed[k].order)),
        },
        {
          id: `issue-${k}-amounts`,
          title: `The ${which} issue gives the invoiced and the expected totals`,
          check: (/** @type {any} */ { data, state }) =>
            issue(data, state).some(
              (i) => mentionsAmount(i.body, data.disputed[k].totalCents) && mentionsAmount(i.body, data.disputed[k].expectedCents),
            ),
        },
        {
          id: `issue-${k}-shot`,
          title: `The ${which} issue has a screenshot attached`,
          check: (/** @type {any} */ { data, state }) => issue(data, state).some((i) => i.attachments.some(isImage)),
        },
        {
          id: `issue-${k}-label`,
          title: `The ${which} issue is labeled invoice`,
          weight: 0.5,
          check: (/** @type {any} */ { data, state }) => issue(data, state).some((i) => i.labels.includes('invoice')),
        },
      ];
    }),
    {
      id: 'no-false-issue',
      title: 'No issue for an invoice that matches',
      weight: 0.5,
      check: ({ data, state }) =>
        data.invoices
          .filter((/** @type {any} */ i) => !data.disputed.includes(i))
          .every((/** @type {any} */ i) => !issuesMentioning(state.tracker, [i.number]).length),
    },
    {
      id: 'summary',
      title: 'One summary email to the account manager listing both invoices',
      check: ({ data, state }) =>
        exactlyOnce(sentTo(state.mail, data.supplier.contact.email), (m) =>
          data.disputed.every((/** @type {any} */ i) => has(textOf(m), i.number)),
        ),
    },
    {
      id: 'dispute-code',
      title: 'The summary quotes the billing-dispute code',
      canary: true,
      check: ({ data, state }) =>
        sentTo(state.mail, data.supplier.contact.email).some((/** @type {any} */ m) => has(textOf(m), data.disputeCode)),
    },
    {
      id: 'labels',
      title: 'Exactly the disputed invoice emails are labeled disputed',
      check: ({ data, state }) => {
        const labeled = state.mail.messages
          .filter((/** @type {any} */ m) => m.labels.includes('disputed'))
          .map((/** @type {any} */ m) => m.subject);
        return labeled.length === 2 && data.disputed.every((/** @type {any} */ i) => labeled.some((s) => has(s, i.number)));
      },
    },
    {
      id: 'shop-untouched',
      title: 'No order was shipped, refunded or cancelled',
      weight: 0.5,
      check: ({ state }) =>
        ['shipped', 'refunded', 'cancelled', 'productUpdated', 'productDeleted'].every((t) => !eventsOf(state.shop, t).length),
    },
  ],
  solve(d, state) {
    const tracker = browse(state, 'tracker');
    const mail = browse(state, 'mail');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const inv of d.disputed) {
      tracker.post('/issues', {
        fields: {
          title: `Invoice mismatch: ${inv.number}`,
          body: `Order ${inv.order}: invoiced ${fmtMoney(inv.totalCents)}, should be ${fmtMoney(inv.expectedCents)}.`,
          priority: 'medium',
          labels: 'invoice',
        },
        files: [{ field: 'attach', name: `${inv.number}.png`, type: 'image/png', content: png }],
      });
      const msg = state.mail.messages.find((/** @type {any} */ m) => m.subject.includes(inv.number));
      mail.post(`/m/${msg.id}/label`, { label: 'disputed' });
    }
    mail.post('/compose', {
      to: d.supplier.contact.email,
      subject: `Disputed invoices ${d.disputed.map((/** @type {any} */ i) => i.number).join(', ')}`,
      body: `Hi ${d.supplier.contact.first},\n\nBilling-dispute code ${d.disputeCode}.\n${d.disputed.map((/** @type {any} */ i) => `${i.number} (order ${i.order}): invoiced ${fmtMoney(i.totalCents)}, expected ${fmtMoney(i.expectedCents)}`).join('\n')}\n`,
    });
    return state;
  },
};
