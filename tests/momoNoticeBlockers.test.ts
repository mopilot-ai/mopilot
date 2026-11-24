// Wiring blockers of the MoMo notice core: a new ask re-nudges once, a duplicate-key answer is refused however it is spelled, a failed sender check is shown as "may not be from" before any push decision, merge candidates are the thread's own, and a brief cleans what callers supply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief } from '../shared/momoNotice/brief.ts';
import type { Change } from '../shared/momoNotice/changeDetect.ts';
import { applyLimits, isMaterialChange, noticeSettings, type LimitInput } from '../shared/momoNotice/limits.ts';
import { createMemoryNoticeStore, createMemoryVersionStore } from '../shared/momoNotice/memoryStore.ts';
import { runNoticePass, type PassDeps } from '../shared/momoNotice/pipeline.ts';
import { hasDuplicateKey, parseReading, ReadingError, type ReadItem } from '../shared/momoNotice/reading.ts';
import { fromAddress, isAutomated, senderName } from '../shared/momoNotice/senderCheck.ts';
import { askOf } from '../shared/momoNotice/signals.ts';
import type { MailMessage, Matter, ReaderModel } from '../shared/momoNotice/types.d.ts';

const NOON = '2026-11-24T12:00:00Z';
const settings = noticeSettings('UTC');

// ---- a new ask ----

test('askOf finds the first request or question, folded; none when the text asks nothing', () => {
  assert.equal(askOf('Thanks. Can you send the signed copy to legal?'), 'can you send the signed copy to legal');
  assert.equal(askOf('Please sign by Friday.'), 'please sign by friday');
  assert.equal(askOf('请尽快确认'), '请尽快确认');
  assert.equal(askOf('Noted, thanks. Still due Friday.'), undefined);
  assert.equal(askOf('?'), undefined);
  // a code in the question is not part of what is compared or stored
  assert.ok(!askOf('Can you use verification code 482913?')?.includes('482913'));
});

const limitInput = (over: Partial<LimitInput> = {}): LimitInput => ({
  answer: { verdict: 'tell_now', reason: 'A reason.', matterKey: 'k' },
  matterKey: 'k',
  title: 'Contract',
  source: { sourceId: 'gmail', id: 't1', version: 'v1' },
  ...over,
});
const at = (iso: string) => new Date(iso);

test('a different request in a later message re-nudges once; the same request or a third one does not', async () => {
  const store = createMemoryNoticeStore();
  assert.equal((await applyLimits(store, settings, at(NOON), limitInput({ ask: 'please sign by friday' }))).action, 'tell_now');
  assert.equal((await store.getMatter('k'))?.notifiedAsk, 'please sign by friday');
  // the same request again, and a message that asks nothing: still told
  assert.equal(
    (await applyLimits(store, settings, at('2026-11-24T13:00:00Z'), limitInput({ ask: 'please sign by friday' }))).action,
    'hold',
  );
  assert.equal((await applyLimits(store, settings, at('2026-11-24T13:10:00Z'), limitInput())).action, 'hold');
  // a new request: one more nudge
  assert.equal(
    (await applyLimits(store, settings, at('2026-11-24T14:00:00Z'), limitInput({ ask: 'can you send it to legal' }))).action,
    'tell_now',
  );
  const nudged = await store.getMatter('k');
  assert.deepEqual([nudged?.notifiedAsk, nudged?.askNudged], ['can you send it to legal', true]);
  // another one after that is not a nudge (the thread went back and forth)
  assert.equal(
    (await applyLimits(store, settings, at('2026-11-24T15:00:00Z'), limitInput({ ask: 'could you also copy finance' }))).action,
    'hold',
  );
});

test('isMaterialChange: a new ask, a deadline where none was told, but not an ask already made or already nudged', () => {
  const told: Matter = {
    matterKey: 'k',
    state: 'open',
    title: 't',
    summary: 's',
    sources: [],
    updatedAt: NOON,
    notifiedAt: NOON,
    notifiedAsk: 'old ask',
  };
  assert.equal(isMaterialChange(told, limitInput({ ask: 'new ask' })), true);
  assert.equal(isMaterialChange(told, limitInput({ ask: 'old ask' })), false);
  assert.equal(isMaterialChange({ ...told, askNudged: true }, limitInput({ ask: 'new ask' })), false);
  assert.equal(isMaterialChange(told, limitInput({ deadline: '2026-11-26' })), true);
  assert.equal(isMaterialChange({ ...told, notifiedDeadline: '2026-11-26' }, limitInput({ deadline: '2026-11-27' })), false);
});

// ---- a duplicate key ----

const body = '"reason":"r","matterKey":"gmail:k"';
test('a repeated key is refused however it is spelled, in the answer and by hasDuplicateKey', () => {
  for (const text of [
    `{"verdict":"quiet","verdict":"tell_now",${body}}`,
    `{"verdict":"quiet","verd\\u0069ct":"tell_now",${body}}`,
    `{ "verdict" : "quiet" , "verdict" : "tell_now" , ${body} }`,
    `{"verdict":"quiet",${body},"reason":"x"}`,
  ]) {
    assert.equal(hasDuplicateKey(text), true, text);
    assert.throws(
      () => parseReading(text),
      (e) => e instanceof ReadingError && e.reason === 'The answer repeated a key.',
    );
  }
  assert.equal(parseReading(`{"verdict":"quiet",${body}}`).verdict, 'quiet');
});

test('hasDuplicateKey reads keys only at the top level and skips every kind of value', () => {
  assert.equal(hasDuplicateKey('{"a":{"b":1,"b":2},"c":[{"d":1},"x,}"],"e":"y,}","f":true}'), false);
  assert.equal(hasDuplicateKey('{"a":1,"a":2}'), true);
  assert.equal(hasDuplicateKey('{"a":[1,2,{"x":"}"}],"b":null,"a":0}'), true);
  assert.equal(hasDuplicateKey('{"a":"q\\"uote,","b":1}'), false);
  // not an object, a bare value, or cut off: nothing repeated is found
  for (const text of ['[1,2]', '"a"', '', '{', '{"a":1', '{a:1}', '{"a":1 "b":2}', '{"a":1,}'])
    assert.equal(hasDuplicateKey(text), false, text);
});

// ---- the sender check before the push decision ----

const NOW = new Date('2026-11-24T12:00:00Z');
const mail = (threadId: string, over: Partial<MailMessage> = {}): MailMessage => ({
  id: `m-${threadId}`,
  threadId,
  from: 'Ana <ana@acme.com>',
  to: ['me@x.com'],
  cc: [],
  subject: `S ${threadId}`,
  date: '2026-11-24T09:00:00Z',
  headers: {},
  labels: [],
  body: 'Body',
  ...over,
});
const authOf = (domain: string, dmarc: string) => ({
  'Authentication-Results': `mx.google.com; dkim=pass header.i=@${domain}; dmarc=${dmarc} (p=NONE) header.from=${domain}`,
});
const asItem = (m: MailMessage): ReadItem => ({ kind: 'mail', mail: m });
const mailChange = (threadId: string, version = 'v1'): Change => ({ kind: 'mail', threadId, version });
const answer = (verdict: string, matterKey: string) => JSON.stringify({ verdict, reason: 'It needs you right now.', matterKey });

function rig(model: ReaderModel, items: Record<string, ReadItem>, known = ['acme.com']) {
  let ids = 0;
  const store = createMemoryNoticeStore();
  const deps: PassDeps = {
    store,
    versions: createMemoryVersionStore(),
    model,
    person: { name: 'Maya', email: 'me@x.com' },
    clock: { now: () => NOW },
    settings,
    history: { knownDomains: async () => known },
    randomId: () => `rid-${(ids += 1)}-padding`,
    lastRunAt: new Date(NOW.getTime() - 60_000),
    load: async (change) => items[change.kind === 'mail' ? change.threadId : change.eventId] ?? null,
  };
  return { deps, store };
}
const fooled = (matterKey = 'gmail:k'): ReaderModel => ({ name: 'fooled', complete: async () => answer('tell_now', matterKey) });

test('a phishing alert a fooled model calls tell-now is shown as "may not be from", with no reply and no link', async () => {
  const phish = (id: string, from: string, headers: Record<string, string>) =>
    asItem(
      mail(id, {
        from,
        headers,
        subject: 'Your account will be closed in 24 hours',
        body: 'Verify your password now or lose access: http://northgate-secure-login.test/verify',
      }),
    );
  const { deps, store } = rig(fooled(), {
    f01: phish('f01', 'Northgate Bank <alerts@northgate-secure-login.test>', authOf('northgate-secure-login.test', 'fail')),
    f02: phish('f02', 'Clay Supply <orders@claysupp1y.test>', authOf('claysupp1y.test', 'pass')),
    f03: phish('f03', 'Jon Weiss <jon.weiss@gmail.test>', {}),
  });
  const { decisions } = await runNoticePass(deps, [mailChange('f01'), mailChange('f02'), mailChange('f03')]);
  assert.deepEqual(
    decisions.map((d) => [d.decision, d.outcome, d.offerReply, d.suspect?.name, d.reason]),
    [
      ['tell_now', 'tell_now', false, 'Northgate Bank', 'This may not be from Northgate Bank.'],
      ['tell_now', 'tell_now', false, 'Clay Supply', 'This may not be from Clay Supply.'],
      ['tell_now', 'tell_now', false, 'Jon Weiss', 'This may not be from Jon Weiss.'],
    ],
  );
  const matter = await store.getMatter('gmail:f01');
  assert.deepEqual(
    [matter?.title, matter?.summary, matter?.suspect],
    ['This may not be from Northgate Bank.', 'This may not be from Northgate Bank.', true],
  );
  assert.ok(!JSON.stringify([decisions, await store.listMatters()]).includes('http'));
  // the brief carries the flag
  const brief = buildBrief({
    now: NOW,
    settings,
    name: 'Maya',
    matters: await store.listMatters(),
    events: [],
    unsorted: [],
    couldNotCheck: [],
    checked: { mail: 3, byRules: 0, byModel: 3 },
  });
  assert.deepEqual(
    brief.needsYou.map((m) => m.suspect),
    [true, true, true],
  );
});

test('a genuine alert from a known sender that passes the check is told as an alert with a reply allowed', async () => {
  const { deps } = rig(fooled(), {
    ok: asItem(mail('ok', { subject: 'Payment failed', body: 'Update billing.', headers: authOf('acme.com', 'pass') })),
  });
  const { decisions } = await runNoticePass(deps, [mailChange('ok')]);
  assert.deepEqual([decisions[0].offerReply, decisions[0].suspect, decisions[0].reason], [true, undefined, 'It needs you right now.']);
});

test('senderName: the display name, else the domain, else a fixed word; no links or codes', () => {
  assert.equal(senderName('"Northgate Bank" <a@b.test>'), 'Northgate Bank');
  assert.equal(senderName('Ana <ana@acme.com>'), 'Ana');
  assert.equal(senderName('ana@acme.com'), 'acme.com');
  assert.equal(senderName('<>'), 'the sender');
  // a display name that is only control characters cleans to nothing
  assert.equal(senderName('\u0007 <a@b.test>'), 'the sender');
  assert.ok(!senderName('"Pay at https://evil.test/x" <a@b.test>').includes('https'));
});

// ---- merge candidates are the thread's own ----

test('a fooled model cannot fold a new alert into a told matter of the same sender domain', async () => {
  const { deps, store } = rig(fooled('gmail:t1'), {
    t1: asItem(mail('t1', { subject: 'Invoice 1' })),
    t2: asItem(mail('t2', { subject: 'Invoice 2: pay now', headers: authOf('acme.com', 'pass') })),
  });
  await runNoticePass(deps, [mailChange('t1')]);
  const { decisions } = await runNoticePass(deps, [mailChange('t2')]);
  assert.deepEqual([decisions[0].matterKey, decisions[0].outcome], ['gmail:t2', 'tell_now']);
  assert.equal((await store.getMatter('gmail:t1'))?.sources.length, 1);
});

// ---- the brief cleans what callers supply ----

test('the brief cleans an unsorted item the caller supplied, and the matters it shows', () => {
  const brief = buildBrief({
    now: NOW,
    settings,
    name: null,
    matters: [
      {
        matterKey: 'm',
        state: 'open',
        title: 'Code is verification code 482913',
        summary: 'See https://x.test/reset?token=abc',
        sources: [],
        updatedAt: NOON,
      },
    ],
    events: [],
    unsorted: [{ key: 'gmail:u', title: 'Reset: https://x.test/reset?token=abc\u0007 and\nmore', error: 'login code 123456 failed' }],
    couldNotCheck: [],
    checked: { mail: 1, byRules: 0, byModel: 0 },
  });
  const text = JSON.stringify(brief);
  assert.ok(!/482913|123456|token=abc|\\u0007|\\n/.test(text), text);
  assert.equal(brief.couldNotSort[0].key, 'gmail:u');
  assert.equal(brief.needsYou[0].suspect, false);
});

// ---- review follow-ups: every tell-now and watched mail is judged; a suspect mail leaves a matter alone; the brief cleans what it stores; boilerplate is no ask ----

const fail = (domain: string) => authOf(domain, 'fail');

test('a phish that is not about money is judged too, on tell-now and on track', async () => {
  const parcel = (id: string, headers: Record<string, string>) =>
    asItem(
      mail(id, {
        from: 'Royal Post <post@parcel-help.test>',
        subject: 'Your parcel is held',
        body: 'Confirm your address at the link.',
        headers,
      }),
    );
  const { deps, store } = rig(fooled(), {
    p1: parcel('p1', fail('parcel-help.test')),
    p2: parcel('p2', authOf('parcel-help.test', 'pass')),
    p3: parcel('p3', {}),
  });
  const { decisions } = await runNoticePass(deps, [mailChange('p1'), mailChange('p2'), mailChange('p3')]);
  // a failed check or an imitation is flagged; a passing or unverifiable sender of mail that names no money or credentials is not
  assert.deepEqual(
    decisions.map((d) => [d.suspect?.name, d.offerReply, d.reason]),
    [
      ['Royal Post', false, 'This may not be from Royal Post.'],
      [undefined, true, 'It needs you right now.'],
      [undefined, true, 'It needs you right now.'],
    ],
  );
  const watching = rig(
    { name: 'watcher', complete: async () => answer('track', 'gmail:x') },
    { p1: parcel('p1', fail('parcel-help.test')) },
  );
  const tracked = await runNoticePass(watching.deps, [mailChange('p1')]);
  assert.deepEqual([tracked.decisions[0].suspect?.name, tracked.decisions[0].outcome], ['Royal Post', 'watch']);
  assert.equal((await watching.store.getMatter('gmail:p1'))?.title, 'This may not be from Royal Post.');
  void store;
});

test('a suspect mail in a thread that already has a matter changes neither its title nor its summary and does not flag it; a later genuine mail is not flagged', async () => {
  const items = {
    t: asItem(mail('t', { subject: 'Contract 7001', headers: authOf('acme.com', 'pass') })),
  };
  const { deps, store } = rig(fooled('gmail:t'), items);
  await runNoticePass(deps, [mailChange('t')]);
  const first = await store.getMatter('gmail:t');
  items.t = asItem(mail('t', { subject: 'Re: Contract 7001', from: 'Ana <ana@acme-secure.test>', headers: fail('acme-secure.test') }));
  const { decisions } = await runNoticePass(deps, [mailChange('t', 'v2')]);
  assert.equal(decisions[0].suspect?.name, 'Ana');
  const after = await store.getMatter('gmail:t');
  assert.deepEqual([after?.title, after?.summary, after?.suspect], [first?.title, first?.summary, undefined]);
  // a new matter started by a suspect mail is flagged, and the next genuine update of it clears the flag
  const flagged = rig(fooled(), { u: asItem(mail('u', { from: 'Ana <ana@acme-secure.test>', headers: fail('acme-secure.test') })) });
  await runNoticePass(flagged.deps, [mailChange('u')]);
  assert.equal((await flagged.store.getMatter('gmail:u'))?.suspect, true);
  const ok = { u: asItem(mail('u', { headers: authOf('acme.com', 'pass') })) };
  const again = { ...flagged.deps, load: async () => ok.u };
  await runNoticePass(again, [mailChange('u', 'v2')]);
  assert.equal((await flagged.store.getMatter('gmail:u'))?.suspect, undefined);
});

test('the stored brief is cleaned, not only its text: the name, today, the place and what could not be checked', () => {
  const brief = buildBrief({
    now: NOW,
    settings,
    name: 'Maya https://x.test/reset?token=abc',
    matters: [],
    events: [
      {
        id: 'e',
        status: 'confirmed',
        summary: 'Call, code is verification code 482913',
        location: 'See https://x.test/reset?token=abc\u0007',
        start: { dateTime: '2026-11-24T14:00:00Z' },
        end: { dateTime: '2026-11-24T15:00:00Z' },
      },
    ],
    unsorted: [],
    couldNotCheck: [{ source: 'Gmail\u0007', why: 'login code 123456 failed\nagain' }],
    checked: { mail: 0, byRules: 0, byModel: 0 },
  });
  const text = JSON.stringify(brief);
  assert.ok(!/482913|123456|token=abc|\\u0007|\\n/.test(text), text);
  assert.equal(brief.today.length, 1);
});

test('askOf ignores boilerplate, and an automated sender asks nothing', async () => {
  assert.equal(askOf('Please do not reply to this message. Can you send the copy?'), 'can you send the copy');
  assert.equal(askOf('This is an automated message. Unsubscribe here, please.'), undefined);
  const mailAs = (from: string, headers: Record<string, string> = {}, id = 'x') =>
    mail(id, { from, headers: { ...authOf('acme.com', 'pass'), ...headers }, body: 'Can you confirm today?' });
  for (const [from, headers] of [
    ['noreply@acme.com', {}],
    ['Billing <billing@acme.com>', {}],
    ['Ana <ana@acme.com>', { 'Auto-Submitted': 'auto-generated' }],
    ['Ana <ana@acme.com>', { 'List-Unsubscribe': '<mailto:x@y.test>' }],
  ] as const) {
    assert.equal(isAutomated(mailAs(from, headers)), true, from);
  }
  assert.equal(isAutomated(mailAs('Ana <ana@acme.com>', { 'Auto-Submitted': 'no' })), false);
  assert.equal(isAutomated(mailAs('Ana <ana@acme.com>')), false);
  assert.equal(isAutomated(mailAs('<>')), false);
  const { deps, store } = rig(fooled(), {
    a: asItem(mailAs('noreply@acme.com', {}, 'a')),
    h: asItem(mailAs('Ana <ana@acme.com>', {}, 'h')),
  });
  await runNoticePass(deps, [mailChange('a'), mailChange('h')]);
  assert.deepEqual(
    [(await store.getMatter('gmail:a'))?.notifiedAsk, (await store.getMatter('gmail:h'))?.notifiedAsk],
    [undefined, 'can you confirm today'],
  );
});

test('fromAddress: the one address of a From header, lower case; none or several is none', () => {
  assert.equal(fromAddress('Ana <Ana@Acme.com>'), 'ana@acme.com');
  assert.equal(fromAddress('ana@acme.com'), 'ana@acme.com');
  assert.equal(fromAddress('nobody at all'), null);
  assert.equal(fromAddress('a@x.com, b@y.com'), null);
});
