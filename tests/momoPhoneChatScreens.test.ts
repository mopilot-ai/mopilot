// MoMo's phone chat rows: the approval card in every state, delivery of sent messages, why-you-saw-this, the brief and the catch-up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mount, find, tap, typeInto, kinds, ref, type Any } from './support/phone/momo-screens';

const approval = (v: Any) => v.chat.find((r: Any) => r.kind === 'approval').approval;
const withApproval = (extra: object) => (v: Any) => Object.assign(approval(v), extra);

test('the approval card: Send, Edit the text then Send, and Don’t send each answer once', async () => {
  const m = await mount();
  assert.match(m.text(), /1 person outside your company\./);
  assert.match(m.text(), /Dana Lee <dana@acme\.com>/);
  assert.match(m.text(), /Acme-quote\.xlsx/);
  await tap('Send');
  assert.deepEqual(m.sent, [{ kind: 'approval', cardId: 'c1', answer: 'send' }]);
  const d = await mount();
  await tap("Don't send");
  assert.deepEqual(d.sent, [{ kind: 'approval', cardId: 'c1', answer: 'deny' }]);
  const e = await mount();
  await tap('Edit');
  await typeInto('Email text', 'Hi Dana, it holds.');
  await tap('Send');
  assert.deepEqual(e.sent, [{ kind: 'approval', cardId: 'c1', answer: 'edit', body: 'Hi Dana, it holds.' }]);
  const c = await mount();
  await tap('Edit');
  await tap('Cancel');
  assert.match(c.text(), /the \$48k price holds/);
});

test('an approval card in every other state says what happened and offers only what it can', async () => {
  const states: [object, RegExp, string[]][] = [
    [{ expiresAt: 1, canAskAgain: true }, /Nobody answered in 30 minutes\. Nothing was sent\./, ['Ask again']],
    [{ status: 'approved' }, /Sending…/, []],
    [{ status: 'completed' }, /Sent to Dana Lee\./, []],
    [{ status: 'denied', canAskAgain: true }, /Not sent\./, ['Ask again']],
    [
      { status: 'failed', failure: { cause: 'Gmail refused it.', fix: { id: 'fx', label: 'Reconnect Gmail' } } },
      /Gmail refused it\./,
      ['Reconnect Gmail'],
    ],
    [{ status: 'uncertain', canAskAgain: true }, /It may have been sent/, ['Ask again']],
    [
      { answeredElsewhere: { device: 'iPhone', at: new Date(2026, 10, 24, 14, 31).getTime(), outcome: 'approved' } },
      /Answered on your iPhone at 2:31 PM/,
      [],
    ],
    [
      {
        action: 'other',
        title: 'Delete 3 files?',
        recipients: [],
        subject: null,
        attachments: [],
        fields: [{ label: 'Where', value: 'Downloads' }],
      },
      /Downloads/,
      ['Send'],
    ],
  ];
  for (const [extra, pattern, buttons] of states) {
    const m = await mount(withApproval(extra));
    assert.match(m.text(), pattern);
    for (const b of buttons) assert.ok(find(b), b);
  }
  const m = await mount(withApproval({ expiresAt: 1, canAskAgain: true }));
  await tap('Ask again');
  await tap('Dismiss');
  assert.deepEqual(
    m.sent.map((i) => i.answer),
    ['ask-again', 'deny'],
  );
});

const rows = (v: Any, ...extra: Any[]) => v.chat.splice(0, v.chat.length, ...extra);

test('every delivery state of a sent message reads as the design says, and the fixes send or check', async () => {
  const user = (id: string, delivery: string) => ({ kind: 'user', id, at: 1, text: `msg ${id}`, delivery });
  const m = await mount((v) =>
    rows(v, user('a', 'queued'), user('b', 'never-got-it'), user('c', 'not-sure'), user('d', 'failed'), user('e', 'completed'), {
      kind: 'waiting',
      id: 'w',
      at: 2,
      machine: ref('studio', 'Studio'),
    }),
  );
  assert.match(m.text(), /Waiting for Studio/);
  assert.match(m.text(), /Studio never got it/);
  assert.match(m.text(), /Not sent\. Send now\?/);
  assert.match(m.text(), /Not sure/);
  assert.match(m.text(), /MoMo never sends the same message twice on its own\./);
  assert.match(m.text(), /MoMo couldn't do it/);
  await tap('Send now');
  await tap('Check again');
  assert.deepEqual(m.sent, [
    { kind: 'send', turnId: 'b', text: 'msg b' },
    { kind: 'check-turn', turnId: 'c' },
  ]);
  const last = await mount((v) => rows(v, user('z', 'accepted')));
  assert.match(last.text(), /Studio has it/);
  assert.match(last.text(), /Working on it now/);
});

test('MoMo’s rows: why you saw this, Not needed then the rule line with Undo, the brief and the catch-up', async () => {
  const assistant = {
    kind: 'assistant',
    id: 'a',
    at: 1,
    text: 'Your package arrives tomorrow.',
    source: null,
    whyTold: 'Dana asked about the price.',
    notNeeded: { suggestion: null },
  };
  const plain = { kind: 'assistant', id: 'p', at: 1, text: 'Plain.', source: null, whyTold: null, notNeeded: null };
  const brief = {
    kind: 'brief',
    id: 'b',
    at: 2,
    brief: {
      day: '2026-11-24',
      greeting: 'Morning. One thing needs you.',
      attention: { text: "Dana's quote is due Friday.", source: 'Gmail' },
      offers: [{ id: 'o1', title: 'Draft the quote reply', why: 'Due Friday' }],
      overnight: { read: 38, notesUpdated: 4, rulesLearned: 1 },
      leftOut: [],
    },
  };
  const catchUp = {
    kind: 'catch-up',
    id: 'c',
    at: 3,
    catchUp: { machine: ref('studio', 'Studio'), from: 1, to: 2, read: 14, needsYou: [{ id: 'x', text: 'Dana reply' }] },
  };
  const m = await mount((v) => rows(v, assistant, plain, brief, catchUp));
  assert.match(m.text(), /Morning\. One thing needs you\./);
  assert.match(m.text(), /Overnight on Studio: 38 messages read/);
  assert.match(m.text(), /1 needs you: Dana reply/);
  await tap('Start');
  await tap('Hide');
  await tap('Not needed');
  assert.match(m.text(), /Second time\. I will stay quiet about deliveries\./);
  await tap('Undo');
  assert.match(m.text(), /Undone\. I will keep telling you about deliveries\./);
  await tap('See rules');
  assert.match(m.text(), /Delivery notices/);
  assert.deepEqual(kinds(m), ['offer', 'offer', 'notice-not-needed', 'rule-undo']);
  const w = await mount((v) => rows(v, assistant));
  await tap('Why you saw this');
  assert.match(w.text(), /Dana asked about the price\./);
  await tap('Not needed');
  assert.deepEqual(w.sent, [{ kind: 'notice-not-needed', noticeId: 'a' }]);
  // a notice drawn from a decision says which one, so the home learns from the right row
  const d = await mount((v) => rows(v, { ...assistant, decision: { decisionId: 'dec-9' } } as any));
  await tap('Why you saw this');
  await tap('Not needed');
  assert.deepEqual(d.sent, [{ kind: 'notice-not-needed', noticeId: 'a', decisionId: 'dec-9' }]);
  const s = await mount((v) =>
    rows(v, { ...assistant, notNeeded: { suggestion: { ruleId: 'r1', text: 'Second time. I will stay quiet about deliveries.' } } }),
  );
  await tap('See rule');
  assert.match(s.text(), /Delivery notices/);
});

test('Why you saw this shows the decision: how it was sorted, the rule with Edit rule, what was checked and the matter', async () => {
  const m = await mount();
  await tap('Why you saw this');
  assert.match(m.text(), /Dana Lee replied on .Acme renewal. and asked about the price\./);
  assert.match(m.text(), /Told you now\s+Client replies/);
  assert.match(m.text(), /Rule\s+Client replies → tell me right away/);
  assert.match(m.text(), /Checked/);
  assert.match(m.text(), /Sender matches Acme · passes the sender check/);
  assert.match(m.text(), /Matter\s+Acme renewal · first time/);
  await tap('Edit rule');
  assert.match(m.text(), /Delivery notices/, 'Edit rule opens the rules');
  const later = await mount((v) => {
    Object.assign(v.chat[0].decision, {
      outcome: 'quiet',
      rule: null,
      checks: [],
      matter: { key: 'k', title: 'Acme renewal', first: false },
    });
  });
  await tap('Why you saw this');
  assert.match(later.text(), /Kept quiet\s+Client replies/);
  assert.match(later.text(), /Matter\s+Acme renewal(?! · first)/);
  assert.equal(find('Edit rule'), undefined, 'no rule matched: nothing to edit');
  assert.doesNotMatch(later.text(), /Checked/);
  const watch = await mount((v) => Object.assign(v.chat[0].decision, { outcome: 'watch', kind: null, reason: '' }));
  await tap('Why you saw this');
  assert.match(
    watch.text(),
    /Dana Lee replied on .Acme renewal. and asked about the price\./,
    'with no reason of its own the notice keeps its own',
  );
  assert.doesNotMatch(watch.text(), /Watching/, 'a line with no value is not shown');
  const plain = await mount((v) => (delete v.chat[0].decision, undefined));
  await tap('Why you saw this');
  assert.doesNotMatch(plain.text(), /Rule/, 'a notice with no decision record shows the reason alone');
  const only = await mount((v) => Object.assign(v.chat[0], { whyTold: null }));
  await tap('Why you saw this');
  assert.match(only.text(), /Told you now/);
});
