// MoMo's learning core (shared/momoCore): reactions per pattern, a rule proposed after two that agree, an opposite reaction starting the count again, silence never counting, quiet rules on at once with Undo, other rules waiting for a tap, editable rules that keep their reactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type LearnState,
  type LearnedRule,
  type Reaction,
  REACTIONS_NEEDED,
  activeRules,
  confirmRule,
  currentRun,
  declineRule,
  editRule,
  emptyLearning,
  record,
  ruleTextOf,
  stanceOf,
  toGateRules,
  turnsOnAtOnce,
  undoRule,
} from '../shared/momoCore/learning.ts';
import { decide } from '../shared/momoCore/approvalGate.ts';

let n = 0;
let t = 1000;
const deps = () => ({ newId: () => `id${++n}`, now: () => (t += 10) });
const tap = (state: LearnState, kind: Reaction['kind'], over: Partial<Omit<Reaction, 'id' | 'at'>> = {}) =>
  record(state, { pattern: 'notice:acme', label: 'mail from Acme', kind, ...over }, deps());
const ruleOf = (c: ReturnType<typeof record>['change']) => (c as { rule: LearnedRule }).rule;

test('stances: what each tap asks for, and which rules turn on at once', () => {
  assert.deepEqual(
    (['not_needed', 'dismiss', 'snooze', 'keep', 'always_allow', 'deny'] as const).map((k) => stanceOf(k)),
    ['quieter', 'quieter', 'quieter', 'more', 'skip_question', 'ask_again'],
  );
  assert.equal(stanceOf('draft_edit', ' Shorter '), 'edit:shorter');
  assert.equal(stanceOf('draft_edit'), undefined);
  assert.equal(stanceOf('draft_edit', '  '), undefined);
  assert.deepEqual((['quieter', 'ask_again', 'more', 'skip_question', 'edit:x'] as const).map(turnsOnAtOnce), [
    true,
    true,
    false,
    false,
    false,
  ]);
  assert.equal(REACTIONS_NEEDED, 2);
});

test('one reaction only counts; the second that agrees proposes a rule, and a quieter rule is on at once', () => {
  const one = tap(emptyLearning(), 'not_needed');
  assert.deepEqual(one.change, { kind: 'none', why: 'counted' });
  const two = tap(one.state, 'dismiss');
  assert.equal(two.change.kind, 'activated');
  const rule = ruleOf(two.change);
  assert.equal(rule.status, 'on');
  assert.equal(ruleTextOf(rule), 'Stay quiet about mail from Acme.');
  assert.equal(rule.reactions.length, 2);
  assert.ok(rule.decidedAt);
  assert.deepEqual(
    activeRules(two.state).map((r) => r.id),
    [rule.id],
  );
  // a third reaction does not make a second rule
  assert.equal(tap(two.state, 'snooze').change.kind, 'none');
  assert.equal(tap(two.state, 'snooze').state.rules.length, 1);
});

test('an opposite reaction starts the count again, silence and unknown taps never count', () => {
  let s = tap(emptyLearning(), 'not_needed').state;
  s = tap(s, 'keep').state;
  assert.equal(currentRun(s, 'notice:acme')?.reactions.length, 1);
  const third = tap(s, 'not_needed');
  assert.equal(third.change.kind, 'none');
  assert.equal(third.state.rules.length, 0);
  assert.equal(tap(third.state, 'not_needed').change.kind, 'activated');
  const silent = record(emptyLearning(), { pattern: 'p', label: 'x', kind: 'ignored' as never }, deps());
  assert.deepEqual(silent, { state: emptyLearning(), change: { kind: 'none', why: 'unknown_reaction' }, retired: [] });
  assert.equal(record(emptyLearning(), { pattern: '', label: 'x', kind: 'dismiss' }, deps()).change.kind, 'none');
  assert.equal(record(emptyLearning(), { pattern: 'p', label: 'x', kind: 'draft_edit' }, deps()).change.kind, 'none');
  assert.equal(currentRun(emptyLearning(), 'nothing'), undefined);
});

test('a rule that does more or skips a question waits for a tap; confirm turns it on, decline restarts the count', () => {
  const action = { tool: 'gmail.send', effect: 'send' as const, scope: 'dana@example.com' };
  let s = tap(emptyLearning(), 'always_allow', { pattern: 'action:dana', label: 'sending to Dana', action }).state;
  const proposed = record(s, { pattern: 'action:dana', label: 'sending to Dana', kind: 'always_allow', action }, deps());
  assert.equal(proposed.change.kind, 'proposed');
  const rule = ruleOf(proposed.change);
  assert.equal(rule.status, 'proposed');
  assert.equal(ruleTextOf(rule), "Don't ask before sending to Dana.");
  assert.deepEqual(activeRules(proposed.state), []);
  assert.deepEqual(toGateRules(proposed.state), []);
  s = confirmRule(proposed.state, rule.id, t + 1);
  assert.deepEqual(
    activeRules(s).map((r) => r.status),
    ['on'],
  );
  assert.deepEqual(
    toGateRules(s).map((r) => [r.behavior, r.tool, r.effect, r.scope]),
    [['allow', 'gmail.send', 'send', 'dana@example.com']],
  );
  assert.equal(confirmRule(s, rule.id, 6000), s);
  // declined: the earlier taps no longer count
  const declined = declineRule(proposed.state, rule.id, t + 1);
  assert.equal(declined.rules[0].status, 'declined');
  assert.equal(currentRun(declined, 'action:dana'), undefined);
  const again = record(declined, { pattern: 'action:dana', label: 'sending to Dana', kind: 'always_allow', action }, deps());
  assert.equal(again.change.kind, 'none');
  assert.equal(
    record(again.state, { pattern: 'action:dana', label: 'sending to Dana', kind: 'always_allow', action }, deps()).change.kind,
    'proposed',
  );
  assert.equal(declineRule(declined, rule.id, 1), declined);
  assert.equal(declineRule(declined, 'nope', 1), declined);
});

test('a skip-a-question rule is only an allow rule: the gate still asks when the turn is tainted or unprompted', () => {
  const action = { tool: 'gmail.send', effect: 'send' as const, scope: 'dana@example.com' };
  let s = emptyLearning();
  for (let i = 0; i < 2; i++) s = record(s, { pattern: 'a', label: 'sending to Dana', kind: 'always_allow', action }, deps()).state;
  s = confirmRule(s, s.rules[0].id, 1);
  const rules = toGateRules(s);
  const base = { ...action, args: {}, origin: 'chat' as const, tainted: false, summary: 's' };
  assert.equal(decide(base, rules).verdict, 'allow');
  assert.equal(decide({ ...base, tainted: true }, rules).verdict, 'ask');
  assert.equal(decide({ ...base, origin: 'unprompted' }, rules).verdict, 'deny');
  // a skip rule with no action, and other stances, make no gate rule
  const edited = {
    ...s,
    rules: [
      { ...s.rules[0], action: undefined },
      { ...s.rules[0], stance: 'quieter' as const },
    ],
  };
  assert.deepEqual(toGateRules(edited), []);
});

test('an ask-again rule (after two denies) turns on at once; draft edits need the same lesson twice and then wait', () => {
  const asked = tap(tap(emptyLearning(), 'deny', { pattern: 'action:x', label: 'moving files' }).state, 'deny', {
    pattern: 'action:x',
    label: 'moving files',
  });
  assert.equal(asked.change.kind, 'activated');
  assert.equal(ruleTextOf(ruleOf(asked.change)), 'Always ask before moving files.');
  const draft = (s: LearnState, detail: string) =>
    record(s, { pattern: 'draft:tone', label: 'replies to Dana', kind: 'draft_edit', detail }, deps());
  let s = draft(emptyLearning(), 'shorter').state;
  s = draft(s, 'warmer').state;
  assert.equal(currentRun(s, 'draft:tone')?.reactions.length, 1);
  const made = draft(draft(s, 'warmer').state, 'warmer');
  assert.equal(made.change.kind, 'none');
  const first = draft(draft(emptyLearning(), 'Shorter').state, 'shorter');
  assert.equal(first.change.kind, 'proposed');
  assert.equal(ruleTextOf(ruleOf(first.change)), 'In drafts: shorter (replies to Dana).');
  assert.equal(ruleTextOf({ stance: 'edit:no exclamation marks', label: 'x' }), 'In drafts: no exclamation marks (x).');
  assert.equal(ruleTextOf({ stance: 'more', label: 'sales mail' }), 'Tell me more about sales mail.');
});

test('a reaction the other way retires the opposed rule at once and starts the count again; undo does the same', () => {
  let s = tap(tap(emptyLearning(), 'not_needed').state, 'not_needed').state;
  const back = tap(s, 'keep');
  assert.deepEqual(
    back.retired.map((r) => [r.id, r.status]),
    [[s.rules[0].id, 'retired']],
  );
  assert.deepEqual(activeRules(back.state), []);
  assert.equal(tap(back.state, 'keep').change.kind, 'proposed');
  assert.deepEqual(tap(s, 'not_needed').retired, []);
  s = tap(tap(emptyLearning(), 'not_needed').state, 'not_needed').state;
  s = undoRule(s, s.rules[0].id, t + 1);
  assert.equal(s.rules[0].status, 'retired');
  assert.deepEqual(activeRules(s), []);
  const afterUndo = tap(s, 'not_needed');
  assert.equal(afterUndo.change.kind, 'none');
  assert.equal(tap(afterUndo.state, 'not_needed').change.kind, 'activated');
  assert.equal(undoRule(s, s.rules[0].id, 1), s);
});

test('rules are editable plain language and keep the reactions that made them', () => {
  const made = tap(tap(emptyLearning(), 'not_needed').state, 'not_needed');
  const id = ruleOf(made.change).id;
  const edited = editRule(made.state, id, '  Stay quiet about Acme newsletters, but tell me about invoices.  ');
  assert.equal(ruleTextOf(edited.rules[0]), 'Stay quiet about Acme newsletters, but tell me about invoices.');
  assert.equal(edited.rules[0].editedText, 'Stay quiet about Acme newsletters, but tell me about invoices.');
  assert.equal(edited.rules[0].reactions.length, 2);
  assert.equal(editRule(edited, id, '   '), edited);
  assert.equal(editRule(edited, id, 'x'.repeat(301)), edited);
  assert.equal(ruleTextOf(editRule(edited, 'nope', 'ok').rules[0]), ruleTextOf(edited.rules[0]));
  const retired = undoRule(edited, id, 1);
  assert.equal(ruleTextOf(editRule(retired, id, 'again').rules[0]), ruleTextOf(retired.rules[0]));
});

test('turning one rule off leaves the other rules as they are', () => {
  let s = tap(tap(emptyLearning(), 'not_needed').state, 'not_needed').state;
  s = tap(tap(s, 'dismiss', { pattern: 'notice:other', label: 'other mail' }).state, 'dismiss', {
    pattern: 'notice:other',
    label: 'other mail',
  }).state;
  assert.equal(s.rules.length, 2);
  const off = undoRule(s, s.rules[0].id, t + 1);
  assert.deepEqual(
    off.rules.map((r) => r.status),
    ['retired', 'on'],
  );
});

test('editing one rule leaves the others as they are', () => {
  let s = tap(tap(emptyLearning(), 'not_needed').state, 'not_needed').state;
  s = tap(tap(s, 'dismiss', { pattern: 'notice:other', label: 'other mail' }).state, 'dismiss', {
    pattern: 'notice:other',
    label: 'other mail',
  }).state;
  const edited = editRule(s, s.rules[1].id, 'Quiet about other mail, except invoices.');
  assert.deepEqual(
    edited.rules.map((r) => r.editedText),
    [undefined, 'Quiet about other mail, except invoices.'],
  );
});
