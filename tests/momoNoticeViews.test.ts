// What the notice records look like to the apps (shared/momoNotice/views.ts): the "why you saw this" of each kind of decision, the Watching row, the brief card and its text, with every line cleaned and "Left out" taken from the decision log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Brief } from '../shared/momoNotice/brief.ts';
import { briefView, decisionView, renderBrief, watchingTask, type StoredDecision } from '../shared/momoNotice/views.ts';
import type { Matter } from '../shared/momoNotice/types.d.ts';

const decision = (over: Partial<StoredDecision> = {}): StoredDecision => ({
  changeId: 'gmail:t1',
  decision: 'tell_now',
  reason: 'A contract waits for your signature.',
  matterKey: 'gmail:t1',
  decidedBy: 'model:fake',
  at: '2026-11-24T10:00:00.000Z',
  outcome: 'tell_now',
  offerReply: true,
  injection: [],
  private: false,
  title: 'Contract',
  first: true,
  ...over,
});

test('a model decision says it was read with no tools; a rule decision names the rule', () => {
  const view = decisionView(decision());
  assert.deepEqual(
    [view.id, view.outcome, view.kind, view.rule, view.matter, view.at],
    ['gmail:t1', 'tell_now', null, null, { key: 'gmail:t1', title: 'Contract', first: true }, Date.parse('2026-11-24T10:00:00.000Z')],
  );
  assert.deepEqual(view.checks, ['Read by the model with no tools.']);
  const rule = decisionView(decision({ decision: 'quiet', decidedBy: 'rule:bulk', reason: 'Bulk mail.', outcome: 'quiet' }));
  assert.deepEqual(
    [rule.outcome, rule.rule, rule.checks],
    ['quiet', { id: 'bulk', text: 'Bulk mail.' }, ['Decided by a plain rule, no model.']],
  );
});

test('every check the code made is a plain sentence: sender, hold, injection, secret', () => {
  const sender = decisionView(decision({ sender: { status: 'pass', reason: 'DMARC passed for the sender domain.' } }));
  assert.equal(sender.checks[0], 'Sender check: DMARC passed for the sender domain.');
  const suspect = decisionView(decision({ suspect: { name: 'Northgate Bank' }, sender: { status: 'fail', reason: 'x' } }));
  assert.equal(suspect.checks[0], 'Sender check failed: this may not be from Northgate Bank.');
  for (const [why, text] of [
    ['quiet_hours', 'Held for the brief: quiet hours.'],
    ['daily_cap', 'Held for the brief: the daily limit was reached.'],
    ['snoozed', 'Held for the brief: snoozed.'],
    ['already_told', 'Not told again: you already heard about this.'],
    ['dismissed', 'Not told: you dismissed this.'],
    ['first_connect', 'Held for the brief: it was already in your inbox when MoMo connected.'],
    ['something_new', 'Held for the brief.'],
  ])
    assert.ok(decisionView(decision({ heldFor: why })).checks.includes(text), why);
  const many = decisionView(decision({ injection: ['ignore previous'], private: true }));
  assert.deepEqual(many.checks.slice(0, 2), [
    'The mail told the assistant what to do; that was ignored.',
    'Holds a sign-in code or reset link, kept private.',
  ]);
});

test('the outcome follows the decision: track is watch, unsorted stays unsorted; the reason is cut to 20 words and cleaned', () => {
  assert.equal(decisionView(decision({ decision: 'track' })).outcome, 'watch');
  assert.equal(decisionView(decision({ decision: 'unsorted', outcome: 'unsorted' })).outcome, 'unsorted');
  const long = decisionView(decision({ reason: `${'word '.repeat(30)}see https://x.test/reset?token=abc` }));
  assert.equal(long.reason.split(' ').length, 20);
  assert.ok(long.reason.endsWith('…'));
  assert.ok(!long.reason.includes('token'));
});

const matter = (over: Partial<Matter> = {}): Matter => ({
  matterKey: 'gmail:t1',
  state: 'watching',
  title: 'Contract',
  summary: 'Waiting on legal.',
  sources: [],
  updatedAt: '2026-11-24T09:00:00.000Z',
  ...over,
});
const home = { machineId: 'm1', name: 'Studio' };

test('a Watching row says why, when it is checked next, and whether and when you were told', () => {
  const plain = watchingTask(matter({ nextCheck: '2026-11-25T09:00:00.000Z' }), null, home);
  assert.deepEqual(
    [plain.id, plain.state, plain.origin, plain.where, plain.nextCheck, plain.step, plain.watch],
    [
      'watch:gmail:t1',
      'watching',
      'matter',
      { machine: home, agent: 'MoMo' },
      Date.parse('2026-11-25T09:00:00.000Z'),
      'Waiting on legal.',
      { why: 'Waiting on legal.', nextCheck: Date.parse('2026-11-25T09:00:00.000Z'), told: false, toldAt: null, decision: null },
    ],
  );
  const told = watchingTask(matter({ notifiedAt: '2026-11-24T10:00:00.000Z' }), decision({ decision: 'track' }), home);
  assert.deepEqual(
    [told.nextCheck, told.watch?.told, told.watch?.toldAt, told.watch?.decision?.outcome],
    [null, true, Date.parse('2026-11-24T10:00:00.000Z'), 'watch'],
  );
});

const brief = (over: Partial<Brief> = {}): Brief => ({
  dayKey: '2026-11-24',
  at: '2026-11-24T08:00:00.000Z',
  name: 'Maya',
  needsYou: [],
  watching: [],
  today: [],
  couldNotSort: [],
  couldNotCheck: [],
  checked: { mail: 12, byRules: 8, byModel: 4 },
  ...over,
});
const needs = (key: string, title: string, summary: string, suspect = false) => ({
  matterKey: key,
  title,
  summary,
  pending: false,
  suspect,
});

test('the brief card: a greeting, the one thing that needs you with its source, the overnight count and what was left out', () => {
  const quiet = briefView(brief({ name: null }), []);
  assert.deepEqual(
    [quiet.greeting, quiet.attention, quiet.offers, quiet.overnight],
    ['Good morning.', null, [], { read: 12, notesUpdated: 0, rulesLearned: 0 }],
  );
  const view = briefView(brief({ needsYou: [needs('gmail:t1', 'Contract', 'Sign it.'), needs('calendar:e1', 'Dentist', 'Today.')] }), [
    decision({ changeId: 'gmail:n1', reason: 'Bulk mail: a newsletter.' }),
  ]);
  assert.deepEqual(
    [view.day, view.greeting, view.attention, view.leftOut],
    [
      '2026-11-24',
      'Good morning, Maya.',
      { text: 'Contract: Sign it.', source: 'Gmail' },
      [{ id: 'gmail:n1', reason: 'Bulk mail: a newsletter.' }],
    ],
  );
  assert.equal(briefView(brief({ needsYou: [needs('calendar:e1', 'Dentist', 'Today.')] }), []).attention?.source, 'Calendar');
  assert.equal(briefView(brief({ needsYou: [needs('other:1', 'X', 'y')] }), []).attention?.source, 'MoMo');
  // a suspect matter never reads as a genuine alert: only its title, which is the warning
  assert.equal(
    briefView(brief({ needsYou: [needs('gmail:s', 'This may not be from Bank.', 'This may not be from Bank.', true)] }), []).attention
      ?.text,
    'This may not be from Bank.',
  );
});

test('the brief text is the same record in words: needs you, watching, today on the home clock, could not sort, could not check', () => {
  const text = renderBrief(
    brief({
      needsYou: [needs('gmail:t1', 'Contract', 'Sign it.'), needs('gmail:s', 'This may not be from Bank.', 's', true)],
      watching: [{ ...needs('gmail:w', 'Visa', 'Waiting.'), nextCheck: '2026-11-25T09:00:00.000Z' }],
      today: [
        { id: 'e1', summary: 'Standup', start: '2026-11-24T14:30:00Z', end: '2026-11-24T15:00:00Z' },
        { id: 'e2', summary: 'Birthday', start: '2026-11-24', end: '2026-11-25' },
      ],
      couldNotSort: [{ key: 'gmail:u', title: 'Odd mail', error: 'The answer was not JSON.' }],
      couldNotCheck: [{ source: 'Gmail', why: 'Google could not be reached.' }],
    }),
    'America/New_York',
  );
  assert.equal(
    text,
    [
      'Good morning, Maya.',
      '',
      'Needs you:',
      '- Contract: Sign it.',
      '- This may not be from Bank. Check the sender before you act on it.',
      '',
      'Watching:',
      '- Visa',
      '',
      'Today:',
      '- 09:30 Standup',
      '- All day Birthday',
      '',
      'Could not sort:',
      '- Odd mail: The answer was not JSON.',
      '',
      'Could not check Gmail: Google could not be reached.',
    ].join('\n'),
  );
  assert.equal(renderBrief(brief({ name: null }), 'UTC'), 'Good morning.');
});
