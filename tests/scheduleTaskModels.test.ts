// The Scheduled dialog's model list per harness (src/lib/scheduleTask.ts modelsFor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelsFor } from '../src/lib/scheduleTask.ts';

const label = (n: string) => `<${n}>`;

test('codex models start at the user default, else the first, else the configured name', () => {
  const codexModels = [
    { model: 'a', displayName: 'A', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    { model: 'b', displayName: 'B' },
  ];
  assert.deepEqual(modelsFor('codex', { codexModels, claudeModels: [], codexModel: 'b', codexEffort: 'high' }, label), {
    picks: [
      { id: 'a', label: '<A>', efforts: ['low'] },
      { id: 'b', label: '<B>', efforts: [] },
    ],
    model: 'b',
    effort: 'high',
  });
  assert.deepEqual(modelsFor('codex', { codexModels, claudeModels: [], codexModel: 'gone' }, label).model, 'a');
  assert.deepEqual(modelsFor('codex', { codexModels: [], claudeModels: [], codexModel: 'gone' }, label), {
    picks: [],
    model: 'gone',
    effort: 'medium',
  });
  assert.equal(modelsFor('codex', { codexModels: [], claudeModels: [] }, label).model, '');
});

test('claude models start at the default model and its effort, else the first, else nothing', () => {
  const claudeModels = [
    { id: 'opus', label: 'Opus', efforts: ['high'] },
    { id: 'sonnet', label: 'Sonnet', efforts: [], isDefault: true, defaultEffort: 'medium' },
  ];
  assert.deepEqual(modelsFor('claude', { codexModels: [], claudeModels }, label), {
    picks: [
      { id: 'opus', label: 'Opus', efforts: ['high'] },
      { id: 'sonnet', label: 'Sonnet', efforts: [] },
    ],
    model: 'sonnet',
    effort: 'medium',
  });
  assert.deepEqual(modelsFor('claude', { codexModels: [], claudeModels: [claudeModels[0]] }, label).effort, '');
  assert.deepEqual(modelsFor('claude', { codexModels: [], claudeModels: [] }, label), { picks: [], model: '', effort: '' });
});

const opencode = {
  id: 'opencode',
  catalog: {
    modes: null,
    configOptions: [
      {
        id: 'mode',
        name: 'Mode',
        type: 'select' as const,
        category: 'mode' as const,
        currentValue: 'build',
        options: [{ value: 'build', name: 'Build' }],
      },
      {
        id: 'model',
        name: 'Model',
        type: 'select' as const,
        category: 'model' as const,
        currentValue: 'opencode/big-pickle',
        options: [
          {
            group: 'zen',
            name: 'Zen',
            options: [
              { value: 'opencode/big-pickle', name: 'Big Pickle' },
              { value: 'opencode/glm-5.3-flash-free', name: 'GLM-5.3 Flash Free' },
            ],
          },
        ],
      },
      {
        id: 'effort',
        name: 'Thinking',
        type: 'select' as const,
        category: 'thought_level' as const,
        currentValue: 'low',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    ],
  },
};

test('a basic harness offers the models and thought levels its catalog declares, on the new-chat defaults', () => {
  const s = { codexModels: [], claudeModels: [], basics: [opencode] };
  const efforts = ['low', 'high'];
  const effortNames = { low: 'Low', high: 'High' };
  assert.deepEqual(modelsFor('acp:opencode', s, label), {
    picks: [
      { id: 'opencode/big-pickle', label: 'Big Pickle', efforts, effortNames },
      { id: 'opencode/glm-5.3-flash-free', label: 'GLM-5.3 Flash Free', efforts, effortNames },
    ],
    model: 'opencode/big-pickle',
    effort: 'low',
  });
  // the defaults new chats on it start with win over the agent's own values
  const chosen = modelsFor(
    'acp:opencode',
    { ...s, basicDefaults: { opencode: { config: { model: 'opencode/glm-5.3-flash-free', effort: 'high' } } } },
    label,
  );
  assert.equal(chosen.model, 'opencode/glm-5.3-flash-free');
  assert.equal(chosen.effort, 'high');
  // a default it no longer offers falls back to its first value
  assert.equal(
    modelsFor('acp:opencode', { ...s, basicDefaults: { opencode: { config: { model: 'gone' } } } }, label).model,
    'opencode/big-pickle',
  );
});

test('a basic harness with no model option, no thought levels, or no catalog yet', () => {
  const noThinking = { id: 'opencode', catalog: { modes: null, configOptions: opencode.catalog.configOptions.slice(0, 2) } };
  const r = modelsFor('acp:opencode', { codexModels: [], claudeModels: [], basics: [noThinking] }, label);
  assert.equal(r.effort, '');
  assert.deepEqual(r.picks[0].efforts, []);
  const none = { picks: [], model: '', effort: '' };
  const noModel = { id: 'opencode', catalog: { modes: null, configOptions: opencode.catalog.configOptions.slice(0, 1) } };
  assert.deepEqual(modelsFor('acp:opencode', { codexModels: [], claudeModels: [], basics: [noModel] }, label), none);
  assert.deepEqual(
    modelsFor('acp:opencode', { codexModels: [], claudeModels: [], basics: [{ id: 'opencode', catalog: null }] }, label),
    none,
  );
  assert.deepEqual(modelsFor('acp:kimi', { codexModels: [], claudeModels: [], basics: [opencode] }, label), none);
  // a harness value that names no basic harness offers nothing either
  assert.deepEqual(modelsFor('opencode' as never, { codexModels: [], claudeModels: [], basics: [opencode] }, label), none);
  assert.deepEqual(modelsFor('acp:opencode', { codexModels: [{ model: 'a', displayName: 'A' }], claudeModels: [] }, label), none);
  // an option without a name shows its value
  const bare = {
    id: 'x',
    catalog: {
      modes: null,
      configOptions: [
        {
          id: 'm',
          name: 'M',
          type: 'select' as const,
          category: 'model' as const,
          currentValue: null,
          options: [{ value: 'v1', name: '' }],
        },
      ],
    },
  };
  assert.deepEqual(modelsFor('acp:x', { codexModels: [], claudeModels: [], basics: [bare] }, label).picks[0].label, 'v1');
});
