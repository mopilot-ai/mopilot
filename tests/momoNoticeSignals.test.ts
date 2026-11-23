// MoMo notice text signals (shared/momoNotice/signals.ts): risk wording, deadlines and urgency in home-local days, cleaning of model-written text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  cleanText,
  deadlineDay,
  hasRiskSignal,
  holdsCode,
  redactSecrets,
  secretLinks,
  urgencyRank,
} from '../shared/momoNotice/signals.ts';

// 2026-11-24 is a Tuesday
const TODAY = '2026-11-24';

test('days move across month and year ends', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('risk wording is found in English and Chinese, plain wording is not', () => {
  for (const text of [
    'Security alert',
    'This looks suspicious',
    "it wasn't you",
    'Unauthorized charge',
    'payment declined',
    'failed payment',
    'Update your billing',
    'past due',
    'your account has been suspended',
    'store is paused',
    'Final notice',
    '付款失败',
  ]) {
    assert.equal(hasRiskSignal(text), true, text);
  }
  assert.equal(hasRiskSignal('Lunch on Friday? Your verification code is 123456'), false);
});

test('codes and secret links are found, other links are not', () => {
  assert.equal(holdsCode('Your verification code is 482913'), true);
  assert.equal(holdsCode('482913 is your code'), true);
  assert.equal(holdsCode('order 12345'), false);
  assert.deepEqual(secretLinks('see https://a.example/docs and https://a.example/reset/x or https://b.example/in?code=1'), [
    'https://a.example/reset/x',
    'https://b.example/in?code=1',
  ]);
});

test('deadlines: today, tomorrow, ISO dates, month names and weekdays, earliest first, never in the past', () => {
  assert.equal(deadlineDay('due today', TODAY), TODAY);
  assert.equal(deadlineDay('Due Tonight!', TODAY), TODAY);
  assert.equal(deadlineDay('by tomorrow', TODAY), '2026-11-25');
  assert.equal(deadlineDay('deadline 2026-12-03 or 2026-11-30', TODAY), '2026-11-30');
  assert.equal(deadlineDay('by Nov 27', TODAY), '2026-11-27');
  assert.equal(deadlineDay('before December 3rd', TODAY), '2026-12-03');
  assert.equal(deadlineDay('on Sept. 2', TODAY), '2027-09-02');
  assert.equal(deadlineDay('by Friday', TODAY), '2026-11-27');
  assert.equal(deadlineDay('due Tuesday', TODAY), TODAY);
  assert.equal(deadlineDay('until monday', TODAY), '2026-11-30');
  assert.equal(deadlineDay('today and by Friday', TODAY), TODAY);
  assert.equal(deadlineDay('明天', TODAY), '2026-11-25');
});

test('dates that are in the past or not real name no deadline', () => {
  assert.equal(deadlineDay('sent 2026-11-01', TODAY), undefined);
  assert.equal(deadlineDay('2026-13-05 and 2026-02-30', TODAY), undefined);
  assert.equal(deadlineDay('Feb 30', TODAY), undefined);
  assert.equal(deadlineDay('Nov 31', TODAY), undefined);
  assert.equal(deadlineDay('nothing here', TODAY), undefined);
  assert.equal(deadlineDay('on friday', TODAY), '2026-11-27');
  assert.equal(deadlineDay('Friday was fun', TODAY), undefined);
});

test('urgency: final wording or today is 3, within three days 2, otherwise 1', () => {
  assert.equal(urgencyRank('Final notice', undefined, TODAY), 3);
  assert.equal(urgencyRank('this is overdue', '2026-12-30', TODAY), 3);
  assert.equal(urgencyRank('hello', undefined, TODAY), 1);
  assert.equal(urgencyRank('hello', TODAY, TODAY), 3);
  assert.equal(urgencyRank('hello', '2026-11-25', TODAY), 2);
  assert.equal(urgencyRank('hello', '2026-11-27', TODAY), 2);
  assert.equal(urgencyRank('hello', '2026-11-28', TODAY), 1);
});

test('model-written text is made safe to store and show', () => {
  assert.equal(cleanText('Dana needs the\nquote\u0000 today  ', 80), 'Dana needs the quote today');
  assert.equal(cleanText('Pay at https://evil.example/x?y=1 now', 80), 'Pay at [link] now');
  assert.equal(
    cleanText('Your verification code is 482913, link https://a.example/reset/x', 80),
    'Your verification code is [code removed], link [link removed]',
  );
  assert.equal(cleanText('x'.repeat(30), 10), `${'x'.repeat(9)}…`);
  assert.equal(cleanText('short', 10), 'short');
});

test('redaction leaves ordinary text alone', () => {
  assert.equal(redactSecrets('Lunch on Friday'), 'Lunch on Friday');
});
