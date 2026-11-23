// How Codex turns read in the thread (src/harness/codexTranslate.ts): plan cards, inline reviews,
// compactions, background terminals and sub-agents. Shapes follow conformance X3, X4, X5 and X10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentItems, turnCard, compactionLabel, backgroundTerminals, spawnedThreads } from '../src/harness/codexTranslate.ts';

const user = { type: 'userMessage', id: 'u', content: [] };
const msg = (id: string, text: string) => ({ type: 'agentMessage', id, text });

test('an inline review shows its result once: the repeated message is dropped', () => {
  const review = '[P1] a+b became a-b';
  const items = [
    { type: 'enteredReviewMode', id: 'e', review: 'current changes' },
    user,
    { type: 'commandExecution', id: 'c' },
    msg('m1', 'Looking at the diff'),
    { type: 'exitedReviewMode', id: 'x', review },
    msg('m2', `${review}\n`),
  ];
  const shown = presentItems(items);
  assert.deepEqual(
    shown.map((i) => i.id),
    ['e', 'u', 'c', 'm1', 'x'],
  );
  assert.deepEqual(turnCard(shown, false, false), { kind: 'review', item: items[4] });
  // without a review nothing is dropped
  assert.equal(presentItems([user, msg('m', 'hi')]).length, 2);
});

test('a plan-mode turn ends with its plan item, or with its last message when the model wrote none', () => {
  const plan = { type: 'plan', id: 'p', text: '1. Read\n2. Write' };
  assert.deepEqual(turnCard([user, plan, msg('m', 'Done planning')], true, false), { kind: 'plan', item: plan });
  // a luna-style plan: only messages
  const card = turnCard([user, msg('m1', 'Let me look'), msg('m2', '## Plan\n1. Do it')], true, false);
  assert.equal(card?.kind, 'plan');
  assert.equal(card?.item.id, 'm2');
  assert.equal(card?.item.text, '## Plan\n1. Do it');
  // not while it runs, and not outside plan mode
  assert.equal(turnCard([user, msg('m', 'x')], true, true), null);
  assert.equal(turnCard([user, msg('m', 'x')], false, false), null);
});

test("a turn that is only a compaction was the user's; one inside a normal turn was automatic", () => {
  const only = presentItems([{ type: 'contextCompaction', id: 'c' }]);
  assert.equal(compactionLabel(only[0]), 'Context compacted');
  const inside = presentItems([user, { type: 'contextCompaction', id: 'c' }, msg('m', 'x')]);
  assert.equal(compactionLabel(inside[1]), 'Context automatically compacted');
  // a mark already there wins (Sage recorded it, or Claude's compact_metadata said so)
  assert.equal(compactionLabel(presentItems([user, { type: 'contextCompaction', id: 'c', trigger: 'manual' }])[1]), 'Context compacted');
  assert.equal(
    compactionLabel(presentItems([{ type: 'contextCompaction', id: 'c', trigger: 'auto' }])[0]),
    'Context automatically compacted',
  );
});

test('background terminals: osPid may be unknown; stopping goes by the processId', () => {
  const r = {
    data: [{ itemId: 'i', processId: 86937, command: 'sleep 300', cwd: '/w', osPid: null, cpuPercent: null, rssKb: null }, { itemId: 'x' }],
  };
  assert.deepEqual(backgroundTerminals(r), [{ itemId: 'i', processId: '86937', command: 'sleep 300', cwd: '/w', osPid: null }]);
  assert.deepEqual(backgroundTerminals(null), []);
});

test("a spawn names the sub-agents' threads; other agent calls don't", () => {
  assert.deepEqual(spawnedThreads({ type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['s1', 's2'] }), ['s1', 's2']);
  assert.deepEqual(spawnedThreads({ type: 'subAgentActivity', kind: 'started', agentThreadId: 's3' }), ['s3']);
  assert.deepEqual(spawnedThreads({ type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: ['s1'] }), []);
});

test("a review's outcomes reported in its own turn leave the review's findings as the turn's card", () => {
  const f = { file: 'a.ts', line: 1, summary: 's' };
  const review = { type: 'exitedReviewMode', id: 'r1', review: '- a', findings: [f] };
  const outcomes = { type: 'exitedReviewMode', id: 'r2', review: '- a', findings: [{ ...f, outcome: 'fixed' }] };
  const plan = { type: 'plan', id: 'p', text: 'Plan' };
  assert.deepEqual(turnCard([user, review, msg('m', 'fixing'), outcomes], false, false), { kind: 'review', item: review });
  // outcomes alone (the fix turn) are the card, also over a plan before them
  assert.deepEqual(turnCard([user, outcomes], false, false), { kind: 'review', item: outcomes });
  assert.deepEqual(turnCard([user, plan, outcomes], false, false), { kind: 'review', item: outcomes });
  assert.deepEqual(turnCard([user, outcomes, plan], false, false), { kind: 'plan', item: plan });
});

test('presentItems in MoMo’s chat drops the CLI’s own records and only those (#4926)', () => {
  const items = [msg('a', 'No response requested.'), msg('b', 'Done: the report is in Files.'), msg('c', '(no content)')];
  assert.deepEqual(
    presentItems(items, true).map((i) => i.id),
    ['b'],
  );
  assert.equal(presentItems(items).length, 3, 'an ordinary chat shows what its harness wrote');
  assert.equal(presentItems([user], true).length, 1);
});
