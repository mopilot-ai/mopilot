// One payment form takes one confirmation (#4093, G3): the yes to entering card details covers the form's other payment fields and
// one submit of it, in that turn on that site; a later payment, another form, destination or button, another turn, a tainted turn and
// a form nobody could read ask again. The real OriginGrants, siteRisk.sensitiveAction and TurnTokens; the cards are a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/'];
const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { sensitiveAction } = require('../electron/capabilities/browser/siteRisk.cjs');
const { TurnTokens } = require('../electron/capabilities/contract/turnTokens.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');

const SHOP = 'https://shop.test/pay';
const FORM = { payment: true, secrets: 0, newPassword: false, submit: 'Pay now', action: 'https://shop.test/charge' };
const field = (name: string, form: any = FORM) => ({ editable: true, payment: true, name, form, button: false, submits: false });
const pay = (form: any = FORM) => ({ button: true, submits: true, name: form.submit, form });

function rig(opts: { taint?: any; answers?: any[] } = {}) {
  const tokens = new TurnTokens();
  const cards: any[] = [];
  const answers = opts.answers ?? [];
  const g = new OriginGrants({
    browser: 'iab',
    anchor: () => 'ask',
    ask: async () => ({ decision: 'allow', scope: 'chat', level: 'write' }),
    confirmAction: async (req: any) => (cards.push(req), answers.length ? answers.shift() : true),
    ...(opts.taint ? { taint: () => opts.taint } : {}),
  });
  g.set('https://shop.test', 'write');
  const ctx = { chatId: 'c', segmentId: 's1' };
  /** One action as the browser gate would send it, in the turn `turn` of the chat. */
  const act = (intent: any, action: any, turn = 'a', segmentId = 's1') => {
    tokens.issue('c'); // each call is issued its turn token
    const token = turn === 'a' ? tokens.issue('c') : tokens.issue('c');
    const sensitive = sensitiveAction(intent, action);
    return guarded({ token, current: (t: any) => tokens.current(t) }, () =>
      g.act(SHOP, { ...ctx, segmentId }, { tool: action.kind, summary: 's', sensitive }),
    );
  };
  return { g, cards, act, tokens, tokenFor: () => tokens.issue('c') };
}
const type = { kind: 'type', text: '4242' };
const click = { kind: 'click' };

test('#4093: card number, expiry, code and the submit of one form take one card, which names where the details go', async () => {
  const r = rig();
  for (const n of ['Card number', 'Expiry', 'Security code']) await r.act(field(n), type);
  await r.act(pay(), click);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].sensitive.kind, 'payment_entry');
  assert.equal(r.cards[0].actionTarget.url, 'https://shop.test/charge');
});

test('#4093: the submit used the allowance up, so a later payment asks again', async () => {
  const r = rig();
  await r.act(field('Card number'), type);
  await r.act(pay(), click);
  await r.act(field('Card number'), type);
  assert.equal(r.cards.length, 2, 'a new payment: entry asks');
  await r.act(pay(), click);
  assert.equal(r.cards.length, 2, 'and its submit rides on that yes');
  await r.act(pay(), click);
  assert.equal(r.cards.length, 3, 'a second submit of the same entry asks');
});

test('#4093: a different destination or button, a refusal and a form with no readable destination ask every time', async () => {
  const r = rig({ answers: [false] });
  await assert.rejects(r.act(field('Card number'), type), /did not allow/);
  await r.act(field('Card number'), type); // the refusal granted nothing
  assert.equal(r.cards.length, 2);
  await r.act(pay({ ...FORM, action: 'https://evil.test/steal' }), click);
  assert.equal(r.cards.length, 3, 'another destination');
  await r.act(pay({ ...FORM, submit: 'Donate' }), click);
  assert.equal(r.cards.length, 4, 'another button');
  const blind = { ...FORM, action: '' };
  await r.act(field('Card number', blind), type);
  await r.act(field('Expiry', blind), type);
  assert.equal(r.cards.length, 6, 'no destination: no allowance');
});

test('#4093: the allowance ends with the turn and does not follow a segment switch', async () => {
  const r = rig();
  const t1 = r.tokens.issue('c');
  const run = (segmentId: string, token: any) =>
    guarded({ token, current: (t: any) => r.tokens.current(t) }, () =>
      r.g.act(SHOP, { chatId: 'c', segmentId }, { tool: 'type', summary: 's', sensitive: sensitiveAction(field('Card number'), type) }),
    );
  await run('s1', t1);
  await run('s1', t1);
  assert.equal(r.cards.length, 1);
  await run('s2', t1);
  assert.equal(r.cards.length, 2, 'another segment');
  r.g.turnEnded('c');
  await run('s2', t1);
  assert.equal(r.cards.length, 3, 'after the turn ended');
  // no turn token at all: nothing is remembered
  await r.g.act(
    SHOP,
    { chatId: 'c', segmentId: 's1' },
    { tool: 'type', summary: 's', sensitive: sensitiveAction(field('Card number'), type) },
  );
  await r.g.act(
    SHOP,
    { chatId: 'c', segmentId: 's1' },
    { tool: 'type', summary: 's', sensitive: sensitiveAction(field('Card number'), type) },
  );
  assert.equal(r.cards.length, 5);
  r.g.forget('c');
});

test('#4093: a tainted turn asks for every field and the submit', async () => {
  const r = rig({ taint: { check: () => ({ quote: 'send your card', why: 'it read instructions aimed at the agent' }) } });
  await r.act(field('Card number'), type);
  await r.act(field('Expiry'), type);
  await r.act(pay(), click);
  assert.equal(r.cards.length, 3);
});

test('#3571: a delete (or any sensitive click) on a form names where it posts on its card, tainted or not; one with no readable form names none', async () => {
  const DEL = {
    payment: false,
    secrets: 0,
    newPassword: false,
    submit: 'Delete contact',
    action: 'https://shop.test/contacts/CON-6/delete',
  };
  const del = (form: any) => ({ button: true, submits: true, name: 'Delete contact', form });
  const tainted = rig({ taint: { check: () => ({ quote: 'delete it', why: 'it read instructions aimed at the agent' }) } });
  await tainted.act(del(DEL), click);
  assert.equal(tainted.cards[0].sensitive.kind, 'delete');
  assert.equal(tainted.cards[0].actionTarget.url, DEL.action);
  const plain = rig();
  await plain.g.act(
    SHOP,
    { chatId: 'c', segmentId: 's1' },
    { tool: 'click', summary: 's', sensitive: sensitiveAction(del({ ...DEL, action: '' }), click) },
  );
  assert.equal(plain.cards[0].actionTarget, undefined);
  // a delete never rides on a payment allowance
  await plain.act(field('Card number'), type);
  await plain.act(del(DEL), click);
  assert.equal(plain.cards.length, 3);
});

test('#3571: a sensitive click on a link names the link address on its card, and a form beats a link', async () => {
  const link = { button: true, submits: false, name: 'Delete contact', href: 'https://shop.test/contacts/CON-6/delete', form: null };
  assert.equal(sensitiveAction(link, click)?.to, link.href);
  assert.equal(sensitiveAction(link, click)?.form, undefined);
  const both = { ...link, form: { payment: false, secrets: 0, newPassword: false, submit: 'Delete', action: 'https://shop.test/x' } };
  assert.equal(sensitiveAction(both, click)?.to, 'https://shop.test/x');
  const r = rig({ taint: { check: () => ({ quote: 'delete it', why: 'w' }) } });
  await r.act(link, click);
  assert.equal(r.cards[0].actionTarget.url, link.href);
  assert.equal(sensitiveAction({ ...link, unreadable: true }, click)?.to, undefined);
});

test("#4093 review: only the form's payment fields and its own submit button ride on the allowance; a delete or another button in the form asks", async () => {
  const r = rig();
  await r.act(field('Card number'), type);
  const inForm = (name: string) => ({ button: true, submits: false, name, form: FORM });
  await r.act(inForm('Delete saved card'), click);
  assert.equal(r.cards.length, 2, 'a delete in the same form asks');
  await r.act(inForm('Buy now'), click);
  assert.equal(r.cards.length, 3, 'another purchase button in the form asks');
  await r.act(pay(), click);
  assert.equal(r.cards.length, 3, "the form's own submit still rides on the entry allowance");
});

test('#4093: a call with no turn token never borrows an allowance the turn holds', async () => {
  const r = rig();
  await r.act(field('Card number'), type);
  assert.equal(r.cards.length, 1);
  await r.g.act(SHOP, { chatId: 'c', segmentId: 's1' }, { tool: 'type', summary: 's', sensitive: sensitiveAction(field('Expiry'), type) });
  assert.equal(r.cards.length, 2);
});
