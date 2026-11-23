// The approval engine's wire (shared/host/approvals.mjs): the card summary is built from structure, and every reader drops what it cannot read instead of guessing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import * as Approvals from '../shared/host/approvals.mjs';

const A: any = Approvals;
// @ts-ignore: plain ESM without declarations
import { parseParams, requireFeatures, FEATURES } from '../shared/host/schema.mjs';

test('summaryOf names the tool from the call kind and clips the line', () => {
  assert.deepEqual(A.summaryOf({ title: 'git  push\norigin', kind: 'execute' }), { tool: 'execute', line: 'git push origin' });
  for (const [kind, tool] of [
    ['edit', 'edit'],
    ['move', 'edit'],
    ['delete', 'delete'],
    ['fetch', 'fetch'],
    ['switch_mode', 'plan'],
    ['read', 'other'],
    [undefined, 'other'],
  ])
    assert.equal(A.summaryOf({ title: 'x', kind }).tool, tool);
  assert.equal(A.summaryOf({ title: 'x', kind: 'execute' }, 'question').tool, 'question');
  const long = A.summaryOf({ title: 'a'.repeat(500) }).line;
  assert.equal(long.length, A.SUMMARY_LINE_MAX);
  assert.ok(long.endsWith('…'));
  // an emoji is never cut in half
  assert.ok(!/\uFFFD|[\uD800-\uDBFF]…$/.test(A.summaryOf({ title: `${'a'.repeat(158)}😀😀` }).line));
  // B1: no tool name, a non-string title, no object at all
  assert.deepEqual(A.summaryOf({ title: 42 }), { tool: 'other', line: '' });
  assert.deepEqual(A.summaryOf(null), { tool: 'other', line: '' });
  assert.deepEqual(A.summaryOf({ title: 't', stat: { files: 1, added: 2, removed: 3 } }).stat, { files: 1, added: 2, removed: 3 });
  assert.equal(A.summaryOf({ title: 't', stat: { files: -1, added: 2, removed: 3 } }).stat, undefined);
  assert.equal(A.summaryOf({ title: 't', stat: 'big' }).stat, undefined);
});

test('optionKindOf and principalOf', () => {
  assert.equal(A.optionKindOf('allow_once'), 'allow');
  assert.equal(A.optionKindOf('allow_always'), 'allow');
  assert.equal(A.optionKindOf('reject_once'), 'deny');
  assert.equal(A.optionKindOf('x'), 'other');
  assert.equal(A.optionKindOf(3), 'other');
  assert.deepEqual(A.principalOf({ fingerprint: 'ab', name: 'Du phone', kind: 'phone', extra: 1 }), {
    fingerprint: 'ab',
    name: 'Du phone',
    kind: 'phone',
  });
  for (const bad of [null, [], 'x', { fingerprint: 'ab', name: 'n' }, { fingerprint: '', name: 'n', kind: 'k' }])
    assert.equal(A.principalOf(bad), null);
});

test('attentionOf reads the three kinds and nothing else', () => {
  assert.deepEqual(A.attentionOf({ kind: 'approval', since: 5, cards: ['a', 7, 'b'] }), { kind: 'approval', since: 5, cards: ['a', 'b'] });
  assert.deepEqual(A.attentionOf({ kind: 'approval', since: 5 }), { kind: 'approval', since: 5, cards: [] });
  assert.deepEqual(A.attentionOf({ kind: 'paused', since: 5, reason: 'other' }), { kind: 'paused', since: 5, reason: 'approval_timeout' });
  // a pause says the minutes the owner gave it, when they are a whole number in the policy's range
  const paused = (pauseMinutes: unknown) => A.attentionOf({ kind: 'paused', since: 5, pauseMinutes });
  assert.deepEqual(paused(5), { kind: 'paused', since: 5, reason: 'approval_timeout', pauseMinutes: 5 });
  for (const odd of [0, 721, 2.5, '5', null]) assert.deepEqual(paused(odd), { kind: 'paused', since: 5, reason: 'approval_timeout' });
  assert.deepEqual(A.attentionOf({ kind: 'credential', since: 5 }), { kind: 'credential', since: 5 });
  for (const bad of [null, 'x', { kind: 'limit', since: 1 }, { kind: 'paused' }, { kind: 'paused', since: 'x' }])
    assert.equal(A.attentionOf(bad), null);
});

const card = {
  chatId: 'c1',
  epoch: 0,
  requestId: 'r1',
  turnId: 't1',
  family: 'claude',
  cardKind: 'permission',
  summary: { tool: 'execute', line: 'git push' },
  options: [{ optionId: 'allow', name: 'Allow', kind: 'allow' }, { optionId: 'x', name: 'X', kind: 'weird' }, { nope: 1 }],
  at: 9,
};

test('cardOf and pendingOf drop what they cannot read', () => {
  assert.deepEqual(A.cardOf(card).options, [
    { optionId: 'allow', name: 'Allow', kind: 'allow' },
    { optionId: 'x', name: 'X', kind: 'other' },
  ]);
  assert.equal(A.cardOf({ ...card, turnId: undefined }).turnId, undefined);
  assert.deepEqual(
    A.cardOf({ ...card, options: 'x', form: { a: 1 }, summary: { tool: 'question', line: 'q', stat: { files: 1, added: 0, removed: 0 } } })
      .summary.stat,
    { files: 1, added: 0, removed: 0 },
  );
  assert.deepEqual(A.cardOf({ ...card, options: undefined, form: { a: 1 } }).form, { a: 1 });
  assert.deepEqual(A.cardOf({ ...card, options: undefined }).options, []);
  for (const bad of [
    null,
    { ...card, chatId: '' },
    { ...card, cardKind: 'x' },
    { ...card, at: 'now' },
    { ...card, epoch: 1.5 },
    { ...card, summary: null },
    { ...card, summary: { tool: 'rm', line: '' } },
    { ...card, summary: { tool: 'edit', line: 'a'.repeat(161) } },
    { ...card, summary: { tool: 'edit', line: 1 } },
  ])
    assert.equal(A.cardOf(bad), null);
  const read = A.pendingOf({
    cards: [card, 1],
    attention: [
      { chatId: 'c1', kind: 'paused', since: 1 },
      { kind: 'paused', since: 1 },
      { chatId: 'c2', kind: 'zzz', since: 1 },
    ],
  });
  assert.equal(read.cards.length, 1);
  assert.deepEqual(read.attention, [{ chatId: 'c1', kind: 'paused', since: 1, reason: 'approval_timeout' }]);
  assert.deepEqual(A.pendingOf(null), { cards: [], attention: [], closed: [] });
  assert.deepEqual(A.pendingOf({ cards: 'x', attention: 'y' }), { cards: [], attention: [], closed: [] });
});

test('host.pending is a known method that needs approvals2 on both ends', () => {
  assert.deepEqual(parseParams('host.pending', {}), {});
  assert.deepEqual(parseParams('host.pending', undefined), {});
  assert.throws(
    () => requireFeatures('host.pending', { features: [] }),
    (e: any) => e.code === 'feature_missing' && e.missing[0] === 'approvals2',
  );
  requireFeatures('host.pending', { features: ['approvals2'] });
  assert.ok(FEATURES.includes('approvals2'));
});

test('the cards a Host closed are read with the device that answered, and an unreadable entry or an older Host leaves none', () => {
  assert.deepEqual(
    A.closedOf({
      closed: [
        { chatId: 'c1', requestId: 'r1', by: { name: 'Studio', secret: 'x' }, at: 1 },
        { chatId: 'c1', requestId: 'r2' },
        { chatId: 'c1' },
        'x',
        { chatId: 'c2', requestId: 'r3', by: { name: 5 } },
      ],
    }),
    [
      { chatId: 'c1', requestId: 'r1', by: { name: 'Studio' } },
      { chatId: 'c1', requestId: 'r2' },
      { chatId: 'c2', requestId: 'r3' },
    ],
  );
  assert.deepEqual(A.closedOf({ cards: [] }), []);
  assert.deepEqual(A.closedOf({ closed: 'x' }), []);
  assert.deepEqual(A.closedOf(null), []);
});
