// bench/lib/mgb/apps/shop.mjs and shopViews.mjs (#1381): the shop admin fixture's journeys (filter, refund, ship,
// cancel, edit and delete products, CSV export), validation, paging, 404s and fixture checks, graded from its state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { form, req, text } from './support/mgb-app-kit.ts';

const { shop, init } = await import('../bench/lib/mgb/apps/shop.mjs');

const NOW = Date.parse('2026-03-10T12:00:00Z');
const suppliers = [
  { id: 'SUP-1', name: 'Northwind Goods', email: 'orders@northwind.example' },
  { id: 'SUP-2', name: 'Bluebird Supply', email: 'hello@bluebird.example' },
];
const products = [
  { sku: 'MUG-01', name: 'Stoneware mug', supplierId: 'SUP-1', priceCents: 1250, stock: 40 },
  { sku: 'TEA-02', name: 'Loose leaf tea', supplierId: 'SUP-1', priceCents: 899, stock: 3 },
  { sku: 'PEN-03', name: 'Fountain pen', supplierId: 'SUP-2', priceCents: 4500, stock: 12 },
];
// twelve generated paid orders across February, plus named ones to act on
const filler = Array.from({ length: 12 }, (_, i) => ({
  id: `ORD-${200 + i}`,
  customer: { name: `Filler Customer ${i}`, email: `filler${i}@example.test` },
  createdAt: `2026-02-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
  status: 'delivered',
  items: [{ sku: 'PEN-03', qty: 1 }],
}));
const fixture = () => ({
  user: { name: 'Robin Admin' },
  suppliers,
  products,
  orders: [
    {
      id: 'ORD-100',
      customer: { name: 'Avery Stone', email: 'avery@example.test' },
      createdAt: '2026-03-02T09:30:00Z',
      status: 'paid',
      items: [
        { sku: 'MUG-01', qty: 2, priceCents: 1250 },
        { sku: 'TEA-02', qty: 1, priceCents: 899 },
      ],
      shippingCents: 500,
      note: 'Gift wrap please',
    },
    {
      id: 'ORD-101',
      customer: { name: 'Lee, Jordan "JJ"', email: 'jordan@example.test' },
      createdAt: '2026-03-05T15:00:00Z',
      status: 'pending',
      supplierId: 'SUP-2',
      items: [{ sku: 'PEN-03', qty: 1 }],
    },
    {
      id: 'ORD-102',
      customer: { name: 'Casey Field', email: 'casey@example.test' },
      createdAt: '2026-03-06T08:00:00Z',
      status: 'partially refunded',
      items: [{ sku: 'MUG-01', qty: 1 }],
      refunds: [
        { amountCents: 250, reason: 'chipped', at: '2026-03-07T08:00:00.000Z' },
        { amountCents: 100, reason: 'late' },
      ],
    },
    ...filler,
  ],
});

const fresh = () => init(fixture());
const get = (s: any, path: string) => shop.handle(req('GET', path, { app: 'shop' }), s, { now: NOW });
const post = (s: any, path: string, fields: Record<string, string> = {}) =>
  shop.handle(req('POST', path, { app: 'shop', ...form(fields) }), s, { now: NOW });
const follow = (s: any, res: any) => {
  assert.equal(res.status, 303);
  return get(s, res.headers.location);
};

test('the dashboard counts orders by status and links low stock', () => {
  const s = fresh();
  const page = text(get(s, '/'));
  assert.match(page, /Signed in as Robin Admin/);
  assert.match(page, /paid 1 shipped 0 delivered 12 refunded 0 partially refunded 1 cancelled 0/);
  assert.match(page, /Products low on stock: 1/);
  assert.equal(init({ suppliers: [], products: [], orders: [] }).user.name, 'Store admin');
});

test('filter the list, open an order, refund part then the rest: state, status, history and events', () => {
  const s = fresh();
  const list = get(s, '/orders?status=paid&supplier=SUP-1&from=2026-03-01&to=2026-03-31&q=avery');
  assert.match(text(list), /1 order Order/);
  assert.match(list.body, /<option value="paid" selected>/);
  assert.match(list.body, /href="\/orders.csv\?status=paid&amp;supplier=SUP-1&amp;from=2026-03-01&amp;to=2026-03-31&amp;q=avery"/);
  const detail = text(get(s, '/orders/ORD-100'));
  assert.match(detail, /Gift wrap please/);
  assert.match(detail, /Total: \$38\.99/);
  assert.match(detail, /No refunds\./);

  const over = post(s, '/orders/ORD-100/refund', { amount: '40.00', reason: 'damaged' });
  assert.equal(over.status, 422);
  assert.match(over.body, /role="alert">A refund cannot be more than \$38\.99/);
  assert.match(over.body, /name="amount" value="40.00"/);
  assert.match(over.body, /name="reason" size="50" value="damaged"/);
  assert.equal(s.refunds.length, 2);

  const part = follow(s, post(s, '/orders/ORD-100/refund', { amount: '$10', reason: 'damaged mug' }));
  assert.match(text(part), /Refund RF-3 of \$10\.00 issued\./);
  assert.match(text(part), /RF-3 \$10\.00 damaged mug/);
  assert.equal(s.orders[0].status, 'partially refunded');
  const rest = follow(s, post(s, '/orders/ORD-100/refund', { amount: '28.99', reason: 'returned' }));
  assert.match(text(rest), /Refund RF-4 of \$28\.99 issued\./);
  assert.match(text(rest), /Left to refund: \$0\.00/);
  assert.doesNotMatch(rest.body, /Issue refund/);
  assert.equal(s.orders[0].status, 'refunded');
  assert.deepEqual(
    s.orders[0].history.map((h: any) => h.status),
    ['paid', 'partially refunded', 'refunded'],
  );
  assert.deepEqual(s.refunds.slice(2), [
    { id: 'RF-3', orderId: 'ORD-100', amountCents: 1000, reason: 'damaged mug', at: '2026-03-10T12:00:00.000Z' },
    { id: 'RF-4', orderId: 'ORD-100', amountCents: 2899, reason: 'returned', at: '2026-03-10T12:00:00.000Z' },
  ]);
  assert.deepEqual(
    s.events.map((e: any) => [e.type, e.refundId, e.amountCents]),
    [
      ['refunded', 'RF-3', 1000],
      ['refunded', 'RF-4', 2899],
    ],
  );
  const again = post(s, '/orders/ORD-100/refund', { amount: '1', reason: 'x' });
  assert.equal(again.status, 422);
  assert.match(again.body, /ORD-100 is refunded and cannot be refunded/);
});

test('refund validation keeps what was entered', () => {
  const s = fresh();
  for (const [fields, error] of [
    [{ amount: 'ten', reason: 'r' }, /Enter a refund amount like 12\.50/],
    [{ amount: '0', reason: 'r' }, /Enter a refund amount/],
    [{ amount: '5', reason: '' }, /Enter a reason for the refund/],
  ] as const) {
    const res = post(s, '/orders/ORD-102/refund', fields);
    assert.equal(res.status, 422);
    assert.match(res.body, error);
  }
  // the fixture's refunds count: 12.50 - 3.50 is left
  assert.match(post(s, '/orders/ORD-102/refund', { amount: '9.01', reason: 'r' }).body, /more than \$9\.00/);
  assert.match(text(get(s, '/orders/ORD-102')), /RF-1 \$2\.50 chipped 2026-03-07 08:00 RF-2 \$1\.00 late 2026-03-06 08:00/);
  assert.equal(s.events.length, 0);
});

test('mark shipped needs a tracking number and a pending or paid order', () => {
  const s = fresh();
  const missing = post(s, '/orders/ORD-100/ship', { tracking: '  ' });
  assert.equal(missing.status, 422);
  assert.match(missing.body, /Enter a tracking number/);
  const shipped = follow(s, post(s, '/orders/ORD-100/ship', { tracking: '1Z999' }));
  assert.match(text(shipped), /Order ORD-100 marked shipped\. .*Tracking: 1Z999/);
  assert.doesNotMatch(shipped.body, /Mark shipped/);
  assert.match(shipped.body, /Issue refund/);
  assert.equal(s.orders[0].status, 'shipped');
  assert.deepEqual(s.events, [{ at: NOW, type: 'shipped', orderId: 'ORD-100', tracking: '1Z999' }]);
  const twice = post(s, '/orders/ORD-100/ship', { tracking: '1Z000' });
  assert.equal(twice.status, 422);
  assert.match(twice.body, /is shipped and cannot be shipped/);
});

test('cancel goes through a confirmation and only for pending or paid orders', () => {
  const s = fresh();
  const confirm = get(s, '/orders/ORD-101/cancel');
  assert.match(text(confirm), /Cancel order ORD-101\? This cannot be undone\./);
  assert.match(confirm.body, /action="\/orders\/ORD-101\/cancel"/);
  assert.equal(s.orders[1].status, 'pending');
  const done = follow(s, post(s, '/orders/ORD-101/cancel'));
  assert.match(text(done), /Order ORD-101 cancelled\./);
  assert.doesNotMatch(done.body, /Cancel order<\/a>/);
  assert.equal(s.orders[1].status, 'cancelled');
  assert.deepEqual(s.events, [{ at: NOW, type: 'cancelled', orderId: 'ORD-101', from: 'pending' }]);
  for (const res of [get(s, '/orders/ORD-101/cancel'), post(s, '/orders/ORD-101/cancel')]) {
    assert.equal(res.status, 422);
    assert.match(res.body, /ORD-101 is cancelled and cannot be cancelled/);
  }
  assert.equal(s.events.length, 1);
});

test('the CSV export follows the list filters and logs what was exported', () => {
  const s = fresh();
  post(s, '/orders/ORD-100/refund', { amount: '2.5', reason: 'r' });
  const res = get(s, '/orders.csv?supplier=SUP-1&from=2026-03-01&to=bad');
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="orders.csv"');
  assert.equal(
    res.body,
    [
      'id,date,customer,email,supplier,status,total,refunded',
      'ORD-102,2026-03-06,Casey Field,casey@example.test,Northwind Goods,partially refunded,12.50,3.50',
      'ORD-100,2026-03-02,Avery Stone,avery@example.test,Northwind Goods,partially refunded,38.99,2.50',
      '',
    ].join('\r\n'),
  );
  const quoted = get(s, '/orders.csv?q=jordan').body;
  assert.match(quoted, /\r\nORD-101,2026-03-05,"Lee, Jordan ""JJ""",jordan@example.test,Bluebird Supply,pending,45.00,0.00\r\n$/);
  const all = get(s, '/orders.csv');
  assert.equal(all.body.trim().split('\r\n').length, 16);
  assert.deepEqual(
    s.events.filter((e: any) => e.type === 'exported').map((e: any) => [e.filters, e.rows]),
    [
      [{ supplier: 'SUP-1', from: '2026-03-01' }, 2],
      [{ q: 'jordan' }, 1],
      [{}, 15],
    ],
  );
});

test('the order list pages by ten, newest first, and says when nothing matches', () => {
  const s = fresh();
  const first = get(s, '/orders');
  assert.match(text(first), /15 orders/);
  assert.match(text(first), /Page 1 of 2/);
  assert.match(first.body, /href="\/orders\?page=2"/);
  assert.ok(text(first).indexOf('ORD-102') < text(first).indexOf('ORD-100'));
  const second = text(get(s, '/orders?status=delivered&page=2'));
  assert.match(second, /12 orders .*Page 2 of 2/);
  assert.match(second, /ORD-201 .*ORD-200/);
  assert.doesNotMatch(second, /ORD-211/);
  assert.match(text(get(s, '/orders?to=2026-01-31')), /0 orders .*No orders match\./);
  assert.match(text(get(s, '/orders?q=ORD-101')), /1 order Order/);
});

test('products: search, low stock, edit with validation, delete through a confirmation', () => {
  const s = fresh();
  const list = text(get(s, '/products'));
  assert.match(list, /3 products .*TEA-02 Loose leaf tea Northwind Goods \$8\.99 3 \(low\)/);
  assert.match(text(get(s, '/products?low=1')), /1 product SKU/);
  assert.match(get(s, '/products?low=1').body, /value="1" checked>/);
  assert.match(text(get(s, '/products?q=pen')), /1 product .*PEN-03/);
  assert.match(text(get(s, '/products?q=zzz')), /No products match/);

  const edit = get(s, '/products/MUG-01');
  assert.match(edit.body, /name="price" value="12.50"/);
  assert.match(edit.body, /name="stock" value="40"/);
  for (const [fields, error] of [
    [{ price: 'free', stock: '4' }, /Enter a price like 12\.50/],
    [{ price: '-1', stock: '4' }, /Enter a price/],
    [{ price: '13', stock: '-2' }, /Stock must be a whole number/],
    [{ price: '13', stock: '2.5' }, /Stock must be a whole number/],
  ] as const) {
    const res = post(s, '/products/MUG-01', fields);
    assert.equal(res.status, 422);
    assert.match(res.body, error);
    assert.match(res.body, new RegExp(`name="stock" value="${fields.stock}"`));
  }
  assert.match(text(follow(s, post(s, '/products/MUG-01', { price: '$14.00', stock: '40' }))), /Product saved\./);
  follow(s, post(s, '/products/MUG-01', { price: '14', stock: '7' }));
  follow(s, post(s, '/products/MUG-01', { price: '14', stock: '7' }));
  assert.deepEqual(s.products[0], { sku: 'MUG-01', name: 'Stoneware mug', supplierId: 'SUP-1', priceCents: 1400, stock: 7 });
  assert.deepEqual(
    s.events.map((e: any) => e.changes),
    [{ priceCents: { from: 1250, to: 1400 } }, { stock: { from: 40, to: 7 } }],
  );

  const confirm = get(s, '/products/TEA-02/delete');
  assert.match(text(confirm), /Delete product Loose leaf tea\? This cannot be undone\./);
  assert.equal(s.products.length, 3);
  const after = follow(s, post(s, '/products/TEA-02/delete'));
  assert.match(text(after), /Deleted Loose leaf tea\. .*2 products/);
  assert.deepEqual(s.events.at(-1), { at: NOW, type: 'productDeleted', sku: 'TEA-02', name: 'Loose leaf tea' });
  // orders keep the deleted product's name
  assert.match(text(get(s, '/orders/ORD-100')), /TEA-02 Loose leaf tea 1 \$8\.99/);
});

test('suppliers list their emails, products and orders', () => {
  const s = fresh();
  assert.match(text(get(s, '/suppliers')), /Northwind Goods orders@northwind\.example 2 Bluebird Supply hello@bluebird\.example 1/);
  const one = get(s, '/suppliers/SUP-2');
  assert.match(one.body, /href="mailto:hello@bluebird.example"/);
  assert.match(text(one), /PEN-03 Fountain pen \$45\.00 12/);
  assert.match(text(one), /ORD-101/);
  assert.match(text(one), /ORD-211/);
  assert.doesNotMatch(text(one), /ORD-100/);
});

test('unknown pages, orders, products and suppliers are 404s', () => {
  const s = fresh();
  for (const [method, path] of [
    ['GET', '/nope'],
    ['GET', '/orders/ORD-999'],
    ['POST', '/orders/ORD-999/ship'],
    ['POST', '/orders/ORD-999/refund'],
    ['GET', '/orders/ORD-999/cancel'],
    ['POST', '/orders/ORD-999/cancel'],
    ['GET', '/products/NOPE'],
    ['POST', '/products/NOPE'],
    ['GET', '/products/NOPE/delete'],
    ['POST', '/products/NOPE/delete'],
    ['GET', '/suppliers/SUP-9'],
  ]) {
    assert.equal(shop.handle(req(method, path, { app: 'shop' }), s, { now: NOW }).status, 404, path);
  }
  assert.equal(s.events.length, 0);
});

test('init rejects fixtures with unknown references, statuses and bad values', () => {
  const base = fixture();
  const order = base.orders[0];
  const bad: [string, any][] = [
    ['needs a suppliers list', null],
    ['needs a orders list', { suppliers: [], products: [] }],
    ['every supplier needs', { ...base, suppliers: [{ id: 'S', name: 'N' }] }],
    ['duplicate supplier SUP-1', { ...base, suppliers: [...suppliers, suppliers[0]] }],
    ['needs a sku, name, price and stock', { ...base, products: [{ ...products[0], stock: -1 }] }],
    ['needs a sku, name, price and stock', { ...base, products: [{ ...products[0], priceCents: 1.5 }] }],
    ['needs a sku, name, price and stock', { ...base, products: [{ ...products[0], name: '' }] }],
    ['unknown supplier SUP-9', { ...base, products: [{ ...products[0], supplierId: 'SUP-9' }] }],
    ['duplicate product MUG-01', { ...base, products: [...products, products[0]] }],
    ['known status, not "lost"', { ...base, orders: [{ ...order, status: 'lost' }] }],
    ['needs an id', { ...base, orders: [{ ...order, id: '' }] }],
    ['customer name and email', { ...base, orders: [{ ...order, customer: undefined }] }],
    ['customer name and email', { ...base, orders: [{ ...order, customer: { name: 'A' } }] }],
    ['no valid createdAt', { ...base, orders: [{ ...order, createdAt: 'soon' }] }],
    ['has no items', { ...base, orders: [{ ...order, items: [] }] }],
    ['has no items', { ...base, orders: [{ ...order, items: 'MUG-01' }] }],
    ['unknown sku NOPE', { ...base, orders: [{ ...order, items: [{ sku: 'NOPE', qty: 1 }] }] }],
    ['bad quantity or price', { ...base, orders: [{ ...order, items: [{ sku: 'MUG-01', qty: 0 }] }] }],
    ['bad quantity or price', { ...base, orders: [{ ...order, items: [{ sku: 'MUG-01', qty: -1 }] }] }],
    ['bad quantity or price', { ...base, orders: [{ ...order, items: [{ sku: 'MUG-01', qty: 1, priceCents: -5 }] }] }],
    ['unknown supplier SUP-9', { ...base, orders: [{ ...order, supplierId: 'SUP-9' }] }],
    ['bad shipping amount', { ...base, orders: [{ ...order, shippingCents: 'free' }] }],
    ['refund without an amount or reason', { ...base, orders: [{ ...order, refunds: [{ amountCents: 0, reason: 'x' }] }] }],
    ['refund without an amount or reason', { ...base, orders: [{ ...order, refunds: [{ amountCents: -1, reason: 'x' }] }] }],
    ['refund without an amount or reason', { ...base, orders: [{ ...order, refunds: [{ amountCents: 1 }] }] }],
    ['duplicate order ORD-100', { ...base, orders: [order, order] }],
  ];
  for (const [message, f] of bad) assert.throws(() => init(f), { message: new RegExp(message) }, message);
  // a fixture's supplier wins over the first item's, and a missing note or shipping defaults
  const s = init({ ...base, orders: [{ ...order, supplierId: 'SUP-2', note: undefined, shippingCents: undefined }] });
  assert.deepEqual([s.orders[0].supplierId, s.orders[0].note, s.orders[0].shippingCents, s.seq, s.events], ['SUP-2', '', 0, 0, []]);
});

test('numeric ids in a fixture are read as text', () => {
  const s = init({
    suppliers: [{ id: 7, name: 'Harbor Freight', email: 'ap@harbor.test' }],
    products: [{ sku: 11, name: 'Oak tray', supplierId: 7, priceCents: 1200, stock: 3 }],
    orders: [
      {
        id: 'O-1',
        customer: { name: 'Uma Ulloa', email: 'uma@x.test' },
        createdAt: '2026-03-01T10:00:00Z',
        status: 'paid',
        items: [{ sku: 11, qty: 1 }],
      },
    ],
  });
  assert.deepEqual([s.products[0].supplierId, s.orders[0].supplierId, s.orders[0].items[0].sku], ['7', '7', '11']);
  assert.equal(init({ ...fixtureNumeric(), orders: [{ ...fixtureNumeric().orders[0], supplierId: 7 }] }).orders[0].supplierId, '7');
});

function fixtureNumeric() {
  return {
    suppliers: [{ id: 7, name: 'Harbor Freight', email: 'ap@harbor.test' }],
    products: [{ sku: 'S', name: 'Oak tray', supplierId: 7, priceCents: 1200, stock: 3 }],
    orders: [
      {
        id: 'O-1',
        customer: { name: 'Uma Ulloa', email: 'uma@x.test' },
        createdAt: '2026-03-01T10:00:00Z',
        status: 'paid',
        items: [{ sku: 'S', qty: 1 }],
      },
    ],
  };
}
