// The lines under a harness row and the effort a model resolves to, said once and the same as This Mac's (#5072).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingHint } from '../shared/host/agentReadiness.mjs';
import { hostModelSelection, modelDefaultEffort } from '../shared/host/models.mjs';
import { localEffortChoice, newChatEffortOf } from '../src/harness/newChatEffort.ts';
import { notReadyLine } from '../src/lib/machinePicker.ts';

const agent = (over: Record<string, unknown>) => ({ id: 'x', label: 'Codex', state: 'missing', reason: '', ...over }) as any;
const model = (over: Record<string, unknown> = {}) => ({
  id: 'm',
  name: 'M',
  default: true,
  efforts: ['low', 'high'],
  defaultEffort: null,
  ...over,
});

test("the missing hint is This Mac's wording, or the machine's where it says where to install", () => {
  assert.equal(missingHint('Codex', { settings: 'Settings → Codex' }), 'Install Codex, or set its path in Settings → Codex.');
  assert.equal(missingHint('Codex', { machine: 'Box' }), 'Install Codex on Box.');
});

test('the second line of a row that cannot run adds a cause or nothing', () => {
  assert.equal(notReadyLine(agent({ state: 'ready' }), 'Box'), null);
  assert.equal(notReadyLine(agent({ reason: 'Not installed on Box' }), 'Box'), 'Install Codex on Box.');
  assert.equal(notReadyLine(agent({ state: 'signin', reason: 'Sign in on Box' }), 'Box'), null);
  assert.equal(notReadyLine(agent({ state: 'signin', reason: '' }), 'Box'), null);
  assert.equal(notReadyLine(agent({ state: 'signin', reason: 'Sign in on Box: A or B' }), 'Box'), 'Sign in on Box: A or B');
  assert.equal(notReadyLine(agent({ state: 'signin', reason: 'Checking on Box…' }), 'Box'), 'Checking on Box…');
});

test('a model with no reported default effort resolves as This Mac does: high when offered, else the first level, else none', () => {
  assert.equal(modelDefaultEffort(model() as any), 'high');
  assert.equal(modelDefaultEffort(model({ efforts: ['low', 'medium'] }) as any), 'low');
  assert.equal(modelDefaultEffort(model({ efforts: [] }) as any), null);
  assert.equal(modelDefaultEffort(model({ defaultEffort: 'low' }) as any), 'low');
  assert.equal(hostModelSelection([model()] as any, null, 'box', 'claude').effort, 'high');
  assert.equal(hostModelSelection([model({ efforts: [] })] as any, null, 'box', 'claude').effort, null);
});

test('a remembered effort applies to a draft with no pick of its own, when the model offers it', () => {
  const models = [model({ efforts: ['low', 'medium', 'high'] })] as any;
  assert.equal(hostModelSelection(models, null, 'box', 'claude', 'medium').effort, 'medium');
  assert.equal(hostModelSelection(models, null, 'box', 'claude', 'max').effort, 'high');
  assert.equal(hostModelSelection(models, null, 'box', 'claude', null).effort, 'high');
  const own = { hostId: 'box', harness: 'claude', model: 'm', effort: 'low' };
  assert.equal(hostModelSelection(models, own, 'box', 'claude', 'medium').effort, 'low');
  const other = { hostId: 'box', harness: 'codex', model: 'm', effort: 'low' };
  assert.equal(hostModelSelection(models, other, 'box', 'claude', 'medium').effort, 'medium');
});

test("the first level This Mac says for a new chat: Claude Code's remembered pick; Codex's remembered pick, then a running chat's, then its config file", () => {
  assert.equal(localEffortChoice('claude', 'high'), 'high');
  assert.equal(localEffortChoice('claude', null, 'low', 'low'), null, 'Claude Code reads no config file here');
  assert.equal(localEffortChoice('codex', 'high', 'low', 'medium'), 'high');
  assert.equal(localEffortChoice('codex', null, 'low', 'medium'), 'low');
  assert.equal(localEffortChoice('codex', null, null, 'medium'), 'medium');
  assert.equal(localEffortChoice('codex', undefined), null);
});

test("what a new chat of an agent on a machine starts on, from this Mac's remembered picks; no other agent has one", () => {
  const state = { prefs: { claudeSelection: { effort: 'medium' }, effort: 'high' }, config: { model_reasoning_effort: 'low' } };
  assert.equal(newChatEffortOf('claude', state), 'medium');
  assert.equal(newChatEffortOf('codex', state), 'high');
  assert.equal(newChatEffortOf('codex', { prefs: { effort: null }, config: { model_reasoning_effort: 'low' } }), 'low');
  assert.equal(newChatEffortOf('codex', {}), null);
  assert.equal(newChatEffortOf('claude', {}), null);
  assert.equal(newChatEffortOf('opencode', state), null);
});
