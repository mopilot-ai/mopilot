import { test } from 'node:test';
import assert from 'node:assert/strict';

const { gatewayEntry, gatewayId, claudeModelServed, gatewayDrops } = await import('../shared/mopilotCaps.mjs');

const table = {
  'gpt-x': { wires: ['responses', 'chat'], fast: true, drops: [] },
  'claude-opus-4-1': { wires: ['anthropic'], fast: false, drops: ['speed'] },
  'claude-opus-4-5': { wires: ['anthropic'], fast: true, drops: [] },
  'claude-sonnet-4-5': { wires: ['anthropic'], fast: false, drops: ['speed'] },
};

test('a Claude alias resolves to the newest Anthropic gateway id, with or without a [1m] suffix', () => {
  assert.equal(gatewayId(table, 'opus'), 'claude-opus-4-5');
  assert.equal(gatewayId(table, 'sonnet[1m]'), 'claude-sonnet-4-5');
  assert.equal(gatewayId(table, 'gpt-x'), 'gpt-x');
  assert.equal(gatewayId(table, 'haiku'), null);
  assert.equal(gatewayId(null, 'opus'), null);
  assert.equal(gatewayEntry(table, 'opus'), table['claude-opus-4-5']);
});

test('drops follow the table for both harnesses; a Claude model the table lacks stays without Fast', () => {
  assert.deepEqual(gatewayDrops(table, 'opus', 'claude'), []);
  assert.deepEqual(gatewayDrops(table, 'sonnet', 'claude'), ['speed']);
  assert.deepEqual(gatewayDrops(table, 'gpt-x', 'codex'), []);
  assert.deepEqual(
    gatewayDrops({ ...table, 'gpt-x': { wires: ['responses'], fast: false, drops: ['speed', 'multiAgent'] } }, 'gpt-x', 'codex'),
    ['speed', 'multiAgent'],
  );
  assert.deepEqual(gatewayDrops(table, 'haiku', 'claude'), ['speed']);
  assert.deepEqual(gatewayDrops(null, 'opus', 'claude'), ['speed']);
  // an unlisted model keeps Fast on Codex and a basic harness: the gateway decides
  assert.deepEqual(gatewayDrops(null, 'opus', 'codex'), []);
  assert.deepEqual(gatewayDrops(null, 'm', 'acp:kimi'), []);
  assert.deepEqual(gatewayDrops(null, 'm', 'toString'), []);
  assert.deepEqual(gatewayDrops(table, 'unknown', 'codex'), []);
});

test('the Claude model list keeps what the gateway serves on the Anthropic wire', () => {
  assert.equal(claudeModelServed(table, 'opus'), true);
  assert.equal(claudeModelServed(table, 'opus[1m]'), true);
  assert.equal(claudeModelServed(table, 'haiku'), false);
  assert.equal(claudeModelServed(table, 'gpt-x'), false);
  assert.equal(claudeModelServed(table, 'claude-opus-4-5'), true);
  // what the table says nothing about stays: the gateway decides
  assert.equal(claudeModelServed(table, 'default'), true);
  assert.equal(claudeModelServed(null, 'haiku'), true);
  assert.equal(claudeModelServed({}, 'haiku'), true);
});
