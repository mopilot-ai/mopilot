// Every card a tool call asks on passes the call's abort signal to the broker (#1865, [unsignalled-wait]): main's site
// and action cards (browserSiteTables.cjs), the per-call JavaScript/upload card, the dev server card, and an aborted call's
// card leaving the chat in both browsers' tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { siteTables, confirmCall } = require('../electron/app/browserSiteTables.cjs');
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');

/** main's services with a real broker over a controller that only keeps the cards up */
function live() {
  const cards = new Map<string, any>();
  const broker = new ApprovalBroker({
    controller: { addApproval: (_c: string, a: any) => void cards.set(a.id, a), resolveApproval: (id: string) => cards.delete(id) },
  });
  const sessions = new Map<string, any>([['c1', { permission: 'default', activeTurn: { id: 't' } }]]);
  return {
    cards,
    broker,
    live: {
      sessions,
      controller: { ref: () => ({ kind: 'codex', id: null }), adapterOf: () => ({}) },
      remoteOwners: { get: () => null },
      computerUse: { broker },
    },
  };
}

test("both browsers' site and action cards go with an aborted call, and store nothing", async () => {
  const { cards, broker, live: l } = live();
  const { browserGrants, chromeGrants } = siteTables({ live: l, dir: '/tmp/none', prefs: () => ({}), isFlagEnabled: () => false });
  for (const g of [browserGrants, chromeGrants]) {
    const ac = new AbortController();
    const ctx = { chatId: 'c1', segmentId: 's1', signal: ac.signal };
    const site = g.require('https://a.test/', 'write', ctx);
    await tick();
    const [card] = [...cards.values()];
    assert.equal(card.params.kind, 'browserOrigin');
    assert.equal(card.params.browser, g.browser);
    ac.abort();
    await assert.rejects(site, { code: 'aborted' });
    assert.equal(cards.size, 0);
    assert.equal(broker.answer(card.id, { decision: 'allow', scope: 'chat', level: 'write' }), false);
    assert.equal(g.chatGrants.get('c1'), undefined);

    const act = new AbortController();
    const action = g.act('https://a.test/', { chatId: 'c1', segmentId: 's1', signal: act.signal }, { sensitive: { verb: 'delete' } });
    await tick();
    assert.equal([...cards.values()][0].params.kind, 'computerConfirm');
    act.abort();
    await assert.rejects(action, { code: 'aborted' });
    assert.equal(cards.size, 0);
    // entering payment details or paying is marked: its card is answered on the Mac only (electron/remote/methods/card.cjs)
    for (const [kind, macOnly] of [
      ['payment', 'payment'],
      ['payment_entry', 'payment_entry'],
      ['purchase', 'purchase'],
      ['transfer', 'transfer'],
      ['password_change', 'password_change'],
      ['delete', undefined],
      ['send_message', undefined],
    ] as const) {
      const pay = new AbortController();
      const paid = g.act('https://a.test/', { chatId: 'c1', segmentId: 's1', signal: pay.signal }, { sensitive: { kind, verb: 'pay' } });
      await tick();
      assert.equal([...cards.values()][0].params.macOnly, macOnly, kind);
      pay.abort();
      await assert.rejects(paid, { code: 'aborted' });
    }
  }
});

test('the JavaScript and upload card goes with an aborted call', async () => {
  const { cards, live: l } = live();
  const ac = new AbortController();
  const asked = confirmCall(l, 'iab')({ chatId: 'c1', signal: ac.signal }, { tool: 'upload', origin: 'https://a.test' });
  assert.equal(cards.size, 1);
  ac.abort();
  assert.equal(await asked, false);
  assert.equal(cards.size, 0);
  // a caller with no signal keeps the card up until it is answered
  const plain = confirmCall(l, 'chrome')({ chatId: 'c1' }, { tool: 'JavaScript', origin: 'https://a.test' });
  assert.equal(cards.size, 1);
  l.computerUse.broker.answer([...cards.keys()][0], { decision: 'allow' });
  assert.equal(await plain, true);
});
