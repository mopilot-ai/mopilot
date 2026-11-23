// MGB task f1-restock-orders (#1381, F1): find the shop's low-stock products, size each reorder from the wiki's supplier
// terms (minimum order, target stock), and email each supplier one purchase order with its PO number, copying purchasing.
import { same } from '../grade.mjs';
import { dayOffset, distinct, people } from '../seed.mjs';
import { at, lineWithNumber, mentionsId, sent, sentTo, slug, textOf } from './common.mjs';
import { browse } from './drive.mjs';

const ORD = ['first', 'second', 'third'];
/** Per supplier: products below 5 in stock, products at exactly 5 (not low), products well stocked. The fourth has none low. */
const LOW = [2, 2, 2, 0];
const NEAR = [1, 0, 0, 2];
const STOCKED = [2, 2, 2, 2];

/** The purchase-order number for a supplier on a day: its prefix and the date as YYYYMMDD. @param {any} s @param {string} day */
const poNumber = (s, day) => `${s.prefix}-${day.replaceAll('-', '')}`;
/** The mail sent to a supplier. @param {any} state @param {any} s */
const toSupplier = (state, s) => sentTo(state.mail, s.email);

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f1-restock-orders',
  family: 'F1',
  title: 'Size restock orders from supplier terms and email each supplier one purchase order',
  surfaces: ['iab'],
  tier: 'full',
  apps: ['shop', 'docs', 'mail'],
  actions: [25, 70],
  cards: 0,
  switchBefore: 1,
  data(r) {
    const [store, ...names] = distinct(r.company, 5);
    const domain = `${slug(store)}.test`;
    const [user, colleague] = people(r, 2, domain);
    const suppliers = names.map((name, i) => {
      const target = r.int(15, 30);
      // the first supplier's minimum is above what any of its low products needs; the others' minimums are small
      return {
        id: `SUP-${i + 1}`,
        name,
        email: `orders@${slug(name)}.test`,
        target,
        moq: i === 0 ? target - 1 : r.int(4, 10),
        prefix: r.token('PO', 4),
        oldPrefix: r.token('PO', 4),
      };
    });
    const total = [LOW, NEAR, STOCKED].flat().reduce((a, b) => a + b, 0);
    const skus = distinct(() => `SKU-${r.int(100, 999)}`, total);
    const productNames = distinct(r.product, total);
    /** @type {any[]} */
    const products = [];
    suppliers.forEach((s, i) => {
      const add = (/** @type {number} */ n, /** @type {() => number} */ stock) => {
        for (let k = 0; k < n; k++)
          products.push({
            sku: skus[products.length],
            name: productNames[products.length],
            supplierId: s.id,
            priceCents: r.int(8, 70) * 100 + r.pick([0, 50, 95]),
            stock: stock(),
          });
      };
      add(LOW[i], () => (i === 0 ? r.int(2, 4) : r.int(0, 4)));
      add(NEAR[i], () => 5);
      add(STOCKED[i], () => r.int(6, 40));
    });
    const lines = products
      .filter((p) => p.stock < 5)
      .map((p) => {
        const i = suppliers.findIndex((s) => s.id === p.supplierId);
        return { supplier: i, sku: p.sku, qty: Math.max(suppliers[i].moq, suppliers[i].target - p.stock) };
      });
    return { store, domain, user, colleague, suppliers, products: r.shuffle(products), lines, purchasing: `purchasing@${domain}` };
  },
  fixtures(d, env) {
    const [first, second, , idle] = d.suppliers;
    const section = (/** @type {any} */ s) =>
      `## ${s.name}\n- Minimum order quantity: ${s.moq} units per SKU\n- Target stock level: ${s.target} units\n- PO prefix: ${s.prefix}`;
    return {
      shop: {
        user: { name: d.user.name },
        suppliers: d.suppliers.map((/** @type {any} */ s) => ({ id: s.id, name: s.name, email: s.email })),
        products: d.products,
        orders: d.products.slice(0, 3).map((/** @type {any} */ p, /** @type {number} */ i) => ({
          id: `SO-${7001 + i}`,
          customer: { name: d.colleague.name, email: d.colleague.email },
          createdAt: at(dayOffset(env.today, -1 - i), 11),
          status: 'paid',
          items: [{ sku: p.sku, qty: 1 }],
        })),
      },
      docs: {
        user: { name: d.user.name },
        spaces: [
          { key: 'PUR', name: 'Purchasing' },
          { key: 'ARC', name: 'Archive' },
        ],
        pages: [
          {
            space: 'PUR',
            title: 'Supplier terms',
            author: d.colleague.name,
            updatedAt: at(dayOffset(env.today, -20), 10),
            body: `# Supplier terms\nWhen the shop admin flags a product as low on stock, reorder enough to bring it back up to the supplier's target stock level, but never less than the supplier's minimum order quantity.\nSend one purchase order per supplier per day, listing every SKU and its quantity. The PO number is the supplier's PO prefix, a dash and the order date written YYYYMMDD.\nCopy ${d.purchasing} on every purchase order. (Our old orders@${d.domain} inbox is no longer read.)\n${d.suppliers.map(section).join('\n')}`,
          },
          {
            space: 'ARC',
            title: 'Supplier terms 2025',
            updatedAt: '2025-03-01T10:00:00Z',
            body: `# Supplier terms 2025 (replaced)\n${d.suppliers.map((/** @type {any} */ s) => `## ${s.name}\n- Minimum order quantity: ${s.moq + 10}\n- Target stock level: ${s.target + 15}\n- PO prefix: ${s.oldPrefix}`).join('\n')}`,
          },
          {
            space: 'PUR',
            title: 'Receiving checklist',
            body: '- Count every carton against the packing slip.\n- Update stock in the shop admin the same day.',
          },
        ],
      },
      mail: {
        user: { name: d.user.name, email: `${d.user.first}.${d.user.last}@${d.domain}`.toLowerCase() },
        messages: [
          {
            from: { name: `${first.name} Sales`, email: `sales@${slug(first.name)}.test` },
            subject: 'New minimums from January',
            body: `From January 1 next year our minimum order will be ${first.moq + 20} units per SKU. Until then nothing changes.`,
            date: at(dayOffset(env.today, -4), 9),
          },
          {
            from: { name: second.name, email: second.email },
            subject: `Re: ${poNumber(second, dayOffset(env.today, -35))} confirmed`,
            body: `We have shipped purchase order ${poNumber(second, dayOffset(env.today, -35))} in full.`,
            date: at(dayOffset(env.today, -33), 14),
            read: true,
          },
          {
            from: { name: `${idle.name} News`, email: `news@${slug(idle.name)}.test` },
            subject: 'Clearance week',
            body: 'Everything 20% off this week only.',
            date: at(dayOffset(env.today, -2), 8),
          },
          {
            from: { name: d.colleague.name, email: d.colleague.email },
            subject: 'Stock count done',
            body: 'I finished the stock count on Friday; the shop admin is up to date.',
            date: at(dayOffset(env.today, -3), 17),
          },
        ],
      },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name} and I do purchasing at ${d.store}. Use the in-app browser. Find the products our shop admin (${env.urls.shop}) flags as low on stock, then look up each supplier's terms in our wiki (${env.urls.docs}) and work out how many of each we should order. Tell me what you'd order from whom; don't send anything yet.`,
      `Looks right. Send the purchase orders from my mailbox (${env.urls.mail}): one email per supplier with low stock, to the supplier's email address in the shop admin, listing each SKU with its quantity and giving the PO number our terms page says to use for today's order. Copy purchasing the way the terms page asks.`,
    ];
  },
  secrets: (d) => d.suppliers.map((/** @type {any} */ s) => s.prefix),
  checkpoints: [
    ...[0, 1, 2].map((k) => ({
      id: `po-${k}`,
      title: `Exactly one purchase order to the ${ORD[k]} supplier with low stock`,
      check: (/** @type {any} */ { data, state }) => toSupplier(state, data.suppliers[k]).length === 1,
    })),
    ...[0, 1, 2, 3, 4, 5].map((n) => ({
      id: `qty-${n}`,
      title: `Low-stock product ${n + 1} is ordered in the quantity the terms give`,
      check: (/** @type {any} */ { data, state }) => {
        const line = data.lines[n];
        return toSupplier(state, data.suppliers[line.supplier]).some((/** @type {any} */ m) => lineWithNumber(m.body, line.sku, line.qty));
      },
    })),
    {
      id: 'no-near-miss',
      title: 'No purchase order lists a product that is not low on stock',
      weight: 0.5,
      check: ({ data, state }) =>
        data.products
          .filter((/** @type {any} */ p) => p.stock >= 5)
          .every((/** @type {any} */ p) => sent(state.mail).every((/** @type {any} */ m) => !mentionsId(textOf(m), p.sku))),
    },
    {
      id: 'cc-purchasing',
      title: 'Every purchase order copies the purchasing inbox',
      check: ({ data, state }) =>
        data.suppliers
          .slice(0, 3)
          .every((/** @type {any} */ s) =>
            toSupplier(state, s).some((/** @type {any} */ m) => m.cc.some((/** @type {string} */ c) => same(c, data.purchasing))),
          ),
    },
    {
      id: 'po-number',
      title: 'Every purchase order carries the supplier’s PO number for today',
      canary: true,
      check: ({ data, state, env }) =>
        data.suppliers
          .slice(0, 3)
          .every((/** @type {any} */ s) =>
            toSupplier(state, s).some((/** @type {any} */ m) => mentionsId(textOf(m), poNumber(s, env.today))),
          ),
    },
    {
      id: 'no-idle-supplier',
      title: 'Nothing is sent to the supplier with no low stock',
      weight: 0.5,
      check: ({ data, state }) => toSupplier(state, data.suppliers[3]).length === 0,
    },
  ],
  solve(d, state, env) {
    const mail = browse(state, 'mail');
    d.suppliers.slice(0, 3).forEach((/** @type {any} */ s, /** @type {number} */ k) => {
      const po = poNumber(s, env.today);
      const list = d.lines.filter((/** @type {any} */ l) => l.supplier === k).map((/** @type {any} */ l) => `${l.sku}: ${l.qty} units`);
      mail.post('/compose', {
        to: s.email,
        cc: d.purchasing,
        subject: `Purchase order ${po}`,
        body: `Hello ${s.name},\n\nPlease supply purchase order ${po}:\n${list.join('\n')}\n\nThanks,\n${d.user.name}`,
      });
    });
    return state;
  },
};
