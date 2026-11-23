// The Needs-you quick review and the receipts a card keeps: where it was answered, the card locking at the first tap, and nothing approvable outside the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, flush, click } from './support/phone/component-kit';
import { CARD_ANSWERED } from '../shared/remote/cardAnswered.mjs';
const receiptsPath = '../mobile/src/presentation/receipts';
const cardPath = '../mobile/src/components/RequestCard';
const { choiceLabel, receiptLine } = await import(receiptsPath);
const { RequestCard } = await import(cardPath);
import { mount, buttons, choices, runtimeFor, sheet, CARD } from './support/phone/review-kit';

test('a receipt says where the card was answered, and with what when this phone did it', () => {
  assert.equal(receiptLine({ by: 'mac' }), 'Answered on your Mac');
  assert.equal(receiptLine({ by: 'phone' }, 'ios'), 'Answered on this iPhone');
  assert.equal(receiptLine({ by: 'phone' }, 'android'), 'Answered on this phone');
  assert.equal(receiptLine({ by: 'phone', choice: 'Allowed once' }, 'ios'), 'Allowed once · answered on this iPhone');
  assert.equal(receiptLine({ by: 'mac', choice: 'Denied' }), 'Denied · answered on your Mac');
  // by default the phone this runs on
  assert.match(receiptLine({ by: 'phone' }), /^Answered on this (iPhone|phone)$/);
});

test('a choice is named by its label, and a plan that was sent back by what that asked', () => {
  assert.equal(choiceLabel({ choices }, 'always'), 'Always in this chat');
  assert.equal(choiceLabel({ choices }, 'deny'), 'Deny');
  assert.equal(choiceLabel({ kind: 'plan', choices }, 'deny'), 'Asked for changes');
  assert.equal(choiceLabel({ kind: 'plan', choices }, 'once'), 'Allow once');
  assert.equal(choiceLabel({ choices }, 'nope'), undefined);
  assert.equal(choiceLabel({}, 'once'), undefined);
});

test('a card keeps its title and loses its buttons once answered, with a receipt of where', async () => {
  const card = { id: 'k', rev: 1, title: 'Run this command?', detail: 'rm -rf dist coverage', choices };
  const open = await mount(createElement(RequestCard, { card, answer: async () => true }));
  assert.deepEqual(buttons(open.host), ['Allow once', 'Always in this chat', 'Deny']);
  assert.match(open.host.textContent!, /rm -rf dist coverage/);
  const mine = await mount(
    createElement(RequestCard, { card, answer: async () => true, receipt: { by: 'phone', choice: 'Allowed once' } }),
  );
  assert.match(mine.host.textContent!, /Run this command\?Allowed once · answered on this (iPhone|phone)/);
  assert.deepEqual(buttons(mine.host), []);
  assert.doesNotMatch(mine.host.textContent!, /rm -rf/, 'the details go with the buttons');
  const elsewhere = await mount(createElement(RequestCard, { card, answer: async () => true, answered: true }));
  assert.match(elsewhere.host.textContent!, /Answered on your Mac/);
  assert.deepEqual(buttons(elsewhere.host), []);
});

test('the card locks at the first tap: a second tap while the answer is on its way, and after it was taken, sends nothing', async () => {
  const card = { id: 'k', rev: 1, title: 'Run this command?', choices };
  let sent = 0;
  let finish: (v: boolean) => void = () => {};
  const { host } = await mount(
    createElement(RequestCard, {
      card,
      answer: () => (sent++, new Promise<boolean>((resolve) => (finish = resolve))),
    }),
  );
  await click('Allow once');
  await click('Deny');
  await click('Allow once');
  assert.equal(sent, 1);
  await act(async () => finish(true));
  await click('Always in this chat');
  assert.equal(sent, 1, 'an accepted answer holds every button until the Mac takes the card down');
  assert.ok([...host.querySelectorAll('button')].every((b) => b.disabled));
});

test('the sheet shows the command and the three choices of the chat that asks, answers once, and keeps a receipt', async () => {
  const r = runtimeFor({ cards: [CARD] });
  const { host } = await mount(sheet(r.runtime, { position: '1 of 2', next: () => {} }));
  assert.match(host.textContent!, /Clean up generated files1 of 2 · shop/);
  assert.match(host.textContent!, /Run this command\?rm -rf dist coverage/);
  assert.deepEqual(
    buttons(host).filter((b) => /Allow|Always|Deny/.test(b!)),
    ['Allow once', 'Always in this chat', 'Deny'],
  );
  assert.deepEqual(r.calls.find(([m]) => m === 'chat.follow')![1], { chatId: 'c1', items: 30 });
  await click('Allow once');
  assert.deepEqual(r.calls.find(([m]) => m === 'card.answer')![1], { chatId: 'c1', cardId: 'k1', rev: 1, key: 'once', values: {} });
  assert.match(host.textContent!, /Allow once · answered on this (iPhone|phone)/);
  assert.doesNotMatch(host.textContent!, /rm -rf/);
  // the Mac takes the card down: the receipt stays, and the sheet offers the next chat
  await r.emit({ ev: 'session.patch', rev: 2, patch: { cards: [], turn: 'running' } });
  assert.match(host.textContent!, /answered on this/);
  assert.ok(buttons(host).includes('Next chat'));
});

test('with nothing after it the sheet says Done; with a card still open it offers Later or Close and Open chat', async () => {
  const done: string[] = [];
  const r = runtimeFor({ cards: [CARD] });
  const { host } = await mount(sheet(r.runtime, { close: () => done.push('close'), openChat: () => done.push('open') }));
  assert.ok(buttons(host).includes('Close'));
  assert.ok(!buttons(host).includes('Done'));
  await click('Open chat');
  await click('Close');
  assert.deepEqual(done, ['open', 'close']);
  await click('Allow once');
  assert.ok(buttons(host).includes('Done'), 'nothing waits and no chat follows');
  assert.ok(!buttons(host).includes('Close'));
  await click('Done');
  assert.equal(done.at(-1), 'close');
  const later: string[] = [];
  const again = await mount(sheet(runtimeFor({ cards: [CARD] }).runtime, { next: () => later.push('next') }));
  await click('Later');
  assert.deepEqual(later, ['next']);
  assert.ok(buttons(again.host).includes('Later'));
});

test('a chat with nothing waiting, and one that cannot be read, say so', async () => {
  const none = await mount(sheet(runtimeFor({ cards: [] }).runtime));
  assert.match(none.host.textContent!, /Nothing is waiting for you in this chat now\./);
  assert.ok(buttons(none.host).includes('Done'));
  let attempts = 0;
  const flaky = runtimeFor({
    follow: () => {
      if (!attempts++) throw new Error('The chat could not be read. Try again.');
      return { rev: 1, feedSeq: 0, session: { turn: 'awaitingUser', cards: [CARD] }, itemsShape: 'rows', items: [] };
    },
  });
  const failed = await mount(sheet(flaky.runtime));
  assert.match(failed.host.textContent!, /The chat could not be read/);
  assert.doesNotMatch(failed.host.textContent!, /Loading…/);
  await click('Try again');
  assert.match(failed.host.textContent!, /Run this command\?/);
});

test('a card answered on the Mac first becomes its receipt; a lost connection is not confirmed; a refusal is an error', async () => {
  let fail: Error = new Error(CARD_ANSWERED);
  const r = runtimeFor({
    cards: [CARD],
    answer: () => {
      throw fail;
    },
  });
  const { host } = await mount(sheet(r.runtime));
  await click('Deny');
  assert.match(host.textContent!, /Answered on your Mac/);
  assert.ok(![...host.querySelectorAll('button')].some((b) => b.textContent === 'Deny'));
  const lost = runtimeFor({
    cards: [CARD],
    answer: () => {
      throw new Error('relay disconnected');
    },
  });
  const second = await mount(sheet(lost.runtime));
  await click('Allow once');
  assert.match(second.host.textContent!, /Answer not confirmed\. Check the chat before trying again\./);
  assert.ok(buttons(second.host).includes('Allow once'), 'the card can be answered again once checked');
  fail = new Error('Allow this from your Mac.');
  const refused = runtimeFor({
    cards: [CARD],
    answer: () => {
      throw fail;
    },
  });
  const third = await mount(sheet(refused.runtime));
  await click('Deny');
  assert.match(third.host.textContent!, /Allow this from your Mac\./);
  assert.doesNotMatch(third.host.textContent!, /not confirmed/);
});

test('the sheet follows its chat only while it is open, keeps what comes before the chat is read (to a bound) and drops other chats', async () => {
  const r = runtimeFor({ cards: [CARD] });
  let release: (v: unknown) => void = () => {};
  const slowRuntime: any = {
    ...r.runtime,
    request: (m: string, p: any) => (m === 'chat.follow' ? new Promise((resolve) => (release = resolve)) : r.runtime.request(m, p)),
  };
  const { host, root } = await mount(sheet(slowRuntime));
  assert.match(host.textContent!, /Loading…/);
  // the first event says the card is gone; a flood follows it, and what is past the bound is dropped
  await r.emit({ ev: 'session.patch', rev: 2, patch: { cards: [] } });
  for (let i = 3; i < 260; i++) await r.emit({ ev: 'session.patch', rev: i, patch: { turn: 'running' } });
  release({ rev: 1, feedSeq: 0, session: { turn: 'awaitingUser', cards: [CARD] }, itemsShape: 'rows', items: [] });
  await flush();
  assert.match(host.textContent!, /Nothing is waiting for you in this chat now\./);
  // an event of another chat changes nothing here; one of this chat does
  await r.raw({ kind: 'event', chatId: 'other', ev: 'session.patch', rev: 999, patch: { cards: [CARD] } });
  assert.doesNotMatch(host.textContent!, /Run this command\?/);
  await r.emit({ ev: 'session.patch', rev: 1000, patch: { cards: [{ ...CARD, id: 'k2', title: 'Another one?' }] } });
  assert.match(host.textContent!, /Another one\?/);
  // an event the thread cannot apply is shown as an error, not swallowed
  await r.emit({ ev: 'items.append', feedSeq: 'bad' });
  assert.match(host.textContent!, /Live updates need a newer MoPilot/);
  await act(async () => root.unmount());
  assert.ok(r.calls.some(([m]) => m === 'chat.unfollow'));
  assert.ok(r.calls.some(([m]) => m === 'off'));
});

const PLAN_CARD = {
  id: 'p1',
  rev: 1,
  title: 'Approve this plan?',
  kind: 'plan',
  plan: { text: '1. Round once' },
  choices: [
    { key: 'once', label: 'Approve plan' },
    { key: 'deny', label: 'Deny', deny: true },
  ],
};

test("in the quick review a plan's Ask for changes answers nothing and hands the chat over to ask what should change; Approve plan still answers", async () => {
  const r = runtimeFor({ cards: [PLAN_CARD] });
  const asked: string[] = [];
  const { host } = await mount(sheet(r.runtime, { askChanges: (card: string) => asked.push(card) }));
  await click('Ask for changes');
  assert.deepEqual(asked, [JSON.stringify(['p1', 1])], 'the card it was tapped on');
  assert.equal(
    r.calls.filter(([m]) => m === 'card.answer').length,
    0,
    'a refusal with nothing said about what to change is not sent from here',
  );
  assert.ok(buttons(host).includes('Ask for changes'), 'the card still waits, with its buttons');
  await click('Approve plan');
  assert.deepEqual(
    r.calls.filter(([m]) => m === 'card.answer').map(([, p]) => p.key),
    ['once'],
  );
});

test('with no chat to hand over to, the sheet answers a plan as it always did', async () => {
  const r = runtimeFor({ cards: [PLAN_CARD] });
  await mount(sheet(r.runtime));
  await click('Ask for changes');
  assert.deepEqual(
    r.calls.filter(([m]) => m === 'card.answer').map(([, p]) => p.key),
    ['deny'],
  );
});
