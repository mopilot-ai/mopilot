// MoMo's connect card (momoConnect, momo/sources/connectAsk.cjs) on a phone: a card to finish on the Mac with fixed text and no choices, refused when answered, gone when the Mac connects or says Not now, plus the read-only sources status the MoMo tab's first run reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { settle } from './support/remote-kit.ts';
import { ok, fail, momoRig, cardRig } from './support/remote-momo-kit.ts';

const require = createRequire(import.meta.url);
const { createConnectAsk } = require('../electron/momo/sources/connectAsk.cjs');
const { momoConnectCard } = require('../electron/remote/momoCard.cjs');
const { cardOf, answerOf } = require('../electron/capabilities/browser/chromePanelCards.cjs');

/** The real connect ask over the cardRig's broker, with a hub whose sources the test connects. */
async function connectRig() {
  const rig = await cardRig();
  const connected = new Set<string>();
  const hub: any = Object.assign(new EventEmitter(), { ready: (id: string) => connected.has(id) });
  const clock = { now: 1_000 };
  const ask = createConnectAsk({
    broker: () => (rig.m.live.computerUse as any).broker,
    hub,
    harnessOf: () => 'claude',
    attended: () => true,
    now: () => clock.now,
  });
  ok(await rig.p.ask('momo.chat.follow', {}));
  return { ...rig, ask, hub, connected, clock, broker: (rig.m.live.computerUse as any).broker };
}
const cards = (r: Awaited<ReturnType<typeof connectRig>>) => r.m.r.ops.cardsOf();

test('a connect request reaches the phone as a card to finish on the Mac: fixed text, no choices, nothing the tool read', async () => {
  const r = await connectRig();
  const outcome = r.ask.ask({ chatId: 'momo-main', source: 'calendar' });
  await settle();
  const [card] = await cards(r);
  assert.equal(card.inApp, true);
  assert.equal(card.detail, null);
  assert.equal(card.choices, undefined);
  assert.equal(card.title, 'MoMo needs Calendar. Allow it on your Mac.');
  assert.deepEqual(Object.keys(card).sort(), ['detail', 'id', 'inApp', 'title', 'version']);
  // the phone cannot connect anything: both answer paths refuse
  fail(
    await r.p.ask('card.answer', { chatId: 'momo-main', cardId: card.id, rev: 4, key: 'connect' }),
    'forbidden',
    /Finish this on your Mac/,
  );
  fail(await r.p.ask('momo.card.answer', { cardId: card.id, rev: 4, key: 'connect' }), 'stale');
  assert.equal(r.approvals.length, 1);
  // the Mac connects (here or in Settings): the card goes and the tool's ask ends connected
  r.connected.add('calendar');
  r.hub.emit('changed');
  assert.equal(await outcome, 'connected');
  assert.deepEqual(await cards(r), []);
});

test('Not now on the Mac removes the card, and the cooldown shows no stale card on the phone', async () => {
  const r = await connectRig();
  const first = r.ask.ask({ chatId: 'momo-main', source: 'reminders' });
  await settle();
  const [card] = await cards(r);
  assert.equal(card.title, 'MoMo needs Reminders. Allow it on your Mac.');
  r.broker.answer(card.id, { decision: 'deny' });
  assert.equal(await first, 'declined');
  assert.deepEqual(await cards(r), []);
  // asked again inside the cooldown: no new card; after it, a fresh one
  assert.equal(await r.ask.ask({ chatId: 'momo-main', source: 'reminders' }), 'declined');
  assert.deepEqual(await cards(r), []);
  r.clock.now += 5 * 60_000 + 1;
  const again = r.ask.ask({ chatId: 'momo-main', source: 'reminders' });
  await settle();
  assert.equal((await cards(r)).length, 1);
  r.ask.withdrawChat('momo-main');
  assert.equal(await again, 'none');
  assert.deepEqual(await cards(r), []);
});

test('the card text is fixed: an unknown source or a value a tool put in the params is never shown, and the card offers nothing to answer', () => {
  assert.equal(momoConnectCard({ source: 'calendar' }).title, 'MoMo needs Calendar. Allow it on your Mac.');
  for (const m of [{ source: 'Lunch with Ann' }, {}, undefined, null])
    assert.equal(momoConnectCard(m).title, 'MoMo needs Calendar or Reminders. Allow it on your Mac.');
  const approval = {
    id: 'a1',
    method: 'sage/approval',
    params: { kind: 'momoConnect', momoConnect: { source: 'calendar', events: ['secret'] } },
  };
  assert.doesNotMatch(JSON.stringify(cardOf(approval, 'MoMo')), /secret/);
  assert.equal(answerOf(approval, 'connect', 'MoMo'), null);
});

test('the sources status tells which of Calendar and Reminders are connected, nothing they hold, and follows MoMo being off', async () => {
  const m = momoRig();
  m.sourceList.sources = [
    { id: 'calendar', connected: true, label: 'Calendar' },
    { id: 'reminders', connected: false, label: 'Reminders' },
    { id: 'files', connected: true, folders: ['/Users/x/secret'] },
  ];
  const p = m.r.phone('p1');
  assert.deepEqual(ok(await p.ask('momo.sources.status', {})), { calendar: true, reminders: false });
  m.sourceList.sources = [];
  assert.deepEqual(ok(await p.ask('momo.sources.status', {})), { calendar: false, reminders: false });
  m.gate.allowed = false;
  fail(await p.ask('momo.sources.status', {}), 'forbidden');
  // a change to the sources tells the phone which part changed, never what
  m.wired.broadcast('momoSources:changed');
  assert.deepEqual(
    p.events('momo.changed').map((e: any) => e.area),
    ['sources'],
  );
});
