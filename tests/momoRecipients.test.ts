// Who a MoMo change reaches (electron/momo/recipients.cjs, #4649 A4): recipients read from a change's arguments, which tools can reach people, and the block on a change that reaches people but names none (or none that can be read), through the real sentinel and connector gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recipientsOf, blockOf, kindOf, MAX_RECIPIENTS } = require('../electron/momo/recipients.cjs');
const { Sentinel } = require('../electron/momo/sentinel.cjs');
const { connectorDecide } = require('../electron/momo/sourceTrust.cjs');
const { refusalText } = require('../electron/momo/trustTexts.cjs');

test('recipientsOf: a read reaches nobody; a change names its recipients from to, cc, bcc, attendees and channels', () => {
  assert.deepEqual(recipientsOf('send_mail', { to: 'a@x.com' }, 'read'), { reaches: false, recipients: [], unreadable: false });
  assert.deepEqual(recipientsOf('send_mail', { to: 'B@x.com, a@x.com; c@x.com', cc: ['a@x.com'], Bcc: 'd@x.com', body: 'hi' }, 'change'), {
    reaches: true,
    recipients: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'],
    unreadable: false,
  });
  // a tool that is no send still reaches the people its arguments name
  assert.deepEqual(recipientsOf('create_event', { title: 't', attendees: [{ email: 'a@x.com' }, { name: 'Bo' }, 'c@x.com'] }, 'change'), {
    reaches: true,
    recipients: ['a@x.com', 'bo', 'c@x.com'],
    unreadable: false,
  });
  // an object names itself under any of its usual keys, in any case
  assert.deepEqual(
    recipientsOf('create_event', { attendees: [{ EmailAddress: 'a@x.com' }, { display_name: 'Cy' }] }, 'change').recipients,
    ['a@x.com', 'cy'],
  );
  assert.deepEqual(recipientsOf('postToChannel', { channel_id: '#general', userIds: [42] }, 'change').recipients, ['#general', '42']);
});

test('recipientsOf: a change with no recipient fields reaches people only when it is a send; empty fields name nobody', () => {
  assert.deepEqual(recipientsOf('update_note', { text: 'x' }, 'change'), { reaches: false, recipients: [], unreadable: false });
  assert.deepEqual(recipientsOf('update_note', undefined, 'change').reaches, false);
  assert.deepEqual(recipientsOf('update_note', ['to'], 'change').reaches, false);
  assert.deepEqual(recipientsOf('send_message', { text: 'x' }, 'change'), { reaches: true, recipients: [], unreadable: false });
  assert.deepEqual(recipientsOf('update_note', { to: '', cc: null, bcc: ' , ', attendees: [] }, 'change'), {
    reaches: false,
    recipients: [],
    unreadable: false,
  });
  for (const tool of ['sendMail', 'reply_all', 'share-file', 'invite', 'dm_user'])
    assert.equal(recipientsOf(tool, {}, 'change').reaches, true, tool);
});

test('recipientsOf: a recipient value that cannot be read, or too many, is unreadable and still reaches people', () => {
  const bad: unknown[] = [true, NaN, 'x'.repeat(201), { foo: 'a@x.com' }, { email: '' }, [[['a@x.com']]], [true], [{}]];
  for (const v of bad) {
    const r = recipientsOf('update_note', { to: v }, 'change');
    assert.deepEqual([r.reaches, r.unreadable], [true, true], JSON.stringify(v));
  }
  // what could be read is kept beside what could not
  assert.deepEqual(recipientsOf('update_note', { to: 'a@x.com', cc: true }, 'change'), {
    reaches: true,
    recipients: ['a@x.com'],
    unreadable: true,
  });
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@x.com`);
  assert.deepEqual(recipientsOf('send_mail', { to: many }, 'change'), { reaches: true, recipients: [], unreadable: true });
  assert.equal(recipientsOf('send_mail', { to: many.slice(1) }, 'change').recipients.length, MAX_RECIPIENTS);
});

test('blockOf: only a change that reaches people can be blocked, for no recipient or one it cannot read', () => {
  const some = { recipients: ['a@x.com'], unknown: false };
  assert.equal(blockOf({ kind: 'change', reaches: true }, some), '');
  assert.equal(blockOf({ kind: 'change', reaches: true }, { recipients: [], unknown: false }), 'no-recipients');
  assert.equal(blockOf({ kind: 'change', reaches: true }, { recipients: ['a@x.com'], unknown: true }), 'unreadable-recipients');
  assert.equal(blockOf({ kind: 'change' }, { recipients: [], unknown: false }), '');
  assert.equal(blockOf({ kind: 'read', reaches: true }, { recipients: [], unknown: true }), '');
});

test('kindOf: an app or page, an address, a channel, a person', () => {
  assert.equal(kindOf('the page open in the browser'), 'app');
  assert.equal(kindOf('the app in front on this mac'), 'app');
  assert.equal(kindOf('ann@example.com'), 'email');
  assert.equal(kindOf('#general'), 'channel');
  assert.equal(kindOf('@ann'), 'channel');
  assert.equal(kindOf('ann lee'), 'person');
  assert.equal(kindOf('a b@c'), 'person');
});

test('the texts for a block say nothing was sent and what to do', () => {
  assert.match(refusalText('no-recipients', { source: 'Mail', kind: 'change' }), /names none, so nothing was sent/);
  assert.match(refusalText('unreadable-recipients', { source: 'Mail', kind: 'change' }), /couldn't be read, so nothing was sent/);
});

/** A sentinel whose cards are answered by `answer`, with the cards it showed. */
function rig(answer: (card: any) => any) {
  const cards: any[] = [];
  const sentinel = new Sentinel({
    askUser: async (card: any) => (cards.push(card), answer(card)),
    allowed: () => true,
    sources: {},
  });
  const decide = connectorDecide(sentinel);
  const call = { kind: 'change', connector: 'mail', label: 'Mail', tool: 'send_mail', chatId: 'mc', summary: 'Send', args: {} };
  return { cards, decide, call };
}

test('a send that names its recipients asks with all of them, and its allow runs', async () => {
  const r = rig(() => ({ allow: true, scope: 'once' }));
  const d = await r.decide({ ...r.call, args: { to: 'b@x.com', cc: ['a@x.com'] } });
  assert.deepEqual(d, { allow: true });
  assert.deepEqual(r.cards[0].destinations, { hosts: [], recipients: ['a@x.com', 'b@x.com'], unknown: false });
  assert.deepEqual(r.cards[0].scopes, ['once', 'chat', 'today', '30d']);
});

test('a send that reaches people and names none is blocked: the card has no allow, and any answer refuses', async () => {
  for (const [args, why, unknown] of [
    [{ body: 'hi' }, 'no-recipients', false],
    [{ to: { nope: 1 } }, 'unreadable-recipients', true],
  ] as const) {
    // even a forged allow answer is refused
    for (const answer of [{ allow: false }, { allow: true, scope: 'once' }]) {
      const r = rig(() => answer);
      const d = await r.decide({ ...r.call, args });
      assert.equal(d.allow, false);
      assert.equal(r.cards.length, 1);
      const c = r.cards[0];
      assert.deepEqual([c.scopes, c.denyAlways, c.reasons[0], c.destinations.unknown], [[], false, why, unknown]);
    }
  }
});

test('a blocked send says why it refused, and a card that went away is no answer', async () => {
  const seen: any[] = [];
  const sentinel = new Sentinel({ askUser: async () => ({ allow: false }), allowed: () => true, sources: { s: { level: 'ask' } } });
  seen.push(await sentinel.decide({ chatId: 'mc', tool: 't', source: 's', kind: 'change', reaches: true }));
  seen.push(await sentinel.decide({ chatId: 'mc', tool: 't', source: 's', kind: 'change', reaches: true, egress: { unknown: true } }));
  assert.deepEqual(
    seen.map((d) => [d.allow, d.reason]),
    [
      [false, 'no-recipients'],
      [false, 'unreadable-recipients'],
    ],
  );
  const gone = new Sentinel({ askUser: async () => null, allowed: () => true, sources: { s: { level: 'ask' } } });
  const d = await gone.decide({ chatId: 'mc', tool: 't', source: 's', kind: 'change', reaches: true });
  assert.deepEqual([d.allow, d.reason], [false, 'no-answer']);
});

test('a remembered allow never lets a send with no recipient through', async () => {
  const r = rig((card) => (card.scopes.length ? { allow: true, scope: '30d' } : { allow: false }));
  assert.deepEqual(await r.decide({ ...r.call, args: { to: 'a@x.com' } }), { allow: true });
  // the same tool with nobody named is a different action, and is blocked
  const d = await r.decide({ ...r.call, args: {} });
  assert.equal(d.allow, false);
  assert.equal(r.cards.length, 2);
  assert.deepEqual(r.cards[1].scopes, []);
});

test('a read that names an address stays a read', async () => {
  const r = rig(() => ({ allow: false }));
  const d = await r.decide({ ...r.call, kind: 'read', tool: 'search_mail', args: { to: 'a@x.com' } });
  assert.deepEqual(d, { allow: true });
  assert.equal(r.cards.length, 0);
});
