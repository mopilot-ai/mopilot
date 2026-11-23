// MoPilot 12-Grid Bench (#1381) shop admin fixture (shop.localhost): orders with filters, paging and CSV export, ship,
// refund and cancel; products to edit or delete; suppliers. Every change and export is in its state for graders.
import { fmtMoney, parseMoney } from '../seed.mjs';
import { download, field, logEvent, nextId, notFound, parseBody, redirect, route, withFlash } from './kit.mjs';
import {
  CANCELLABLE,
  confirmPage,
  dashboardPage,
  LOW_STOCK,
  orderPage,
  ordersPage,
  orderTotal,
  plain,
  productPage,
  productsPage,
  REFUNDABLE,
  refundedOf,
  SHIPPABLE,
  STATUSES,
  supplierName,
  supplierPage,
  suppliersPage,
  TITLE,
} from './shopViews.mjs';

const count = (/** @type {unknown} */ n) => Number.isInteger(n) && /** @type {number} */ (n) >= 0;
const isoOf = (/** @type {number} */ now) => new Date(now).toISOString();

/** Throws when two records share a key. @param {any[]} list @param {string} key @param {string} what */
function unique(list, key, what) {
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x[key])) throw new Error(`duplicate ${what} ${x[key]}`);
    seen.add(x[key]);
  }
}

/** An order from a fixture, its items priced and named from the catalog. @param {any} state @param {any} o */
function order(state, o) {
  if (!o.id || !STATUSES.includes(o.status)) throw new Error(`order ${o.id} needs an id and a known status, not "${o.status}"`);
  if (!o.customer?.name || !o.customer.email) throw new Error(`order ${o.id} needs a customer name and email`);
  if (Number.isNaN(Date.parse(o.createdAt))) throw new Error(`order ${o.id} has no valid createdAt`);
  if (!Array.isArray(o.items) || !o.items.length) throw new Error(`order ${o.id} has no items`);
  const items = o.items.map((/** @type {any} */ i) => {
    const p = state.products.find((/** @type {any} */ x) => x.sku === String(i.sku));
    if (!p) throw new Error(`order ${o.id} has an unknown sku ${i.sku}`);
    const priceCents = i.priceCents ?? p.priceCents;
    if (!count(i.qty) || !i.qty || !count(priceCents)) throw new Error(`order ${o.id} has a bad quantity or price for ${i.sku}`);
    return { sku: p.sku, name: p.name, qty: i.qty, priceCents };
  });
  const supplierId = String(o.supplierId ?? state.products.find((/** @type {any} */ x) => x.sku === items[0].sku).supplierId);
  if (!state.suppliers.some((/** @type {any} */ x) => x.id === supplierId))
    throw new Error(`order ${o.id} has an unknown supplier ${supplierId}`);
  const shippingCents = o.shippingCents ?? 0;
  if (!count(shippingCents)) throw new Error(`order ${o.id} has a bad shipping amount`);
  const createdAt = new Date(o.createdAt).toISOString();
  for (const r of o.refunds ?? []) {
    if (!count(r.amountCents) || !r.amountCents || !r.reason) throw new Error(`order ${o.id} has a refund without an amount or reason`);
    state.refunds.push({
      id: nextId(state, 'RF'),
      orderId: o.id,
      amountCents: r.amountCents,
      reason: String(r.reason),
      at: r.at ?? createdAt,
    });
  }
  return {
    id: String(o.id),
    customer: { name: String(o.customer.name), email: String(o.customer.email) },
    createdAt,
    status: o.status,
    supplierId,
    items,
    shippingCents,
    note: String(o.note ?? ''),
    tracking: null,
    history: [{ status: o.status, at: createdAt, note: 'imported' }],
  };
}

/**
 * The shop from a task's fixture: `{ user: { name }, suppliers: [{ id, name, email }], products: [{ sku, name, supplierId,
 * priceCents, stock }], orders: [{ id, customer: { name, email }, createdAt, status, supplierId?, items: [{ sku, qty,
 * priceCents? }], shippingCents?, note?, refunds?: [{ amountCents, reason, at? }] }] }`.
 * @param {any} f
 */
export function init(f) {
  for (const k of ['suppliers', 'products', 'orders']) if (!Array.isArray(f?.[k])) throw new Error(`shop fixture needs a ${k} list`);
  const state = {
    user: { name: String(f.user?.name ?? 'Store admin') },
    suppliers: /** @type {any[]} */ ([]),
    products: /** @type {any[]} */ ([]),
    orders: /** @type {any[]} */ ([]),
    refunds: /** @type {any[]} */ ([]),
    seq: 0,
    events: /** @type {any[]} */ ([]),
  };
  for (const x of f.suppliers) {
    if (!x.id || !x.name || !x.email) throw new Error('every supplier needs an id, name and email');
    state.suppliers.push({ id: String(x.id), name: String(x.name), email: String(x.email) });
  }
  unique(state.suppliers, 'id', 'supplier');
  for (const p of f.products) {
    if (!p.sku || !p.name || !count(p.priceCents) || !count(p.stock))
      throw new Error(`product ${p.sku} needs a sku, name, price and stock`);
    // ids are compared as text: a fixture may give them as numbers
    const supplierId = String(p.supplierId);
    if (!state.suppliers.some((x) => x.id === supplierId)) throw new Error(`product ${p.sku} has an unknown supplier ${p.supplierId}`);
    state.products.push({ sku: String(p.sku), name: String(p.name), supplierId, priceCents: p.priceCents, stock: p.stock });
  }
  unique(state.products, 'sku', 'product');
  for (const o of f.orders) state.orders.push(order(state, o));
  unique(state.orders, 'id', 'order');
  return state;
}

/** The order list's filters from a URL: status, supplier, from/to (YYYY-MM-DD) and a search. @param {URL} url */
function orderFilters(url) {
  const get = (/** @type {string} */ k) => (url.searchParams.get(k) ?? '').trim();
  const date = (/** @type {string} */ k) => (/^\d{4}-\d{2}-\d{2}$/.test(get(k)) ? get(k) : '');
  return { status: get('status'), supplier: get('supplier'), from: date('from'), to: date('to'), q: get('q') };
}

/** Orders matching the filters, newest first. @param {any} s @param {ReturnType<typeof orderFilters>} f @returns {any[]} */
function filterOrders(s, f) {
  const q = f.q.toLowerCase();
  return s.orders
    .filter(
      (/** @type {any} */ o) =>
        (!f.status || o.status === f.status) &&
        (!f.supplier || o.supplierId === f.supplier) &&
        (!f.from || o.createdAt.slice(0, 10) >= f.from) &&
        (!f.to || o.createdAt.slice(0, 10) <= f.to) &&
        (!q || [o.id, o.customer.name, o.customer.email].some((x) => x.toLowerCase().includes(q))),
    )
    .sort((/** @type {any} */ a, /** @type {any} */ b) => b.createdAt.localeCompare(a.createdAt));
}

const csvCell = (/** @type {string} */ v) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const findOrder = (/** @type {any} */ s, /** @type {string} */ id) => s.orders.find((/** @type {any} */ o) => o.id === id);
const findProduct = (/** @type {any} */ s, /** @type {string} */ sku) => s.products.find((/** @type {any} */ p) => p.sku === sku);
const productForm = (/** @type {any} */ p) => ({ price: plain(p.priceCents), stock: String(p.stock) });
const noOrder = () => notFound('No such order');
const noProduct = () => notFound('No such product');
const cannotCancel = (/** @type {any} */ o) => `Order ${o.id} is ${o.status} and cannot be cancelled.`;

/** Moves an order to a new status and records it in its history. @param {any} o @param {string} status @param {number} now @param {string} note */
function setStatus(o, status, now, note) {
  o.status = status;
  o.history.push({ status, at: isoOf(now), note });
}

/** @type {[string, string, (req: any, s: any, p: Record<string, string>, now: number) => any][]} */
const ROUTES = [
  ['GET', '/', (req, s) => dashboardPage(s, req.url)],
  [
    'GET',
    '/orders',
    (req, s) => {
      const f = orderFilters(req.url);
      return ordersPage(s, req.url, f, filterOrders(s, f));
    },
  ],
  [
    'GET',
    '/orders.csv',
    (req, s, _p, now) => {
      const f = orderFilters(req.url);
      const list = filterOrders(s, f);
      const rows = [
        ['id', 'date', 'customer', 'email', 'supplier', 'status', 'total', 'refunded'],
        ...list.map((o) => [
          o.id,
          o.createdAt.slice(0, 10),
          o.customer.name,
          o.customer.email,
          supplierName(s, o.supplierId),
          o.status,
          plain(orderTotal(o)),
          plain(refundedOf(s, o)),
        ]),
      ];
      logEvent(s, 'exported', { filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v)), rows: list.length }, now);
      const csv = `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
      return download('orders.csv', 'text/csv; charset=utf-8', csv);
    },
  ],
  [
    'GET',
    '/orders/:id',
    (req, s, p) => {
      const o = findOrder(s, p.id);
      return o ? orderPage(s, req.url, o) : noOrder();
    },
  ],
  [
    'POST',
    '/orders/:id/ship',
    (req, s, p, now) => {
      const o = findOrder(s, p.id);
      if (!o) return noOrder();
      const tracking = field(parseBody(req).fields, 'tracking');
      const error = !SHIPPABLE.includes(o.status)
        ? `Order ${o.id} is ${o.status} and cannot be shipped.`
        : !tracking
          ? 'Enter a tracking number.'
          : '';
      if (error) return orderPage(s, req.url, o, { tracking, amount: '', reason: '' }, error);
      o.tracking = tracking;
      setStatus(o, 'shipped', now, `tracking ${tracking}`);
      logEvent(s, 'shipped', { orderId: o.id, tracking }, now);
      return redirect(withFlash(`/orders/${o.id}`, `Order ${o.id} marked shipped.`));
    },
  ],
  [
    'POST',
    '/orders/:id/refund',
    (req, s, p, now) => {
      const o = findOrder(s, p.id);
      if (!o) return noOrder();
      const { fields } = parseBody(req);
      const d = { tracking: '', amount: field(fields, 'amount'), reason: field(fields, 'reason') };
      const left = orderTotal(o) - refundedOf(s, o);
      const cents = parseMoney(d.amount);
      const error = !REFUNDABLE.includes(o.status)
        ? `Order ${o.id} is ${o.status} and cannot be refunded.`
        : cents === null || cents <= 0
          ? 'Enter a refund amount like 12.50.'
          : cents > left
            ? `A refund cannot be more than ${fmtMoney(left)}, the amount left to refund.`
            : !d.reason
              ? 'Enter a reason for the refund.'
              : '';
      if (error) return orderPage(s, req.url, o, d, error);
      const amountCents = /** @type {number} */ (cents);
      const id = nextId(s, 'RF');
      s.refunds.push({ id, orderId: o.id, amountCents, reason: d.reason, at: isoOf(now) });
      setStatus(o, amountCents === left ? 'refunded' : 'partially refunded', now, `refund ${id} of ${fmtMoney(amountCents)}`);
      logEvent(s, 'refunded', { orderId: o.id, refundId: id, amountCents, reason: d.reason }, now);
      return redirect(withFlash(`/orders/${o.id}`, `Refund ${id} of ${fmtMoney(amountCents)} issued.`));
    },
  ],
  [
    'GET',
    '/orders/:id/cancel',
    (req, s, p) => {
      const o = findOrder(s, p.id);
      if (!o) return noOrder();
      if (!CANCELLABLE.includes(o.status)) return orderPage(s, req.url, o, undefined, cannotCancel(o));
      return confirmPage(
        req.url,
        `Cancel order ${o.id}? This cannot be undone.`,
        `/orders/${o.id}/cancel`,
        'Cancel order',
        `/orders/${o.id}`,
      );
    },
  ],
  [
    'POST',
    '/orders/:id/cancel',
    (req, s, p, now) => {
      const o = findOrder(s, p.id);
      if (!o) return noOrder();
      if (!CANCELLABLE.includes(o.status)) return orderPage(s, req.url, o, undefined, cannotCancel(o));
      const from = o.status;
      setStatus(o, 'cancelled', now, 'cancelled');
      logEvent(s, 'cancelled', { orderId: o.id, from }, now);
      return redirect(withFlash(`/orders/${o.id}`, `Order ${o.id} cancelled.`));
    },
  ],
  [
    'GET',
    '/products',
    (req, s) => {
      const q = (req.url.searchParams.get('q') ?? '').trim().toLowerCase();
      const low = req.url.searchParams.get('low') === '1';
      const list = s.products.filter(
        (/** @type {any} */ p) => (!low || p.stock < LOW_STOCK) && (!q || [p.sku, p.name].some((x) => x.toLowerCase().includes(q))),
      );
      return productsPage(s, req.url, { q, low }, list);
    },
  ],
  [
    'GET',
    '/products/:sku',
    (req, s, p) => {
      const product = findProduct(s, p.sku);
      return product ? productPage(s, req.url, product, productForm(product)) : noProduct();
    },
  ],
  [
    'POST',
    '/products/:sku',
    (req, s, p, now) => {
      const product = findProduct(s, p.sku);
      if (!product) return noProduct();
      const { fields } = parseBody(req);
      const d = { price: field(fields, 'price'), stock: field(fields, 'stock') };
      const cents = parseMoney(d.price);
      const error =
        cents === null || cents < 0
          ? 'Enter a price like 12.50.'
          : !/^\d+$/.test(d.stock)
            ? 'Stock must be a whole number, 0 or more.'
            : '';
      if (error) return productPage(s, req.url, product, d, error);
      const priceCents = /** @type {number} */ (cents);
      /** @type {Record<string, { from: number, to: number }>} */
      const changes = {};
      const stock = Number(d.stock);
      if (priceCents !== product.priceCents) changes.priceCents = { from: product.priceCents, to: priceCents };
      if (stock !== product.stock) changes.stock = { from: product.stock, to: stock };
      Object.assign(product, { priceCents, stock });
      if (Object.keys(changes).length) logEvent(s, 'productUpdated', { sku: product.sku, changes }, now);
      return redirect(withFlash(`/products/${product.sku}`, 'Product saved.'));
    },
  ],
  [
    'GET',
    '/products/:sku/delete',
    (req, s, p) => {
      const product = findProduct(s, p.sku);
      if (!product) return noProduct();
      return confirmPage(
        req.url,
        `Delete product ${product.name}? This cannot be undone.`,
        `/products/${product.sku}/delete`,
        'Delete product',
        `/products/${product.sku}`,
      );
    },
  ],
  [
    'POST',
    '/products/:sku/delete',
    (_req, s, p, now) => {
      const product = findProduct(s, p.sku);
      if (!product) return noProduct();
      s.products = s.products.filter((/** @type {any} */ x) => x !== product);
      logEvent(s, 'productDeleted', { sku: product.sku, name: product.name }, now);
      return redirect(withFlash('/products', `Deleted ${product.name}.`));
    },
  ],
  ['GET', '/suppliers', (req, s) => suppliersPage(s, req.url)],
  [
    'GET',
    '/suppliers/:id',
    (req, s, p) => {
      const x = s.suppliers.find((/** @type {any} */ y) => y.id === p.id);
      return x ? supplierPage(s, req.url, x) : notFound('No such supplier');
    },
  ],
];

/** @type {import('./server.mjs').App} */
export const shop = {
  name: 'shop',
  title: TITLE,
  init,
  handle(req, state, { now }) {
    const hit = route(req.method, req.url.pathname, ROUTES);
    return hit ? hit.handler(req, state, hit.params, now) : notFound();
  },
};
