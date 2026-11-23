// The recipients on MoMo's approval card (#4649 A4): the card params main builds (every recipient with what it is, the full count past the cut, why a blocked card has no allow) and the phone's classic card made from them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cardParams, answerOf, MAX_LIST } = require('../electron/momo/actionAsk.cjs');
const { momoActionCard } = require('../electron/remote/momoCard.cjs');

const card = {
  chatId: 'c',
  tool: 'send_mail',
  source: 'mail',
  account: 'work',
  kind: 'change',
  summary: 'Send',
  reasons: [] as string[],
  scopes: ['once'],
  denyAlways: true,
};
const dest = (recipients: unknown) => ({ hosts: [], recipients, unknown: false });

test('the card names every recipient with what it is, and the full count past the cut', () => {
  const many = Array.from({ length: MAX_LIST + 3 }, (_, i) => `p${i}@example.com`);
  const p = cardParams({ ...card, destinations: dest(many) } as any, () => '');
  assert.equal(p.recipients.length, MAX_LIST);
  assert.equal(p.recipientItems.length, MAX_LIST);
  assert.deepEqual(p.recipientItems[0], { kind: 'email', label: 'p0@example.com' });
  assert.equal(p.recipientCount, MAX_LIST + 3);
  assert.equal(p.blocked, '');
  const kinds = cardParams({ ...card, destinations: dest(['#general', 'ann lee', 'the page open in the browser']) } as any, () => '');
  assert.deepEqual(
    kinds.recipientItems.map((r: any) => r.kind),
    ['channel', 'person', 'app'],
  );
});

test('a blocked card says why; a card with no list or no reasons says none', () => {
  for (const blocked of ['no-recipients', 'unreadable-recipients']) {
    const b = cardParams({ ...card, destinations: dest([]), reasons: [blocked], scopes: [], denyAlways: false } as any, () => '');
    assert.deepEqual([b.blocked, b.recipientCount, b.scopes], [blocked, 0, []]);
  }
  const odd = cardParams({ ...card, destinations: dest('x'), reasons: undefined } as any, () => '');
  assert.deepEqual([odd.recipientCount, odd.blocked], [0, '']);
});

test('an allow on a card that offered no scope is no answer; a deny is one', () => {
  const blocked = { ...card, scopes: [], denyAlways: false };
  assert.equal(answerOf({ decision: 'allow', scope: 'once' }, blocked as any), null);
  assert.deepEqual(answerOf({ decision: 'deny' }, blocked as any), { allow: false });
});

test('the phone card names every recipient and the count past the cut', () => {
  const base = { source: 'Mail', action: 'change', summary: 'Send', scopes: ['once'], hosts: [], unknown: false, denyAlways: true };
  const one = momoActionCard({ ...base, recipients: ['ann@example.com'], recipientCount: 1 });
  assert.equal(one.title, 'Allow MoMo to send to ann@example.com?');
  assert.match(one.detail, /\nTo: ann@example.com$/);
  // the list was cut at 20 of 23: the title and the line say how many in all
  const cut = momoActionCard({ ...base, recipients: ['a@x.com', 'b@x.com'], hosts: ['x.com'], recipientCount: 23 });
  assert.equal(cut.title, 'Allow MoMo to send to a@x.com and 23 more?');
  assert.match(cut.detail, /To \(24\): a@x.com, b@x.com, x.com and 21 more$/);
  // a count that is not a number counts the names it has
  assert.match(momoActionCard({ ...base, recipients: ['a@x.com', 'b@x.com'], recipientCount: 'x' }).detail, /To \(2\): a@x.com, b@x.com$/);
});

test('the phone card for a send that reaches people it cannot name has only Dismiss', () => {
  const base = { source: 'Mail', action: 'change', scopes: ['once'], hosts: [], recipients: [], recipientCount: 0, denyAlways: true };
  for (const [blocked, text] of [
    ['no-recipients', "This reaches people but names none, so MoMo can't allow it."],
    ['unreadable-recipients', "MoMo can't read who this reaches, so it can't allow it."],
  ]) {
    const c = momoActionCard({ ...base, blocked });
    assert.equal(c.title, "MoMo can't tell who this reaches");
    assert.equal(c.detail, text);
    assert.deepEqual(c.choices, [{ key: 'deny', label: 'Dismiss', deny: true }]);
  }
  // any other value of blocked is no block
  assert.equal(momoActionCard({ ...base, blocked: 'x' }).choices[0].key, 'once');
});
