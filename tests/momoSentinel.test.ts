// MoMo's sentinel (#2139, electron/momo/sentinel.cjs) with a scripted askUser and a fake clock: access levels, scopes and their expiry, the exact-action fingerprint, deny always, taint across turns and the allow list, uncertain outcomes, revocation and the sweep, answers that are no answer, and state changing while a card is up. Storage: tests/momoSentinelStore.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Sentinel, LEVELS, SCOPES, MAX_REMEMBER, fingerprintOf, destinationsOf } = require('../electron/momo/sentinel.cjs');

const DAY = 24 * 60 * 60 * 1000;
const send = {
  chatId: 'momo-main',
  tool: 'mail_send',
  source: 'mail',
  kind: 'change',
  account: 'work',
  args: { to: 'ann@example.com', body: 'hi' },
  egress: { recipients: ['ann@example.com'] },
  summary: 'Email Ann',
};
const readMail = { chatId: 'momo-main', tool: 'mail_search', source: 'mail', kind: 'read', args: { q: 'invoice' } };

/** A sentinel whose askUser answers from `answers` in turn (a function answers from the card), with a clock the test moves. */
function rig(o: { answers?: any[]; storage?: any; allowed?: () => boolean; sources?: any; now?: number; running?: boolean } = {}) {
  let clock = o.now ?? new Date(2026, 9, 23, 10, 0, 0).getTime();
  let n = 0;
  const cards: any[] = [];
  const answers = [...(o.answers ?? [])];
  const s = new Sentinel({
    askUser: async (card: any, opts: any) => {
      cards.push(card);
      const a = answers.shift();
      return typeof a === 'function' ? a(card, opts) : a;
    },
    allowed: o.allowed ?? (() => true),
    sources: o.sources ?? {
      mail: { level: LEVELS.ASK, private: true },
      web: { level: LEVELS.ASK },
      notes: { level: LEVELS.READ, private: true },
      bank: { level: LEVELS.BLOCKED },
    },
    allowList: { hosts: ['search.example.com.'], recipients: [' Me@Example.com '] },
    storage: o.storage ?? null,
    now: () => clock,
    newId: () => `g${++n}`,
  });
  // an allowed side effect is uncertain until its outcome is noted: here it went through, unless the test keeps it running
  const decide = s.decide.bind(s);
  if (!o.running)
    s.decide = async (call: any, opts?: any) => {
      const d = await decide(call, opts);
      if (d.allow) s.noteOutcome(call.chatId, d.fingerprint, 'done');
      return d;
    };
  return { s, decide, cards, answers, tick: (ms: number) => (clock += ms), at: () => clock };
}

test('nothing is allowed while MoMo is not, and a call that cannot be checked is refused', async () => {
  const off = new Sentinel({ askUser: async () => ({ allow: true, scope: 'once' }) });
  assert.deepEqual(await off.decide(send), { allow: false, reason: 'not-allowed', fingerprint: null }, 'allowed defaults to no');
  const { s, cards } = rig();
  for (const bad of [
    null,
    { ...send, chatId: '' },
    { ...send, tool: 'x'.repeat(201) },
    { ...send, kind: 'delete' },
    { ...send, source: 3 },
    { ...send, args: { n: Number.NaN } },
  ])
    assert.equal((await s.decide(bad)).reason, 'invalid', JSON.stringify(bad));
  assert.equal(cards.length, 0);
  assert.throws(() => new Sentinel({} as any), /needs askUser/);
  assert.throws(() => s.setSource('', { level: 'ask' }), /id and a level/);
  assert.throws(() => s.setSource('x', { level: 'sometimes' } as any), /id and a level/);
});

test('access levels: blocked refuses everything, read only refuses changes, an unknown source is blocked, reads never ask', async () => {
  const { s, cards } = rig();
  assert.equal((await s.decide({ ...readMail, source: 'bank' })).reason, 'blocked');
  assert.equal((await s.decide({ ...readMail, source: 'nowhere' })).reason, 'blocked');
  assert.equal((await s.decide({ ...send, source: 'notes' })).reason, 'read-only');
  const r = await s.decide({ ...readMail, source: 'notes' });
  assert.deepEqual([r.allow, r.via], [true, 'read']);
  assert.equal((await s.decide(readMail)).via, 'read');
  assert.equal(cards.length, 0, 'no card for any of these');
});

test('a change always asks unless remembered: once remembers nothing, and the card offers every scope and deny always', async () => {
  const { s, cards } = rig({
    answers: [
      { allow: true, scope: 'once' },
      { allow: true, scope: 'once' },
    ],
  });
  const d = await s.decide(send);
  assert.deepEqual(d, { allow: true, via: 'asked', scope: 'once', fingerprint: fingerprintOf(send) });
  assert.deepEqual(cards[0], {
    chatId: 'momo-main',
    tool: 'mail_send',
    source: 'mail',
    account: 'work',
    kind: 'change',
    summary: 'Email Ann',
    destinations: { hosts: [], recipients: ['ann@example.com'], unknown: false },
    reasons: [],
    scopes: ['once', 'chat', 'today', '30d'],
    denyAlways: true,
  });
  await s.decide(send);
  assert.equal(cards.length, 2, 'once is once');
  assert.deepEqual(s.list(), []);
  // a call with no account or summary shows them empty
  const { s: s2, cards: c2 } = rig({ answers: [null] });
  await s2.decide({ ...send, account: undefined, summary: undefined });
  assert.deepEqual([c2[0].account, c2[0].summary], ['', '']);
});

test('this chat covers only its chat; clearing the chat ends it', async () => {
  const { s, cards } = rig({ answers: [{ allow: true, scope: 'chat' }, null] });
  const d = await s.decide(send);
  assert.deepEqual([d.via, d.scope, d.grantId, d.persisted], ['asked', 'chat', 'g1', false]);
  assert.deepEqual(await s.decide(send), {
    allow: true,
    via: 'remembered',
    scope: 'chat',
    grantId: 'g1',
    fingerprint: fingerprintOf(send),
  });
  assert.equal((await s.decide({ ...send, chatId: 'momo-other' })).reason, 'no-answer', 'another chat asks');
  assert.equal(cards.length, 2);
  s.clearChat('momo-main');
  assert.deepEqual(s.list(), []);
  s.clearChat('never-seen');
});

test('today ends at local midnight and 30 days after 30 days; the sweep removes what expired', async () => {
  const { s, tick, at } = rig({
    answers: [
      { allow: true, scope: 'today' },
      { allow: true, scope: '30d' },
    ],
  });
  await s.decide(send);
  const other = { ...send, args: { to: 'ann@example.com', body: 'later' } };
  await s.decide(other);
  const today = s.list().find((g: any) => g.scope === 'today');
  const later = s.list().find((g: any) => g.scope === '30d');
  assert.equal(today.expiresAt, new Date(2026, 9, 24, 0, 0, 0).getTime());
  assert.equal(later.expiresAt, at() + MAX_REMEMBER);
  tick(today.expiresAt - at() - 1);
  assert.equal((await s.decide(send)).via, 'remembered', 'one ms before midnight');
  tick(1);
  assert.equal((await s.decide(send)).reason, 'no-answer', 'at midnight it asks again');
  assert.equal(s.sweep(), 1);
  assert.equal(s.sweep(), 0);
  tick(30 * DAY);
  assert.equal(s.list().length, 0, 'the 30 days are over');
  assert.equal(s.sweep(), 1);
});

test('the fingerprint is the exact action: argument order and Unicode form do not matter; any other argument, account, tool or destination is a new decision', async () => {
  const { s, cards } = rig({ answers: [{ allow: true, scope: '30d' }] });
  await s.decide(send);
  const reordered = { ...send, args: { body: 'hi', to: 'ann@example.com', cc: undefined } };
  assert.equal((await s.decide(reordered)).via, 'remembered');
  const cafe = (form: string) => ({ ...send, args: { to: 'ann@example.com', body: 'café'.normalize(form) } });
  assert.equal(fingerprintOf(cafe('NFC')), fingerprintOf(cafe('NFD')));
  for (const changed of [
    { ...send, args: { to: 'ann@example.com', body: 'hi!' } },
    { ...send, args: { to: 'eve@example.com', body: 'hi' } },
    { ...send, account: 'personal' },
    { ...send, tool: 'mail_reply' },
    { ...send, egress: { recipients: ['eve@example.com'] } },
  ])
    assert.equal((await s.decide(changed)).reason, 'no-answer', JSON.stringify(changed));
  assert.equal(cards.length, 6);
});

test('deny always refuses the exact action in every chat without a card, until revoked; a plain deny asks next time', async () => {
  const { s, cards } = rig({ answers: [{ allow: false }, { allow: false, always: true }, { allow: true, scope: 'once' }] });
  assert.equal((await s.decide(send)).reason, 'denied');
  assert.equal((await s.decide(send)).reason, 'denied');
  assert.equal(cards.length, 2);
  for (const chatId of ['momo-main', 'momo-other']) assert.equal((await s.decide({ ...send, chatId })).reason, 'deny-always');
  assert.equal(cards.length, 2);
  const [deny] = s.list();
  assert.deepEqual([deny.effect, deny.scope, deny.expiresAt], ['deny', 'always', undefined]);
  assert.equal(s.revoke(deny.id), true);
  assert.equal(s.revoke(deny.id), false);
  assert.equal((await s.decide(send)).allow, true);
});

test('after a chat read a private source, sending off the allow list asks every turn, remembered or not, and offers only once', async () => {
  const { s, cards, answers } = rig({ answers: [{ allow: true, scope: '30d' }] });
  await s.decide(send);
  assert.equal((await s.decide(send)).via, 'remembered', 'not tainted yet');
  // turn 1: a read of a public source taints nothing
  await s.decide({ ...readMail, source: 'web' });
  assert.deepEqual(s.taintOf('momo-main'), []);
  // turn 2: the chat reads mail
  await s.decide(readMail);
  assert.deepEqual(s.taintOf('momo-main'), ['mail']);
  // turns 3 and 4: the remembered send asks each time
  answers.push({ allow: true, scope: '30d' }, { allow: true, scope: 'once' });
  assert.equal((await s.decide(send)).reason, 'no-answer', 'a 30-day answer is not offered here');
  assert.deepEqual([cards.at(-1).reasons, cards.at(-1).scopes], [['egress'], ['once']]);
  assert.equal((await s.decide(send)).scope, 'once');
  assert.equal(cards.length, 3);
  // the allow list (case and trailing dot ignored) still goes through on the remembered approval
  const toMe = { ...send, args: { to: 'me@example.com' }, egress: { recipients: ['ME@example.com'] } };
  const search = { ...send, tool: 'web_post', source: 'web', egress: { hosts: ['Search.Example.com'] } };
  answers.push({ allow: true, scope: '30d' }, { allow: true, scope: '30d' });
  const { s: clean } = rig();
  void clean;
  s.clearChat('momo-other');
  // remember both while another chat is clean, then use them in the tainted chat
  assert.equal((await s.decide({ ...toMe, chatId: 'momo-other' })).scope, '30d');
  assert.equal((await s.decide({ ...search, chatId: 'momo-other' })).scope, '30d');
  assert.equal((await s.decide(toMe)).via, 'remembered');
  assert.equal((await s.decide(search)).via, 'remembered');
  // another chat is not tainted by this one
  assert.equal((await s.decide({ ...send, chatId: 'momo-other' })).via, 'remembered');
  // an unknown destination, or one whose shape can't be read, asks
  for (const egress of [{ unknown: true }, { hosts: 'evil.example' }, 'evil', { recipients: [3] }]) {
    answers.push(null);
    assert.equal((await s.decide({ ...toMe, egress })).reason, 'no-answer', JSON.stringify(egress));
    assert.equal(cards.at(-1).destinations.unknown, true);
  }
  // a read that sends somewhere off the list asks too, once only and with no deny always
  answers.push({ allow: true, scope: 'once' });
  const fetch = { ...readMail, tool: 'web_fetch', source: 'web', egress: { hosts: ['evil.example'] } };
  assert.equal((await s.decide(fetch)).via, 'asked');
  assert.deepEqual([cards.at(-1).scopes, cards.at(-1).denyAlways], [['once'], false]);
  // clearing the chat drops its taint
  s.clearChat('momo-main');
  assert.equal((await s.decide(fetch)).via, 'read');
});

test('after an uncertain outcome the same action asks again, even when remembered, until the user says yes', async () => {
  const { s, cards, answers } = rig({ answers: [{ allow: true, scope: '30d' }] });
  const d = await s.decide(send);
  s.noteOutcome('momo-main', d.fingerprint, 'uncertain');
  answers.push(null);
  assert.equal((await s.decide(send)).reason, 'no-answer');
  assert.deepEqual([cards.at(-1).reasons, cards.at(-1).scopes], [['uncertain'], ['once']]);
  assert.equal((await s.decide({ ...send, chatId: 'momo-other' })).via, 'remembered', 'only in the chat where it was uncertain');
  answers.push({ allow: true, scope: 'once' });
  assert.equal((await s.decide(send)).via, 'asked');
  assert.equal((await s.decide(send)).via, 'remembered', 'the user said yes: the mark is gone');
  // a later run that went through doesn't settle an earlier uncertain one: only the user's yes does
  s.noteOutcome('momo-main', d.fingerprint, 'uncertain');
  s.noteOutcome('momo-main', d.fingerprint, 'done');
  answers.push(null);
  assert.equal((await s.decide(send)).reason, 'no-answer');
  s.noteOutcome('momo-main', 'other', 'not sent');
});

test('revoke all forgets every approval and refusal; a newer answer for the same scope replaces the older', async () => {
  const { s } = rig({
    answers: [
      { allow: true, scope: '30d' },
      { allow: false, always: true },
      { allow: true, scope: '30d' },
    ],
  });
  await s.decide(send);
  await s.decide({ ...send, args: { to: 'x@example.com' } });
  assert.equal(s.list().length, 2);
  assert.equal(s.revokeAll(), 2);
  assert.equal(s.revokeAll(), 0);
  await s.decide(send);
  assert.equal(s.list().length, 1);
});

test('a newer answer replaces only the same action, effect, scope and chat', async () => {
  const { s, tick, at } = rig({
    answers: [
      { allow: true, scope: '30d' },
      { allow: true, scope: 'today' },
      { allow: true, scope: 'today' },
      { allow: true, scope: 'chat' },
      { allow: true, scope: 'chat' },
      { allow: false, always: true },
    ],
  });
  const untilMidnight = () => new Date(new Date(at()).setHours(24, 0, 0, 0)).getTime() - at();
  const other = { ...send, account: undefined, args: { to: 'x@example.com' } };
  await s.decide(other);
  await s.decide(send);
  tick(untilMidnight());
  // yesterday's today answer, expired but not swept, is replaced by the new one
  assert.equal((await s.decide(send)).grantId, 'g3');
  const ids = () =>
    s
      .list()
      .map((g: any) => g.id)
      .sort();
  assert.deepEqual(ids(), ['g1', 'g3']);
  assert.equal(s.list().find((g: any) => g.id === 'g1').account, '', 'no account is kept as empty');
  tick(untilMidnight());
  await s.decide(send);
  await s.decide({ ...send, chatId: 'momo-other' });
  assert.deepEqual(ids(), ['g1', 'g4', 'g5'], 'another scope and another chat are kept');
  await s.decide({ ...send, chatId: 'momo-third' });
  assert.deepEqual(ids(), ['g1', 'g4', 'g5', 'g6'], 'a refusal does not replace an approval');
  assert.equal((await s.decide(send)).reason, 'deny-always');
});

test('a card that went away, an answer that is not one, or a failing askUser never allows and never remembers', async () => {
  const { s, cards } = rig({
    answers: [
      null,
      undefined,
      {},
      { allow: 'yes' },
      { allow: true },
      { allow: true, scope: 'forever' },
      () => Promise.reject(new Error('window closed')),
    ],
  });
  for (let i = 0; i < 7; i++)
    assert.deepEqual(await s.decide(send), { allow: false, reason: 'no-answer', fingerprint: fingerprintOf(send) });
  assert.equal(cards.length, 7);
  assert.deepEqual(s.list(), []);
});

test('what changes while a card is up decides: a stopped call, a cleared chat, a blocked source, new taint', async () => {
  const ctl = new AbortController();
  const { s, answers } = rig({
    answers: [
      (_c: any, o: any) => {
        assert.equal(o.signal, ctl.signal, 'the call signal reaches askUser');
        ctl.abort();
        return { allow: true, scope: '30d' };
      },
    ],
  });
  assert.equal((await s.decide(send, { signal: ctl.signal })).reason, 'no-answer');
  answers.push(() => (s.clearChat('momo-main'), { allow: true, scope: 'chat' }));
  assert.equal((await s.decide(send)).reason, 'no-answer');
  answers.push(() => (s.setSource('mail', { level: 'blocked' }), { allow: true, scope: '30d' }));
  assert.equal((await s.decide(send)).reason, 'blocked');
  s.setSource('mail', { level: 'ask', private: true });
  answers.push(() => (s.setSource('mail', { level: 'read', private: true }), { allow: true, scope: '30d' }));
  assert.equal((await s.decide(send)).reason, 'read-only');
  s.setSource('mail', { level: 'ask', private: true });
  // the chat reads mail while the card for a 30-day send is up: this send goes, nothing is remembered
  answers.push(async () => (await s.decide(readMail), { allow: true, scope: '30d' }));
  assert.deepEqual(await s.decide(send), { allow: true, via: 'asked', scope: 'once', fingerprint: fingerprintOf(send) });
  assert.deepEqual(s.list(), []);
  // a read asked for because it sends somewhere taints the chat when allowed
  const { s: r, answers: ra } = rig();
  await r.decide(readMail);
  ra.push({ allow: true, scope: 'once' });
  await r.decide({ ...readMail, chatId: 'momo-main', egress: { hosts: ['evil.example'] } });
  assert.deepEqual(r.taintOf('momo-main'), ['mail']);
});

test('destinations are read as lower-cased lists, and a missing egress sends nothing', () => {
  assert.deepEqual(destinationsOf(undefined), { hosts: [], recipients: [], unknown: false });
  assert.deepEqual(destinationsOf({ hosts: [' A.Example.COM. '] }), { hosts: ['a.example.com'], recipients: [], unknown: false });
  assert.deepEqual(destinationsOf(null), { hosts: [], recipients: [], unknown: true });
  assert.deepEqual(destinationsOf({ unknown: true, recipients: ['X@y'] }), { hosts: [], recipients: ['x@y'], unknown: true });
  assert.equal(SCOPES.DAYS30, '30d');
});

test('a remembered approval of a call with no arguments or summary gets a random id and empty text; a list with a non-string is an unknown destination', async () => {
  const s = new Sentinel({
    askUser: async () => ({ allow: true, scope: '30d' }),
    allowed: () => true,
    sources: { mail: { level: 'ask' } },
  });
  const d = await s.decide({ chatId: 'momo-main', tool: 'mail_archive', source: 'mail', kind: 'change' });
  assert.match(d.grantId, /^[0-9a-f-]{36}$/);
  assert.equal(s.list()[0].summary, '');
  assert.deepEqual(destinationsOf({ hosts: ['ok.example', 3] }), { hosts: [], recipients: [], unknown: true });
});

test('a clock set back before an approval was made does not stretch it; a refusal stays', async () => {
  const { s, tick } = rig({
    answers: [
      { allow: true, scope: '30d' },
      { allow: false, always: true },
    ],
  });
  await s.decide(send);
  const other = { ...send, args: { to: 'eve@example.com' } };
  await s.decide(other);
  tick(-60_000);
  assert.equal((await s.decide(send)).reason, 'no-answer', 'the 30-day yes no longer counts');
  assert.equal((await s.decide(other)).reason, 'deny-always');
});

test('MoMo turned off for the account while a card is up: nothing runs', async () => {
  let allowed = true;
  const { s } = rig({ allowed: () => allowed, answers: [() => ((allowed = false), { allow: true, scope: '30d' })] });
  assert.deepEqual(await s.decide(send), { allow: false, reason: 'not-allowed', fingerprint: fingerprintOf(send) });
  assert.deepEqual(s.list(), []);
});

test('a destination that cannot be told asks every time, once only, read or change, remembered or not', async () => {
  const { s, cards, answers } = rig({ answers: [{ allow: true, scope: '30d' }] });
  const unknownSend = { ...send, egress: { unknown: true } };
  assert.equal((await s.decide(unknownSend)).reason, 'no-answer', 'the 30-day answer is not offered');
  assert.deepEqual([cards[0].reasons, cards[0].scopes, cards[0].denyAlways], [['unknown-destination'], ['once'], true]);
  for (const egress of [
    { hosts: 'evil.example' },
    'evil',
    { recipients: [3] },
    { hosts: ['http://'] },
    { hosts: ['.'] },
    { hosts: ['file:///etc/passwd'] },
    { recipients: ['  '] },
  ]) {
    answers.push({ allow: true, scope: 'once' });
    assert.equal((await s.decide({ ...readMail, egress })).via, 'asked', JSON.stringify(egress));
    assert.deepEqual([cards.at(-1).destinations.unknown, cards.at(-1).denyAlways], [true, false]);
  }
  // deny always on a card that does not offer it is a plain deny
  answers.push({ allow: false, always: true });
  assert.equal((await s.decide({ ...readMail, egress: { unknown: true } })).reason, 'denied');
  assert.deepEqual(s.list(), []);
  // a read with a known destination just runs, and so would a read-only source's read after the card
  assert.equal((await s.decide({ ...readMail, chatId: 'momo-clean', egress: { hosts: ['example.com'] } })).via, 'read');
  answers.push(() => (s.setSource('mail', { level: 'read' }), { allow: true, scope: 'once' }));
  assert.equal((await s.decide({ ...readMail, egress: { unknown: true } })).via, 'asked');
});

test('hosts are compared by name: scheme, port, path, case, a trailing dot and the Unicode form do not matter; lists are sorted without repeats', () => {
  assert.deepEqual(
    destinationsOf({
      hosts: ['https://Mail.Example.com:443/inbox?x=1', 'mail.example.com.', 'bücher.example'],
      recipients: ['B@x.org', 'a@x.org', ' b@X.org '],
    }),
    {
      hosts: ['mail.example.com', 'xn--bcher-kva.example'],
      recipients: ['a@x.org', 'b@x.org'],
      unknown: false,
    },
  );
  assert.equal(
    fingerprintOf({ ...send, egress: { recipients: ['b@x.org', 'a@x.org'] } }),
    fingerprintOf({ ...send, egress: { recipients: ['A@x.org', 'b@x.org', 'b@x.org'] } }),
  );
});
