// The spend vocabulary (shared/host/spend.mjs, shared/host/prices.mjs, plan U5): the policy block, list prices and their arithmetic, the day boundary in the owner's zone and the words clients show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { parseSpend, mergeSpend, dayKey, aboutUsd, limitLine, SPEND_FEATURE } from '../shared/host/spend.mjs';
// @ts-ignore
import { parsePrices, priceFor, costOf, LIST_PRICES } from '../shared/host/prices.mjs';
// @ts-ignore
import { parseOwnerPolicy } from '../shared/host/policy.mjs';
// @ts-ignore
import { FEATURES } from '../shared/host/schema.mjs';

const bad = (m: string) => new Error(m);

test('the spend block parses limits, warning share, zone and prices; unknown keys drop; invalid refuses', () => {
  assert.deepEqual(parseSpend({ dayUsd: 20, chatUsd: 10, warnAt: 0.8, tz: 'America/Los_Angeles', extra: 1 }, bad), {
    dayUsd: 20,
    chatUsd: 10,
    warnAt: 0.8,
    tz: 'America/Los_Angeles',
  });
  assert.deepEqual(parseSpend({ dayUsd: null }, bad), {}, 'null leaves a limit unset');
  assert.deepEqual(parseSpend({ prices: { 'm-1': { input: 1, output: 2 } } }, bad).prices, { 'm-1': { input: 1, output: 2 } });
  for (const v of [
    null,
    [],
    3,
    { dayUsd: 0 },
    { dayUsd: -1 },
    { chatUsd: '5' },
    { dayUsd: 1e9 },
    { warnAt: 1 },
    { warnAt: 'x' },
    { tz: 'Mars/Base' },
    { tz: '' },
    { tz: 4 },
    { prices: 3 },
  ])
    assert.throws(() => parseSpend(v, bad), /./, JSON.stringify(v));
});

test('the policy document carries the spend block and the stricter limit wins a merge', () => {
  const doc = parseOwnerPolicy({ version: 1, spend: { dayUsd: 20 } }, bad);
  assert.equal(doc.spend.dayUsd, 20);
  assert.equal(parseOwnerPolicy({ version: 1 }, bad).spend, undefined);
  assert.deepEqual(mergeSpend({ dayUsd: 20, chatUsd: 5 }, { dayUsd: 10 }), { dayUsd: 10, chatUsd: 5 });
  assert.deepEqual(mergeSpend({ dayUsd: 5 }, { dayUsd: 10, chatUsd: 3 }), { dayUsd: 5, chatUsd: 3 });
  assert.deepEqual(mergeSpend(undefined, {}), {});
  assert.ok(FEATURES.includes(SPEND_FEATURE));
});

test('prices: a model’s own price, the owner replaces, a model not listed is unpriced', () => {
  assert.equal(priceFor('claude-opus-4-5-20251101')?.input, 5);
  assert.equal(priceFor('claude-opus-4-1')?.input, 15);
  assert.equal(priceFor('gpt-5-mini-2025-08-07')?.input, 0.25);
  assert.equal(priceFor('gpt-5-codex')?.input, 1.25);
  assert.equal(priceFor('some-new-model'), null);
  assert.equal(priceFor(null), null);
  assert.equal(priceFor(''), null);
  assert.equal(priceFor('some-new-model', { 'some-new': { input: 2, output: 4 } })?.output, 4);
  assert.equal(
    priceFor('gpt-5', { gpt: { input: 99, output: 99 } })?.input,
    1.25,
    'a model’s own shipped price beats a shorter owner key; the owner replaces by the same key',
  );
  assert.equal(priceFor('gpt-5', { 'gpt-5': { input: 7, output: 7 } })?.input, 7);
  assert.ok(Object.isFrozen(LIST_PRICES));
});

test('costOf adds each token kind at its rate, falls back to the input rate, and is null when unpriced', () => {
  const p = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cachedReadTokens: 2_000_000, cachedWriteTokens: 200_000 };
  assert.equal(Math.round(costOf(usage, p)! * 1e6) / 1e6, 3 + 1.5 + 0.6 + 0.75);
  assert.equal(costOf({ cachedReadTokens: 1_000_000, cachedWriteTokens: 1_000_000 }, { input: 2, output: 4 }), 4);
  assert.equal(costOf({ inputTokens: Number.NaN, outputTokens: -5 }, p), 0);
  assert.equal(costOf(usage, null), null);
});

test('parsePrices refuses what it cannot read', () => {
  for (const v of [
    null,
    [],
    'x',
    { 'bad id!': { input: 1, output: 1 } },
    { m: null },
    { m: { input: 1 } },
    { m: { input: -1, output: 1 } },
    { m: { input: 1, output: 1, cacheRead: 'x' } },
  ])
    assert.throws(() => parsePrices(v, bad), /./, JSON.stringify(v));
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`m${i}`, { input: 1, output: 1 }]));
  assert.throws(() => parsePrices(many, bad), /too many/);
  assert.deepEqual(parsePrices({ m: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.2 } }, bad), {
    m: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.2 },
  });
});

test('the day rolls over at midnight in the owner’s zone, not the Host’s', () => {
  const at = Date.UTC(2026, 10, 15, 6, 30); // 06:30 UTC on the 15th
  assert.equal(dayKey(at, 'UTC'), '2026-11-15');
  assert.equal(dayKey(at, 'America/Los_Angeles'), '2026-11-14', 'still the 14th in Los Angeles');
  assert.equal(dayKey(at, 'Asia/Tokyo'), '2026-11-15');
  assert.equal(dayKey(Date.UTC(2026, 10, 15, 7, 59), 'America/Los_Angeles'), '2026-11-14');
  assert.equal(dayKey(Date.UTC(2026, 10, 15, 8, 0), 'America/Los_Angeles'), '2026-11-15');
  assert.match(dayKey(at), /^\d{4}-\d{2}-\d{2}$/);
});

test('amounts are said as "about", and the limit line names the day or the chat', () => {
  assert.equal(aboutUsd(4.2), 'about $4.20');
  assert.equal(aboutUsd(20), 'about $20');
  assert.equal(aboutUsd(12.6), 'about $13');
  assert.equal(limitLine('dayUsd', 20), 'Limit reached: about $20 today');
  assert.equal(limitLine('chatUsd', 5), 'Limit reached: about $5.00 in this chat');
});
