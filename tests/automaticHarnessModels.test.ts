// Automatic model choices follow harness recommendations without turning native receipts into version pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { claudeOwnOf } from '../src/harness/claude/own.ts';
import { automaticModel } from '../src/harness/automaticModel.ts';
import { chatModelChoice, effectiveModel } from '../shared/modelChoice.mjs';
import { claudeDefaultModel, claudeModels } from '../shared/claudeModels.mjs';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { turnParams } = require('../electron/harness/codexParams.cjs');
const { CodexTurns } = require('../electron/harness/codexTurns.cjs');
const { claudeTurnSettings } = require('../electron/harness/claude/turnSettings.cjs');
const { applySettings } = require('../electron/harness/acp/settings.cjs');
const { CodexApi } = require('../electron/harness/codexApi.cjs');
const { keepTurnSelection } = require('../electron/harness/claude/turnStart.cjs');

test('automatic intent remains distinct from a concrete model, an unread receipt, and a native fallback', () => {
  assert.equal(chatModelChoice({ model: null }, 'old', 'other'), null);
  assert.equal(chatModelChoice({ model: 'picked' }, null, 'other'), 'picked');
  assert.equal(chatModelChoice(undefined, 'reported', 'other'), 'reported');
  assert.equal(chatModelChoice(undefined, undefined, undefined), undefined);
  assert.equal(effectiveModel(null, 'recommended', 'configured'), 'recommended');
  assert.equal(effectiveModel(null, null, 'configured'), 'configured');
  assert.equal(effectiveModel(null, null), null);
  assert.equal(effectiveModel('picked', 'recommended'), 'picked');
});

test('the Automatic menu choice uses current capabilities and never stores its current recommended version', () => {
  const model = { id: 'recommended', label: 'Recommended', efforts: ['high'], defaultEffort: 'high', fast: true, isDefault: true };
  assert.equal(automaticModel([]), undefined);
  assert.deepEqual(automaticModel([model]), { ...model, id: '', label: 'Automatic', description: undefined, more: false });
  assert.equal(automaticModel([{ ...model, isDefault: false }])?.id, '');
});

test('Claude recommendations follow default metadata, with legacy and custom-catalog fallbacks', () => {
  const models = [{ value: 'default', resolvedModel: 'new-sonnet' }, { value: 'opus' }, { value: 'sonnet', resolvedModel: 'new-sonnet' }];
  assert.equal(claudeDefaultModel(models), 'sonnet');
  assert.equal(claudeModels(models.map((m) => ({ displayName: m.value, description: '', ...m }))).find((m) => m.isDefault)?.id, 'sonnet');
  assert.equal(claudeDefaultModel([{ value: 'default', resolvedModel: 'custom' }, { value: 'custom' }]), 'custom');
  assert.equal(claudeDefaultModel([{ value: 'default', resolvedModel: 'unlisted' }, { value: 'opus' }]), 'opus');
  assert.equal(claudeDefaultModel([{ value: 'custom' }]), 'custom');
  assert.equal(claudeDefaultModel([]), null);
});

test('Codex automatic turns use the recommended model ahead of a pinned CLI default', () => {
  const defaults = { model: 'gpt-6.1-sol', defaultModel: 'gpt-6.2-sol' };
  const automatic = turnParams('chat', 'input', { text: 'continue' }, { model: null }, '/work', defaults);
  assert.equal(automatic.collaborationMode.settings.model, 'gpt-6.2-sol');
  assert.equal(automatic.model, 'gpt-6.2-sol');
  const pinned = turnParams('chat', 'input', { text: 'continue' }, { model: 'gpt-6.1-sol' }, '/work', defaults);
  assert.equal(pinned.collaborationMode.settings.model, 'gpt-6.1-sol');
  const scheduled = turnParams('chat', 'input', { text: 'run', opts: { model: 'gpt-6-astra' } }, { model: null }, '/work', defaults);
  assert.equal(scheduled.model, 'gpt-6-astra');
});

test('Codex recommended defaults refresh without restarting the app-server', async () => {
  let at = 1_000;
  let recommended = 'gpt-6.1-sol';
  const requests: string[] = [];
  const owner: any = {
    now: () => at,
    request: async (method: string) => {
      requests.push(method);
      return method === 'config/read' ? { config: { model: 'gpt-6.1-sol' } } : { data: [{ model: recommended, isDefault: true }] };
    },
  };
  const read = () => CodexTurns.prototype.defaults.call(owner);
  assert.equal((await read()).defaultModel, 'gpt-6.1-sol');
  recommended = 'gpt-6.2-sol';
  assert.equal((await read()).defaultModel, 'gpt-6.1-sol');
  at += 60_000;
  assert.equal((await read()).defaultModel, 'gpt-6.2-sol');
  assert.equal(requests.filter((m) => m === 'model/list').length, 2);
});

test('Codex refreshes coalesce while pending, retain a good recommendation on failure, and recover on retry or clock rollback', async () => {
  let at = 1_000;
  let listing: () => Promise<any> = async () => ({ data: [{ model: 'new', isDefault: true }] });
  const owner: any = {
    now: () => at,
    request: (method: string) => (method === 'config/read' ? Promise.resolve({ config: { model: 'old' } }) : listing()),
  };
  const read = () => CodexTurns.prototype.defaults.call(owner);
  await read();
  at += 30_000;
  const wait = deferred<any>();
  listing = () => wait.promise;
  const pending = read();
  at += 60_000;
  assert.equal(read(), pending, 'expiration never creates a competing read');
  wait.reject(new Error('offline'));
  assert.equal((await pending).defaultModel, 'new', 'a failed refresh cannot silently downgrade to the old CLI pin');
  listing = async () => ({ data: [{ model: 'newer', isDefault: true }] });
  assert.equal((await read()).defaultModel, 'newer', 'failure leaves the next attempt retryable');
  at -= 60_000;
  listing = async () => ({ data: [{ model: 'newest', isDefault: true }] });
  assert.equal((await read()).defaultModel, 'newest');
});

test('a failed first Codex catalog read is retryable and retired reads cannot clear a replacement', async () => {
  const wait = deferred<any>();
  const owner: any = { now: () => 1_000, request: () => wait.promise };
  const pending = CodexTurns.prototype.defaults.call(owner);
  const replacement = Promise.resolve({ defaultModel: 'replacement' });
  owner.defaultsP = replacement;
  wait.reject(new Error('retired'));
  await pending;
  assert.equal(owner.defaultsP, replacement);
  owner.defaultsP = null;
  owner.request = async () => {
    throw new Error('offline');
  };
  assert.deepEqual(await CodexTurns.prototype.defaults.call(owner), { model: null, effort: null, defaultModel: null, inputs: {} });
  assert.equal(owner.defaultsP, null);
  owner.request = async (method: string) =>
    method === 'model/list'
      ? { data: [{ model: 'current', isDefault: true, inputModalities: ['image'] }] }
      : { config: { model_reasoning_effort: 'high' } };
  assert.equal((await CodexTurns.prototype.defaults.call(owner)).defaultModel, 'current');
});

test('a model-picker refresh invalidates old Codex defaults while an older completion cannot retire a replacement', async () => {
  for (const replace of [false, true]) {
    const wait = deferred<any>();
    const previous = Promise.resolve({ defaultModel: 'old' });
    const replacement = Promise.resolve({ defaultModel: 'new' });
    const owner: any = { defaultsP: previous, request: () => wait.promise };
    const reading = CodexApi.prototype.modelList.call(owner);
    if (replace) owner.defaultsP = replacement;
    wait.resolve({ data: [] });
    await reading;
    assert.equal(owner.defaultsP, replace ? replacement : null);
  }
});

test('a successful picker catalog survives an execution refresh failure, even before any turn has read defaults', async () => {
  for (const firstTurn of [false, true]) {
    let recommended = 'new';
    let offline = false;
    const owner: any = {
      now: () => 1_000,
      request: async (method: string) => {
        if (method === 'config/read') return { config: { model: 'old' } };
        if (offline) throw new Error('offline after picker read');
        return { data: [{ model: recommended, isDefault: true, inputModalities: ['image'] }] };
      },
    };
    if (!firstTurn) await CodexTurns.prototype.defaults.call(owner);
    recommended = 'newer';
    await CodexApi.prototype.modelList.call(owner);
    offline = true;
    const result = await CodexTurns.prototype.defaults.call(owner);
    assert.equal(result.defaultModel, 'newer');
    assert.deepEqual(result.inputs.newer, ['image']);
  }
});

test('concurrent picker reads publish only the latest request and cannot retire a newer capability read', async () => {
  for (const order of ['old-first', 'new-first', 'old-rejects'] as const) {
    const old = deferred<any>();
    const fresh = deferred<any>();
    const info = Promise.resolve({ models: [] });
    const owner: any = { defaultsP: null, infoP: info, request: () => old.promise };
    const older = CodexApi.prototype.modelList.call(owner);
    owner.request = () => fresh.promise;
    const newer = CodexApi.prototype.modelList.call(owner);
    const latest = { data: [{ model: 'latest', isDefault: true }] };
    if (order === 'old-first') {
      old.resolve({ data: [{ model: 'obsolete', isDefault: true }] });
      await older;
      assert.equal(owner.defaultsGood, undefined, 'an old success cannot publish while its replacement is pending');
    } else if (order === 'old-rejects') {
      old.reject(new Error('obsolete failure'));
      await assert.rejects(older, /obsolete failure/);
    }
    const replacementInfo = Promise.resolve({ models: latest.data });
    if (order === 'new-first') owner.infoP = replacementInfo;
    fresh.resolve(latest);
    await newer;
    assert.equal(owner.infoP, order === 'new-first' ? replacementInfo : null);
    if (order === 'new-first') {
      old.resolve({ data: [{ model: 'obsolete', isDefault: true }] });
      await older;
    }
    assert.equal(owner.defaultsGood.defaultModel, 'latest');
  }
});

test('a picker completion from a retired native process cannot publish to its replacement', async () => {
  const pending = deferred<any>();
  const owner: any = { defaultsP: null, request: () => pending.promise };
  const read = CodexApi.prototype.modelList.call(owner);
  owner.modelListP = null;
  pending.resolve({ data: [{ model: 'retired', isDefault: true }] });
  await read;
  assert.equal(owner.defaultsGood, undefined);
});

test('partial native read failures retain successful catalog and config fields independently', async () => {
  let failConfig = true;
  let failModels = false;
  let at = 1_000;
  const owner: any = {
    now: () => at,
    request: async (method: string) => {
      if ((method === 'config/read' && failConfig) || (method === 'model/list' && failModels)) throw new Error('offline');
      return method === 'config/read'
        ? { config: { model: 'old', model_reasoning_effort: 'high' } }
        : { data: [{ model: 'new', isDefault: true }] };
    },
  };
  const read = () => CodexTurns.prototype.defaults.call(owner);
  assert.equal((await read()).defaultModel, 'new');
  failConfig = false;
  failModels = true;
  const second = await read();
  assert.deepEqual([second.model, second.defaultModel, second.effort], ['old', 'new', 'high']);
  failConfig = true;
  failModels = false;
  assert.equal((await read()).effort, 'high', 'a successful config read survives a later config-only failure');
  failConfig = false;
  await read();
  at += 30_000;
  failConfig = true;
  failModels = true;
  assert.deepEqual(await read(), owner.defaultsGood, 'an outage of both inputs preserves the independently learned fields');
});

test('Claude automatic selection ignores the last runtime model and uses its current recommendation', () => {
  const models = [
    { value: 'default', resolvedModel: 'claude-sonnet-new' },
    { value: 'opus', resolvedModel: 'claude-opus-new', supportsAutoMode: true },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-new', supportsAutoMode: true },
  ];
  let saved: any = { model: null, effort: 'high' };
  const adapter: any = {
    prefs: () => ({ claudeSelection: { model: 'old-default', effort: 'low' } }),
    accountOf: () => 'account',
    savedSettings: () => saved,
    own: new Map([['chat', { model: 'claude-opus-old', effort: 'high' }]]),
    pinnedModel: () => null,
    pinnedEffort: () => null,
    probeInfo: () => ({ models }),
  };
  assert.equal(claudeTurnSettings(adapter, 'chat', {}).model, 'sonnet');
  assert.equal(claudeTurnSettings(adapter, 'chat', { model: 'opus' }).model, 'opus');
  saved = { model: 'sonnet', effort: 'high' };
  adapter.own.clear();
  assert.equal(claudeTurnSettings(adapter, 'chat', {}).model, 'sonnet');
});

test('a Claude runtime receipt cannot replace a durable automatic choice in the window-to-main sync', () => {
  const own = claudeOwnOf(
    {
      runtime: { chat: { settings: { model: 'opus', effort: 'high' } } },
      chatConfig: { chat: { model: null, effort: 'medium' } },
      claudeChats: {},
      claude: { models: [{ id: 'opus' }] },
    },
    'chat',
  );
  assert.deepEqual(own, { model: null, effort: 'medium', account: null });
});

test('a legacy Claude native choice is preserved until the user establishes Automatic intent', () => {
  const state: any = {
    runtime: { chat: { settings: { model: 'old', effort: 'high' } } },
    chatConfig: {},
    claudeChats: {},
    claude: { models: [{ id: 'old' }, { id: 'new' }] },
  };
  assert.deepEqual(claudeOwnOf(state, 'chat'), { model: 'old', effort: 'high', account: null });
  state.chatConfig.chat = { model: null };
  assert.deepEqual(claudeOwnOf(state, 'chat'), { model: null, effort: 'high', account: null });
});

test('a known Claude runtime clear stays distinct from an unread model and a stale receipt over saved Automatic', () => {
  const state: any = {
    runtime: { chat: { settings: { model: null } } },
    chatConfig: { chat: { model: 'old', effort: 'high' } },
    claudeChats: {},
    claude: { models: [{ id: 'old' }, { id: 'new' }] },
  };
  assert.deepEqual(claudeOwnOf(state, 'chat'), { model: null, effort: null, account: null }, 'a known clear is never an old version pin');
  state.runtime = {};
  assert.deepEqual(claudeOwnOf(state, 'chat'), { model: 'old', effort: 'high', account: null }, 'unread runtime uses the saved choice');
  state.chatConfig.chat = { model: null };
  state.runtime = { chat: { settings: { model: 'new' } } };
  assert.deepEqual(
    claudeOwnOf(state, 'chat'),
    { model: null, effort: null, account: null },
    'a later receipt cannot pin durable Automatic',
  );
});

test('a MoMo brain with no loaded runtime keeps its explicit model without borrowing an unrelated effort', () => {
  const state: any = {
    runtime: {},
    chatConfig: {},
    claudeChats: {},
    claude: { models: [{ id: 'brain' }] },
    momoModels: { chat: 'brain' },
  };
  assert.deepEqual(claudeOwnOf(state, 'chat'), { model: 'brain', effort: null, account: null });
  state.momoModels = {};
  state.chatConfig.chat = { model: null };
  assert.deepEqual(claudeOwnOf(state, 'chat'), { model: null, effort: null, account: null });
});

test('keeping a Claude turn retains Automatic intent, including a scheduled one-turn model override', () => {
  const saved: any[] = [];
  const automatic = { model: 'recommended', selectionModel: null, effort: 'high' };
  const adapter = { settings: () => automatic, keepSelection: (_id: string, settings: any) => saved.push(settings) };
  keepTurnSelection(adapter, 'chat', {}, automatic);
  keepTurnSelection(adapter, 'chat', { model: 'scheduled' }, { model: 'scheduled', selectionModel: 'scheduled' });
  assert.deepEqual(saved, [
    { model: null, effort: 'high' },
    { model: null, effort: 'high' },
  ]);
});

test('ACP automatic chats retain the native recommendation across reopened sessions without recording a model pin', async () => {
  const requests: unknown[] = [];
  const records: unknown[] = [];
  const host = {
    assertChatCurrent() {},
    now: () => 0,
    items: { readAsync: async () => records, append: (_key: string, record: unknown) => records.push(record) },
  };
  for (const model of ['provider/previous', 'provider/current']) {
    const chat = {
      key: 'acp:agent:chat',
      sessionId: model,
      state: { configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: model, options: [{ value: model }] }] },
      agent: { request: async (...args: unknown[]) => requests.push(args) },
    };
    assert.deepEqual(await applySettings(host, chat, {}), []);
    assert.equal(chat.state.configOptions[0].currentValue, model);
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(records, []);
});
