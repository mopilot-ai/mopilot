// The turn's result in a popup (electron/capabilities/browser/hostTabs.cjs turnEnded): when the agent finishes in a window a page opened
// (a support chat, a checkout), that window stays with the tab that opened it, so a turn that ends on a question to the user keeps the
// conversation the agent was in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drive, setup } from './support/browser-host-kit.ts';

test('turnEnded: the popup the agent acted on last stays open with its opener; an older popup still closes', async (t) => {
  const h = setup(t, { attachMs: 1000 });
  const orders = await drive(t, h.tabs.create('c'));
  const older = h.tabs.adoptPopup(orders.wc, h.popupWC());
  await drive(t, h.tabs.ready(older, 'c'));
  const chat = h.tabs.adoptPopup(orders.wc, h.popupWC());
  await drive(t, h.tabs.ready(chat, 'c'));
  const out = await drive(t, h.tabs.turnEnded('c'));
  assert.equal(orders.result, true, 'the opener is the turn result');
  assert.ok(out.kept.includes(orders.id));
  assert.ok(out.kept.includes(chat.id), 'the window the agent finished in stays');
  assert.equal(chat.closed, false);
  assert.ok(out.closed.includes(older.id), 'a popup it left earlier still closes');
  assert.equal(chat.created, false, 'kept like any result: no longer temporary');
});

test('turnEnded: a popup is not kept when the agent went back to its opener afterwards', async (t) => {
  const h = setup(t, { attachMs: 1000 });
  const orders = await drive(t, h.tabs.create('c'));
  const signin = h.tabs.adoptPopup(orders.wc, h.popupWC());
  await drive(t, h.tabs.ready(signin, 'c'));
  await drive(t, h.tabs.ready(orders, 'c'));
  const out = await drive(t, h.tabs.turnEnded('c'));
  assert.ok(out.kept.includes(orders.id));
  assert.ok(out.closed.includes(signin.id));
});
