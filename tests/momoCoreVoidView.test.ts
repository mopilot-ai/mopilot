// A card that can no longer be answered because the home moved, the line it was about changed, or its op was let go is `void` on the row, without "ask again"; the note that changed says so.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Card } from '../shared/momoCore/approvalGate.ts';
import { approvalView } from '../shared/momoCore/view.ts';

const card = (over: Partial<Card>): Card =>
  ({
    id: 'c1',
    tool: 'momo_notes',
    effect: 'write',
    scope: 'notes',
    summary: 'Change a line',
    status: 'expired',
    createdAt: 1,
    expiresAt: null,
    ...over,
  }) as Card;

test('moved, changed and dropped are void, an ordinary expiry is expired and can be asked again', () => {
  for (const why of ['moved', 'changed', 'dropped'] as const) {
    const v = approvalView(card({ expiredWhy: why }), { device: 'd' });
    assert.equal(v.status, 'void');
    assert.equal(v.canAskAgain, false);
  }
  assert.equal(
    approvalView(card({ expiredWhy: 'changed' }), { device: 'd' }).failure?.cause,
    'The note changed after you were asked, so nothing was applied.',
  );
  assert.equal(approvalView(card({ expiredWhy: 'moved' }), { device: 'd' }).failure, null);
  assert.equal(
    approvalView(card({ expiredWhy: 'superseded' }), { device: 'd' }).failure?.cause,
    'You changed this card: the new one replaces it.',
  );
  const timed = approvalView(card({ expiredWhy: 'unattended_timeout' }), { device: 'd' });
  assert.deepEqual([timed.status, timed.canAskAgain], ['expired', true]);
  assert.equal(approvalView(card({ status: 'expired' }), { device: 'd' }).status, 'expired', 'no reason given');
});

test('a rule in words that is on is saved, not on, until something reads it', async () => {
  const { emptyLearning, ownerRule } = await import('../shared/momoCore/learning.ts');
  const { ruleView } = await import('../shared/momoCore/view.ts');
  const made = ownerRule(emptyLearning(), { text: 'Invoices: tell me', effect: 'tell_now' }, { newId: () => 'r1', now: () => 1 });
  const rule = made.rule as NonNullable<typeof made.rule>;
  assert.equal(ruleView(rule, 0, false).state, 'saved');
  assert.equal(ruleView(rule, 0, true).state, 'on');
  assert.equal(ruleView(rule, 0).state, 'on', 'read by default');
  assert.equal(ruleView({ ...rule, status: 'retired' }, 0, false).state, 'undone', 'only a rule that is on is saved');
});
