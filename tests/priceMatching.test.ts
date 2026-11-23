// Which list price a model id gets (shared/host/prices.mjs): a model's own price or none, never another version's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, parsePrices, LIST_PRICES } from '../shared/host/prices.mjs';

const bad = (m: string) => new Error(m);

test('a newer version never takes an older version’s price', () => {
  // claude-opus-4 is $15/$75; claude-opus-4-8 is $5/$25 (web/db/migrations/0004_seed_claude_prices.sql)
  assert.equal(priceFor('claude-opus-4-8')?.input, 5);
  assert.equal(priceFor('claude-opus-4-8')?.output, 25);
  // gpt-5 is $1.25; gpt-5.5 is $5 (0005_seed_openai_prices.sql)
  assert.equal(priceFor('gpt-5.5')?.input, 5);
  // a version the table does not list is unpriced, not its family's price
  assert.equal(priceFor('claude-opus-4-9'), null);
  assert.equal(priceFor('gpt-5.9'), null);
  assert.equal(priceFor('gpt-5.4-nano'), null, 'a variant is a different model at a different price');
});

test('current models are priced at their own list price', () => {
  const cases: [string, number, number][] = [
    ['claude-opus-5-5', 4, 20],
    ['claude-sonnet-5-5', 2, 10],
    ['claude-haiku-5-5', 0.1, 0.5],
    ['claude-fable-5-1', 10, 50],
    ['claude-sonnet-5', 2, 10],
    ['gpt-6.1-sol', 2, 10],
    ['gpt-6-luna', 0.1, 0.5],
    ['gpt-5.6-terra', 2, 12],
    ['gpt-5.3-codex', 1.75, 14],
    ['deepseek-flash', 0.15, 0.6],
  ];
  for (const [model, input, output] of cases) {
    const p = priceFor(model);
    assert.equal(p?.input, input, model);
    assert.equal(p?.output, output, model);
  }
});

test('the forms a provider names a model by find that model’s price', () => {
  const opus = LIST_PRICES['claude-opus-4-5'];
  for (const id of [
    'claude-opus-4-5-20251101', // a dated snapshot
    'claude-opus-4-5@20251101', // Vertex
    'us.anthropic.claude-opus-4-5-20251101-v1:0', // Bedrock, cross-region
    'anthropic.claude-opus-4-5-20251101-v1:0', // Bedrock
    'anthropic/claude-opus-4-5', // OpenRouter
    'claude-opus-4-5[1m]', // Claude Code's long-context tag
  ])
    assert.deepEqual(priceFor(id), opus, id);
  assert.equal(priceFor('gpt-5-mini-2025-08-07')?.input, 0.25);
  assert.equal(priceFor('gpt-5.4-2026-03-05')?.input, 2.5);
  assert.equal(priceFor('openai/gpt-5.5')?.input, 5);
  // older ids Anthropic still serves keep their own price
  assert.equal(priceFor('claude-opus-4-1-20250805')?.input, 15);
  assert.equal(priceFor('claude-opus-4-20250514')?.input, 15);
  assert.equal(priceFor('claude-opus-4-0')?.input, 15);
  assert.equal(priceFor('claude-sonnet-4-0')?.input, 3);
  // a dated form needs the whole date, and a Bedrock suffix only follows a Bedrock prefix
  assert.equal(priceFor('gpt-5-mini-2025'), null);
  assert.equal(priceFor('claude-opus-4-5-v1:0'), null);
  assert.equal(priceFor('codex-auto-review')?.input, 2, 'Codex’s review model is priced as the model it runs on');
  // an id that names an inherited property is no model
  for (const id of ['constructor', '__proto__', 'toString', 'anthropic/constructor'])
    assert.equal(priceFor(id, { 'house-model': { input: 1, output: 1 } }), null, id);
});

test('an owner’s key prices its model and, below a model’s own price, every id it starts', () => {
  const owner = { 'gpt-5': { input: 0.5, output: 0.5 }, 'claude-opus-4': { input: 1, output: 1 }, house: { input: 3, output: 3 } };
  assert.equal(priceFor('house-model', { 'house-model': { input: 1, output: 2 } })?.output, 2);
  // as before this change: a model the shipped table does not know takes the owner's longest key it starts with
  assert.equal(priceFor('gpt-5.1', owner)?.input, 0.5);
  assert.equal(priceFor('gpt-5.1-codex-max', owner)?.input, 0.5);
  assert.equal(priceFor('house-model-2', owner)?.input, 3);
  assert.equal(
    priceFor('house-model-2', { house: { input: 1, output: 2 }, 'house-model': { input: 3, output: 4 } })?.output,
    4,
    'the longest key wins',
  );
  // a model with a price of its own keeps it, so the owner's family key does not reach a newer version
  assert.equal(priceFor('claude-opus-4-8', owner)?.input, 5);
  assert.equal(priceFor('gpt-5', owner)?.input, 0.5, 'the owner replaces a shipped price by its key');
  assert.equal(priceFor('gpt-5.5', { 'gpt-5.5': { input: 7, output: 7 } })?.input, 7);
  assert.equal(priceFor('gpt-5.5-2026-01-01', { 'gpt-5.5': { input: 7, output: 7 } })?.input, 7, 'and its snapshots');
  assert.equal(priceFor('gpt-5.5', { gpt: { input: 9, output: 9 } })?.input, 5, 'a model’s own price beats a family key');
  assert.equal(priceFor('gpt-5.9', { gpt: { input: 9, output: 9 } })?.input, 9);
  assert.equal(priceFor('gpt-5.5', null)?.input, 5, 'no owner table is the shipped one');
  for (const key of ['*', 'a*b', 'a b', '']) assert.throws(() => parsePrices({ [key]: { input: 1, output: 2 } }, bad), /./, key);
});

test('a long or hostile id is answered at once', () => {
  const started = performance.now();
  assert.equal(priceFor('['.repeat(100_000)), null);
  assert.equal(priceFor(`${'['.repeat(150)}]`), null);
  assert.equal(priceFor(`claude-opus-4-5${'x'.repeat(200)}`, { claude: { input: 1, output: 1 } }), null, 'past the longest id');
  assert.ok(performance.now() - started < 200);
});

test('every shipped price names one model and lists every rate', () => {
  for (const [, p] of Object.entries(LIST_PRICES))
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) assert.equal(typeof p[k], 'number', k);
});
