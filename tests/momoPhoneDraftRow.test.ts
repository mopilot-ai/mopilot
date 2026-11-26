// A reply MoMo drafted, as a row of the home's chat: the phone's own draft card, the body as plain text, a cut-short mark, nothing drawn for a draft that fails the shared check; and "Not needed" carrying the decision a row was drawn from.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mount, find, tap, unmountAll, type Any } from './support/phone/momo-screens';

afterEach(unmountAll);

const row = (extra: Any = {}) => ({
  kind: 'draft',
  id: 'd1',
  at: 1,
  draft: { to: ['dana@acme.test'], subject: 'Re: renewal', body: 'Friday works. <b>Quote</b> attached: https://x.test' },
  matter: { key: 'm1', title: 'Acme renewal' },
  untrusted: true,
  truncated: false,
  ...extra,
});

test('a draft row is the phone’s draft card with its words as plain text', async () => {
  const m = await mount((v) => v.chat.push(row()));
  const text = m.text();
  assert.match(text, /Re: renewal/);
  assert.match(text, /dana@acme\.test/);
  // markup and links in the body are only characters
  assert.match(text, /Friday works\. <b>Quote<\/b> attached: https:\/\/x\.test/);
  assert.doesNotMatch(text, /Cut short\./);
  assert.ok(find('Copy'));
});

test('the shared contract fixture draft row is drawn', async () => {
  const { FIXTURE_DRAFT_ROW } = await import('../shared/momoRowsFixture.ts');
  const m = await mount((v) => v.chat.push(FIXTURE_DRAFT_ROW));
  assert.match(m.text(), new RegExp((FIXTURE_DRAFT_ROW as Any).draft.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a draft cut to its size limit says so', async () => {
  const m = await mount((v) => v.chat.push(row({ truncated: true })));
  assert.match(m.text(), /Cut short\./);
});

test('a draft that fails the shared check is not drawn, and the rest of the chat is', async () => {
  const m = await mount((v) => v.chat.push(row({ draft: { to: 'x', subject: 1, body: '' } }), row({ id: 'd2', draft: null })));
  assert.doesNotMatch(m.text(), /Re: renewal/);
  assert.match(m.text(), /MoMo/);
});

test('Not needed carries the decision the row was drawn from, and none when the row has none', async () => {
  const withDecision = {
    kind: 'assistant',
    id: 'a1',
    at: 1,
    text: 'Dana replied.',
    whyTold: 'Client reply',
    decision: { id: 'a1', decisionId: 'dec-7', outcome: 'tell_now', reason: 'r', kind: null, rule: null, checks: [], matter: null },
    notNeeded: { suggestion: null },
  };
  const m = await mount((v) => v.chat.splice(0, v.chat.length, withDecision));
  await tap('Not needed');
  assert.deepEqual(m.sent.at(-1), { kind: 'notice-not-needed', noticeId: 'a1', decisionId: 'dec-7' });
  await unmountAll();
  const w = await mount((v) => v.chat.splice(0, v.chat.length, { ...withDecision, decision: null }));
  await tap('Not needed');
  assert.deepEqual(w.sent.at(-1), { kind: 'notice-not-needed', noticeId: 'a1' });
});

const brief = (extra: Any = {}) => ({
  kind: 'brief',
  id: 'b1',
  at: 1,
  brief: {
    day: '2026-11-23',
    greeting: 'Good morning',
    attention: null,
    offers: [],
    overnight: { read: 4, notesUpdated: 0, rulesLearned: 0 },
    leftOut: [],
    ...extra,
  },
});

test('mail a rule kept quiet is listed in the brief, with Undo rule only where the rule is known', async () => {
  const m = await mount((v) =>
    v.chat.splice(
      0,
      v.chat.length,
      brief({
        keptQuiet: [
          { id: 'q1', title: 'Newsletter from Acme', ruleId: 'r7', label: 'Kept quiet by your rule for newsletters' },
          { id: 'q2', title: 'Receipt', ruleId: null, label: 'Kept quiet by your rule for receipts' },
        ],
      }),
    ),
  );
  const text = m.text();
  assert.match(text, /Kept quiet/);
  assert.match(text, /Newsletter from Acme/);
  assert.match(text, /Kept quiet by your rule for receipts/);
  assert.equal(document.querySelectorAll('[aria-label="Undo rule"]').length, 1);
  await tap('Undo rule');
  assert.deepEqual(m.sent.at(-1), { kind: 'rule-undo', ruleId: 'r7' });
});

test('a brief without the kept-quiet field draws no group', async () => {
  const m = await mount((v) => v.chat.splice(0, v.chat.length, brief()));
  assert.match(m.text(), /Good morning/);
  assert.doesNotMatch(m.text(), /Kept quiet|Undo rule/);
});
