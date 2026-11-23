// MoPilot 12-Grid Bench (#1381) shop admin fixture pages (shop.localhost): dashboard, orders, order detail, confirmations,
// products, suppliers; and the order statuses, totals and refunded amounts the pages and the CSV export share.
import { fmtMoney } from '../seed.mjs';
import { flashOf, html, ok, page, paginate, raw } from './kit.mjs';

export const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'refunded', 'partially refunded', 'cancelled'];
export const SHIPPABLE = ['pending', 'paid'];
export const REFUNDABLE = ['paid', 'shipped', 'delivered', 'partially refunded'];
export const CANCELLABLE = ['pending', 'paid'];
/** Products with fewer units than this are low on stock. */
export const LOW_STOCK = 5;
export const TITLE = 'Shop admin';

/** Items plus shipping, in cents. @param {any} o */
export const orderTotal = (o) =>
  o.items.reduce((/** @type {number} */ t, /** @type {any} */ i) => t + i.qty * i.priceCents, 0) + o.shippingCents;
/** @param {any} s @param {any} o @returns {any[]} */
export const refundsOf = (s, o) => s.refunds.filter((/** @type {any} */ r) => r.orderId === o.id);
/** The sum of an order's refunds, in cents. @param {any} s @param {any} o */
export const refundedOf = (s, o) => refundsOf(s, o).reduce((t, r) => t + r.amountCents, 0);
/** @param {any} s @param {string} id @returns {string} */
export const supplierName = (s, id) => s.suppliers.find((/** @type {any} */ x) => x.id === id).name;
/** Cents as a plain decimal: 1250 → "12.50". @param {number} cents */
export const plain = (cents) => (cents / 100).toFixed(2);
const day = (/** @type {string} */ iso) => iso.slice(0, 16).replace('T', ' ');

/** @type {[string, string][]} */
const NAV = [
  ['/', 'Dashboard'],
  ['/orders', 'Orders'],
  ['/products', 'Products'],
  ['/suppliers', 'Suppliers'],
];

/** A page in the shop frame; with an error, a 422 that keeps what was entered. @param {URL} url @param {string} title @param {unknown} body */
export function view(url, title, body, error = '') {
  const res = ok(page({ app: TITLE, title, nav: NAV, flash: flashOf(url), error, body }));
  return error ? { ...res, status: 422 } : res;
}

const opt = (/** @type {string} */ value, /** @type {string} */ label, /** @type {string} */ current) =>
  html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`;

/** @param {any} s @param {URL} url */
export function dashboardPage(s, url) {
  const low = s.products.filter((/** @type {any} */ p) => p.stock < LOW_STOCK).length;
  const rows = STATUSES.map(
    (st) =>
      html`<tr><td><a href="/orders?status=${encodeURIComponent(st)}">${st}</a></td><td>${s.orders.filter((/** @type {any} */ o) => o.status === st).length}</td></tr>`,
  );
  return view(
    url,
    'Dashboard',
    html`<h1>Dashboard</h1><p class="muted">Signed in as ${s.user.name}</p>
<table><thead><tr><th>Status</th><th>Orders</th></tr></thead><tbody>${rows}</tbody></table>
<p><a href="/products?low=1">Products low on stock: ${low}</a></p>`,
  );
}

/** @param {any} s @param {any} o */
const orderRow = (s, o) =>
  html`<tr><td><a href="/orders/${o.id}">${o.id}</a></td><td>${day(o.createdAt)}</td><td>${o.customer.name}</td><td>${supplierName(s, o.supplierId)}</td><td>${o.status}</td><td>${fmtMoney(orderTotal(o))}</td><td>${fmtMoney(refundedOf(s, o))}</td></tr>`;
const ORDER_HEAD = html`<thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Supplier</th><th>Status</th><th>Total</th><th>Refunded</th></tr></thead>`;

/** @param {any} s @param {URL} url @param {Record<string, string>} f the filters @param {any[]} list the matching orders */
export function ordersPage(s, url, f, list) {
  const { items, pager } = paginate(list, url);
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  return view(
    url,
    'Orders',
    html`<h1>Orders</h1><form method="get" action="/orders">
<label for="status">Status</label><select id="status" name="status">${opt('', 'Any status', f.status)}${STATUSES.map((st) => opt(st, st, f.status))}</select>
<label for="supplier">Supplier</label><select id="supplier" name="supplier">${opt('', 'Any supplier', f.supplier)}${s.suppliers.map((/** @type {any} */ x) => opt(x.id, x.name, f.supplier))}</select>
<label for="from">Placed from</label><input id="from" type="date" name="from" value="${f.from}">
<label for="to">Placed to</label><input id="to" type="date" name="to" value="${f.to}">
<label for="q">Search</label><input id="q" type="search" name="q" value="${f.q}" placeholder="Order id or customer">
<p><button>Filter</button> <a href="/orders.csv?${q}">Export CSV</a></p></form>
<p class="muted">${list.length} order${list.length === 1 ? '' : 's'}</p>
<table>${ORDER_HEAD}<tbody>${items.length ? items.map((o) => orderRow(s, o)) : html`<tr><td colspan="7">No orders match.</td></tr>`}</tbody></table>${pager}`,
  );
}

/**
 * @param {any} s @param {URL} url @param {any} o
 * @param {{ tracking: string, amount: string, reason: string }} [d] what the ship and refund forms hold
 */
export function orderPage(s, url, o, d = { tracking: '', amount: '', reason: '' }, error = '') {
  const total = orderTotal(o);
  const refunded = refundedOf(s, o);
  const refunds = refundsOf(s, o);
  const items = o.items.map(
    (/** @type {any} */ i) =>
      html`<tr><td>${i.sku}</td><td>${i.name}</td><td>${i.qty}</td><td>${fmtMoney(i.priceCents)}</td><td>${fmtMoney(i.qty * i.priceCents)}</td></tr>`,
  );
  return view(
    url,
    `Order ${o.id}`,
    html`<div class="card"><h1>Order ${o.id}</h1>
<p><strong>Status:</strong> ${o.status}<br><strong>Placed:</strong> ${day(o.createdAt)}<br><strong>Customer:</strong> ${o.customer.name} &lt;${o.customer.email}&gt;<br><strong>Supplier:</strong> <a href="/suppliers/${o.supplierId}">${supplierName(s, o.supplierId)}</a>${o.tracking ? html`<br><strong>Tracking:</strong> ${o.tracking}` : ''}</p>
${o.note ? html`<p><strong>Note:</strong> ${o.note}</p>` : ''}
<table><thead><tr><th>SKU</th><th>Product</th><th>Qty</th><th>Price</th><th>Line total</th></tr></thead><tbody>${items}</tbody></table>
<p>Shipping: ${fmtMoney(o.shippingCents)}<br><strong>Total: ${fmtMoney(total)}</strong><br>Refunded: ${fmtMoney(refunded)}<br>Left to refund: ${fmtMoney(total - refunded)}</p></div>
<h2>Refunds</h2>${refunds.length ? html`<table><thead><tr><th>Refund</th><th>Amount</th><th>Reason</th><th>Date</th></tr></thead><tbody>${refunds.map((r) => html`<tr><td>${r.id}</td><td>${fmtMoney(r.amountCents)}</td><td>${r.reason}</td><td>${day(r.at)}</td></tr>`)}</tbody></table>` : html`<p class="muted">No refunds.</p>`}
<h2>Status history</h2><ol>${o.history.map((/** @type {any} */ h) => html`<li>${day(h.at)}: ${h.status} (${h.note})</li>`)}</ol>
${SHIPPABLE.includes(o.status) ? html`<form method="post" action="/orders/${o.id}/ship" class="card"><h2>Mark shipped</h2><label for="tracking">Tracking number</label><input id="tracking" name="tracking" value="${d.tracking}"> <button>Mark shipped</button></form>` : ''}
${REFUNDABLE.includes(o.status) ? html`<form method="post" action="/orders/${o.id}/refund" class="card"><h2>Issue refund</h2><label for="amount">Amount</label><input id="amount" name="amount" value="${d.amount}"><label for="reason">Reason</label><input id="reason" name="reason" size="50" value="${d.reason}"> <button>Issue refund</button></form>` : ''}
${CANCELLABLE.includes(o.status) ? html`<p><a href="/orders/${o.id}/cancel">Cancel order</a></p>` : ''}`,
    error,
  );
}

/** A confirmation before something that cannot be undone. @param {URL} url @param {string} question @param {string} action @param {string} button @param {string} back */
export const confirmPage = (url, question, action, button, back) =>
  view(
    url,
    'Confirm',
    html`<div class="card"><h1>${question}</h1><form method="post" action="${action}"><button>${button}</button> <a href="${back}">Go back</a></form></div>`,
  );

/** @param {any} s @param {URL} url @param {{ q: string, low: boolean }} f @param {any[]} list */
export function productsPage(s, url, f, list) {
  const { items, pager } = paginate(list, url);
  const rows = items.map(
    (p) =>
      html`<tr><td><a href="/products/${p.sku}">${p.sku}</a></td><td>${p.name}</td><td>${supplierName(s, p.supplierId)}</td><td>${fmtMoney(p.priceCents)}</td><td>${p.stock}${p.stock < LOW_STOCK ? ' (low)' : ''}</td></tr>`,
  );
  return view(
    url,
    'Products',
    html`<h1>Products</h1><form method="get" action="/products"><input type="search" name="q" value="${f.q}" aria-label="Search products" placeholder="SKU or name">
<label><input type="checkbox" name="low" value="1"${f.low ? raw(' checked') : ''}> Low stock only</label> <button>Filter</button></form>
<p class="muted">${list.length} product${list.length === 1 ? '' : 's'}</p>
<table><thead><tr><th>SKU</th><th>Name</th><th>Supplier</th><th>Price</th><th>Stock</th></tr></thead><tbody>${rows.length ? rows : html`<tr><td colspan="5">No products match.</td></tr>`}</tbody></table>${pager}`,
  );
}

/** @param {any} s @param {URL} url @param {any} p @param {{ price: string, stock: string }} d @param {string} [error] */
export const productPage = (s, url, p, d, error = '') =>
  view(
    url,
    p.name,
    html`<h1>${p.name}</h1><p class="muted">${p.sku} · ${supplierName(s, p.supplierId)}</p>
<form method="post" action="/products/${p.sku}" class="card"><label for="price">Price</label><input id="price" name="price" value="${d.price}">
<label for="stock">Stock</label><input id="stock" name="stock" value="${d.stock}"><p><button>Save</button></p></form>
<p><a href="/products/${p.sku}/delete">Delete product</a></p>`,
    error,
  );

/** @param {any} s @param {URL} url */
export const suppliersPage = (s, url) =>
  view(
    url,
    'Suppliers',
    html`<h1>Suppliers</h1><table><thead><tr><th>Supplier</th><th>Email</th><th>Products</th></tr></thead><tbody>${s.suppliers.map(
      (/** @type {any} */ x) =>
        html`<tr><td><a href="/suppliers/${x.id}">${x.name}</a></td><td>${x.email}</td><td>${s.products.filter((/** @type {any} */ p) => p.supplierId === x.id).length}</td></tr>`,
    )}</tbody></table>`,
  );

/** @param {any} s @param {URL} url @param {any} x the supplier */
export function supplierPage(s, url, x) {
  const products = s.products.filter((/** @type {any} */ p) => p.supplierId === x.id);
  const orders = s.orders.filter((/** @type {any} */ o) => o.supplierId === x.id);
  return view(
    url,
    x.name,
    html`<h1>${x.name}</h1><p>Email: <a href="mailto:${x.email}">${x.email}</a></p>
<h2>Products</h2><table><thead><tr><th>SKU</th><th>Name</th><th>Price</th><th>Stock</th></tr></thead><tbody>${products.map((/** @type {any} */ p) => html`<tr><td><a href="/products/${p.sku}">${p.sku}</a></td><td>${p.name}</td><td>${fmtMoney(p.priceCents)}</td><td>${p.stock}</td></tr>`)}</tbody></table>
<h2>Orders</h2><table>${ORDER_HEAD}<tbody>${orders.map((/** @type {any} */ o) => orderRow(s, o))}</tbody></table>`,
  );
}
