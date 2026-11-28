// electron/app/sessionSettings.cjs for Auto: the models each harness offers Auto (catalogOf) and the chat's saved mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionSettings } = require('../electron/app/sessionSettings.cjs');

function setup(o: { kinds?: Record<string, string>; acp?: any; config?: any } = {}) {
  const kinds: Record<string, string> = { cx: 'codex', cl: 'claude', ap: 'acp:kimi', ...o.kinds };
  const configs = new Map<string, any>([['cx', o.config ?? {}]]);
  const probe = {
    models: [
      { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high'] },
      { value: 'haiku', displayName: 'Haiku', supportedEffortLevels: [] },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportedEffortLevels: ['low'] },
    ],
  };
  const live: any = {
    controller: { ref: (id: string) => ({ kind: kinds[id], key: `key-${id}` }), state: { get: () => ({ acp: o.acp ?? null }) } },
    chats: {
      records: { get: (id: string) => ({ meta: { config: configs.get(id) ?? {} } }) },
      patchMeta: (id: string, patch: any) => (configs.set(id, patch.config), true),
    },
    codex: {
      modelList: async () => ({
        data: [
          { model: 'gpt-5', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
          { model: 'gpt-bare' },
          { model: 'secret', hidden: true },
        ],
      }),
    },
    claudeTurns: { probeInfo: () => probe, accountOf: () => 'acct' },
  };
  return { settings: createSessionSettings({ live, prefs: () => ({}) }), configs };
}

const select = (category: string, values: string[]) => ({
  id: category,
  category,
  type: 'select',
  currentValue: values[0],
  options: values.map((value) => ({ value })),
});

test('catalogOf lists the models Auto can choose between, with each one’s effort levels', async () => {
  const s = setup({ acp: { configOptions: [select('model', ['k2', 'k3']), select('thought_level', ['low', 'deep'])] } });
  assert.deepEqual(await s.settings.catalogOf('cx'), [
    { id: 'gpt-5', efforts: ['low', 'high'] },
    { id: 'gpt-bare', efforts: [] },
  ]);
  // Claude: aliases with the model each resolves to; pinned versions under More versions are left out
  const claude = [
    { id: 'opus', efforts: ['low', 'high'], resolved: 'claude-opus-5-5' },
    { id: 'haiku', efforts: [] },
  ];
  assert.deepEqual(await s.settings.catalogOf('cl'), claude);
  assert.deepEqual(await s.settings.catalogOf('cx', 'claude'), claude);
  assert.deepEqual(await s.settings.catalogOf('ap'), [
    { id: 'k2', efforts: ['low', 'deep'] },
    { id: 'k3', efforts: ['low', 'deep'] },
  ]);
  // an agent the chat is not running lists nothing yet; one without a model option lists nothing; no levels, no efforts
  assert.deepEqual(await s.settings.catalogOf('cx', 'acp:kimi'), []);
  assert.deepEqual(await setup({ acp: { configOptions: [] } }).settings.catalogOf('ap'), []);
  assert.deepEqual(await setup({ acp: { configOptions: [select('model', ['k2'])] } }).settings.catalogOf('ap'), [
    { id: 'k2', efforts: [] },
  ]);
});

test('Auto’s mode is saved in the chat’s config, and an unknown one is refused', () => {
  const s = setup({ config: { model: 'gpt-5' } });
  assert.equal(s.settings.autoModeOf('cx'), null);
  assert.deepEqual(s.settings.setAutoMode('cx', 'global'), { auto: 'global' });
  assert.deepEqual(s.configs.get('cx'), { model: 'gpt-5', autoRoute: 'global' });
  assert.equal(s.settings.autoModeOf('cx'), 'global');
  s.settings.setAutoMode('cx', null);
  assert.equal(s.settings.autoModeOf('cx'), null);
  assert.throws(
    () => s.settings.setAutoMode('cx', 'turbo' as any),
    (e: any) => e.code === 'invalid_mode',
  );
});
