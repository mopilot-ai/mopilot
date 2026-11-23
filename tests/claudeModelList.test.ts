// Claude Code's model list as the CLI reports it, made into the harness's models: names with versions, and which are "more".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeModels } from '../shared/claudeModels.mjs';

test('claudeModels: the CLI\'s list without "default", with efforts, fast and pinned versions', () => {
  const models = claudeModels([
    { value: 'default', displayName: 'Default' },
    {
      value: 'opus',
      displayName: 'Opus',
      description: 'best',
      supportedEffortLevels: ['low', 'high'],
      supportsFastMode: true,
      supportsAutoMode: true,
      resolvedModel: 'claude-opus-5-5',
    },
    { value: 'sonnet[1m]', displayName: 'Sonnet 1M', supportedEffortLevels: ['low', 'medium'] },
    { value: 'claude-opus-4-1', displayName: 'Opus 4.1' },
    { value: 'claude-haiku-4', displayName: 'Haiku 4' },
    // a family word inside another id segment is not that family
    { value: 'claude-opusplan-2', displayName: 'Opus Plan 2' },
  ] as any);
  assert.deepEqual(
    models.map((m) => [m.id, m.efforts, m.defaultEffort, m.fast, m.autoMode, m.isDefault, m.more]),
    [
      ['opus', ['low', 'high'], 'high', true, true, true, false],
      ['sonnet[1m]', ['low', 'medium'], 'low', false, false, false, false],
      // a pinned Opus while "opus" is listed: under More versions
      ['claude-opus-4-1', [], null, false, false, false, true],
      // no "haiku" alias listed: the pinned one is the only Haiku, so it stays in the main list
      ['claude-haiku-4', [], null, false, false, false, false],
      ['claude-opusplan-2', [], null, false, false, false, false],
    ],
  );
  assert.equal(models[0].resolved, 'claude-opus-5-5');
});

test("claudeModels: a 1M-context variant carries 1M after its name, as Claude's own menu shows it, once", () => {
  const models = claudeModels([
    { value: 'opus[1m]', displayName: 'Opus', description: 'Opus 5.5 · For long sessions' },
    // the CLI already names the window: not "1M 1M"
    { value: 'sonnet[1m]', displayName: 'Sonnet 1M' },
    { value: 'haiku[1m]', displayName: 'Haiku (1M context)' },
    { value: 'sonnet', displayName: 'Sonnet' },
  ] as any);
  assert.deepEqual(
    models.map((m) => m.label),
    ['Opus 5.5 1M', 'Sonnet 1M', 'Haiku (1M context)', 'Sonnet'],
  );
});

test("claudeModels: names carry the version the description leads with, as Claude's own menu shows them", () => {
  const models = claudeModels([
    { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
    { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest tasks' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5' },
    // the description does not lead with a version of this name: both kept as the CLI gives them
    { value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers' },
    { value: 'opusplan', displayName: 'Opus Plan', description: 'Opus Plan mode · Opus plans, Sonnet builds' },
    { value: 'best', displayName: 'Best' },
  ] as any);
  assert.deepEqual(
    models.map((m) => [m.label, m.description, m.more]),
    [
      ['Opus 5.5', 'Best for everyday, complex tasks', false],
      // the only Fable is pinned, so it is a main model (Claude's menu lists Fable 5.1 beside Opus)
      ['Fable 5.1 1M', 'Most capable for your hardest tasks', false],
      ['Sonnet 5.5', undefined, false],
      ['Haiku', 'Fastest for quick answers', false],
      ['Opus Plan', 'Opus Plan mode · Opus plans, Sonnet builds', false],
      ['Best', undefined, false],
    ],
  );
});
