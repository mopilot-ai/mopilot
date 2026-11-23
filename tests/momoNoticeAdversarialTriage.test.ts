// Adversarial triage evaluation for the MoMo notice pipeline: 150+ labelled invented items run through the real pre-checks, sender check, limits and decision record with an oracle model; known gaps run as visible todo tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { FINDINGS, GAPS } from './momoEvals/notice/knownGaps.ts';
import { ITEMS } from './momoEvals/notice/items.ts';
import { evaluateItem } from './momoEvals/notice/run.ts';

const out = process.env.MOMO_EVAL_OUT;
if (out) writeFileSync(out, '');

test('the set has 150+ unique labelled items across all three outcomes and every required group', () => {
  assert.ok(ITEMS.length >= 150, `only ${ITEMS.length} items`);
  assert.equal(new Set(ITEMS.map((i) => i.id)).size, ITEMS.length);
  for (const verdict of ['tell_now', 'track', 'quiet'] as const)
    assert.ok(ITEMS.filter((i) => i.expected === verdict).length >= 10, verdict);
  const groups = new Set(ITEMS.map((i) => i.group));
  for (const group of [
    'security',
    'payments',
    'store',
    'codes',
    'phishing',
    'instructions',
    'headers',
    'marketing',
    'newsletters',
    'norush',
    'cc',
    'calendar',
    'threads',
    'languages',
  ])
    assert.ok(groups.has(group), group);
  assert.ok(ITEMS.some((i) => i.event) && ITEMS.some((i) => i.mail));
});

test('every known gap names a real item and a described finding', () => {
  for (const [id, finding] of Object.entries(GAPS)) {
    assert.ok(
      ITEMS.some((i) => i.id === id),
      `${id} is not an item`,
    );
    assert.ok(FINDINGS[finding], finding);
  }
});

test('the set carries no raw non-ASCII text (mixed-language items are escaped)', () => {
  for (const file of ['items.ts', 'run.ts', 'knownGaps.ts']) {
    const text = readFileSync(new URL(`./momoEvals/notice/${file}`, import.meta.url), 'utf8');
    assert.equal(/[^\x00-\x7f]/.test(text), false, file);
  }
});

for (const item of ITEMS) {
  const finding = GAPS[item.id];
  test(`${item.group}/${item.id}: ${item.expected}`, finding ? { todo: `${finding}: ${FINDINGS[finding]}` } : {}, async () => {
    const checks = await evaluateItem(item);
    if (out)
      appendFileSync(
        out,
        `${JSON.stringify({ id: item.id, group: item.group, expected: item.expected, ok: checks.every((c) => c.ok), checks: checks.filter((c) => !c.ok) })}\n`,
      );
    assert.deepEqual(
      checks.filter((c) => !c.ok),
      [],
    );
  });
}
