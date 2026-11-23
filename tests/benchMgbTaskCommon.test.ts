// bench/lib/mgb/tasks/common.mjs (#1381): the helpers tasks grade with: amounts in text, screenshots and PDFs by their
// bytes, sent mail, issues, events, changes made around the browser, and invoice fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../bench/lib/mgb/tasks/common.mjs');

test('amounts are read however they are written', () => {
  assert.deepEqual(c.amountsIn('Invoiced $1,234.50, expected 1200. Refund (12.00) or USD 80.'), [123450, 120000, -1200, 8000]);
  assert.deepEqual(c.amountsIn(null), []);
  assert.ok(c.mentionsAmount('total: $40.10.', 4010));
  assert.ok(!c.mentionsAmount('total: $40.10', 401));
});

test('screenshots and PDFs are recognised by type, name and bytes', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  assert.ok(c.isImage({ type: 'image/png', name: 'x', data: png }));
  assert.ok(c.isImage({ name: 'shot.JPG', data: png }));
  assert.ok(!c.isImage({ name: 'shot.png', data: Buffer.from([1]).toString('base64') }), 'an empty image is no screenshot');
  assert.ok(!c.isImage({ type: 'text/plain', name: 'a.txt', data: png }));
  assert.ok(!c.isImage({ name: 'shot.png' }));
  assert.ok(!c.isImage(null));
  assert.ok(!c.isImage({ data: png }), 'no type and no name');
  assert.ok(c.isPdf({ name: 'whatever.bin', data: Buffer.from('%PDF-1.4').toString('base64') }));
  assert.ok(!c.isPdf({ name: 'a.pdf', data: Buffer.from('hello').toString('base64') }));
  assert.ok(!c.isPdf(undefined));
});

test('sent mail, issues, events and changes made around the browser', () => {
  const mail = {
    messages: [
      { folder: 'sent', to: ['Bram@X.test'], cc: [], subject: 'S', body: 'B' },
      { folder: 'sent', to: ['a@b.test'], cc: ['bram@x.test'], subject: 'S2', body: 'B2' },
      { folder: 'inbox', to: ['bram@x.test'], cc: [] },
    ],
    events: [{ type: 'sent', via: 'browser' }, { type: 'sent', via: 'script' }, { type: 'opened' }],
  };
  assert.equal(c.sent(mail).length, 2);
  assert.equal(c.sentTo(mail, 'bram@x.test').length, 2);
  assert.deepEqual(c.sent(undefined), []);
  assert.equal(c.textOf({ subject: 'S', body: 'B' }), 'S\nB');
  assert.equal(c.textOf(undefined), '\n');
  const tracker = {
    issues: [
      { title: 'Invoice INV-1', body: 'order PO-2' },
      { title: 'Other', body: '' },
    ],
  };
  assert.equal(c.issuesMentioning(tracker, ['inv-1', 'po-2']).length, 1);
  assert.deepEqual(c.issuesMentioning(undefined, ['x']), []);
  assert.equal(c.eventsOf(mail, 'sent').length, 2);
  assert.deepEqual(c.eventsOf(null, 'sent'), []);
  assert.deepEqual(
    c.offSurface({ mail, tracker: { events: [{ type: 'created', via: 'page-script' }] }, files: { entries: {} }, run: null }),
    [
      { app: 'mail', type: 'sent', via: 'script' },
      { app: 'tracker', type: 'created', via: 'page-script' },
    ],
  );
  assert.deepEqual(c.offSurface(undefined as any), []);
});

test('invoice fixtures, totals and times', () => {
  const lines = [{ name: 'Oak tray', qty: 2, priceCents: 1250 }];
  assert.equal(c.orderTotal({ items: lines, shippingCents: 795 }), 3295);
  assert.equal(c.orderTotal({ items: lines }), 2500);
  const text = c.invoiceText({ number: 'INV-1', order: 'PO-2', lines, shippingCents: 0, totalCents: 2500, footer: 'Thanks' });
  assert.equal(text, 'Invoice INV-1\nYour order: PO-2\n\n2 x Oak tray @ $12.50 = $25.00\nShipping: $0.00\nAmount due: $25.00\n\nThanks');
  assert.doesNotMatch(c.invoiceText({ number: 'I', order: 'P', lines, shippingCents: 0, totalCents: 2500 }), /\n\n.*\n\n/);
  assert.equal(c.at('2026-10-19', 9), '2026-10-19T09:03:00Z');
});
