// Auto's shared vocabulary: saved modes, cost tiers, effort mapping and the model ladder every harness's tiers climb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoModeOf, costTierOf, effortFor, sizeClass, versionOf, compareVersions, modelLadder, tierModels } from '../shared/autoRoute.mjs';

test('a saved Auto mode is read only when it is one Auto knows', () => {
  assert.equal(autoModeOf({ autoRoute: 'harness' }), 'harness');
  assert.equal(autoModeOf({ autoRoute: 'global' }), 'global');
  assert.equal(autoModeOf({ autoRoute: 'turbo' }), null);
  assert.equal(autoModeOf({}), null);
  assert.equal(autoModeOf(null), null);
  assert.equal(autoModeOf(undefined), null);
});

test('the cost tier defaults to medium', () => {
  assert.equal(costTierOf({ autoRouteCost: 'low' }), 'low');
  assert.equal(costTierOf({ autoRouteCost: 'high' }), 'high');
  assert.equal(costTierOf({ autoRouteCost: 'medium' }), 'medium');
  assert.equal(costTierOf({ autoRouteCost: 'free' }), 'medium');
  assert.equal(costTierOf(null), 'medium');
});

test('a thinking level becomes the nearest offered effort, ties going up', () => {
  assert.equal(effortFor('T0', ['none', 'low', 'medium', 'high']), 'none');
  assert.equal(effortFor('T0', ['low', 'medium', 'high']), 'low');
  assert.equal(effortFor('T1', ['minimal', 'medium']), 'medium');
  assert.equal(effortFor('T2', ['low', 'medium', 'high', 'xhigh']), 'medium');
  assert.equal(effortFor('T3', ['low', 'medium', 'high', 'max']), 'high');
  assert.equal(effortFor('T3', ['low', 'medium', 'xhigh']), 'xhigh');
  // an unknown mode asks for medium; levels off the scale are ignored
  assert.equal(effortFor('T9', ['low', 'medium']), 'medium');
  assert.equal(effortFor('T2', ['fast', 'deep']), null);
  assert.equal(effortFor('T2', []), null);
  assert.equal(effortFor('T2', undefined as any), null);
});

test('a model id ranks by its size words, standard when none match', () => {
  assert.equal(sizeClass('gpt-5.4-nano'), 0);
  assert.equal(sizeClass('gemini-3.1-flash-lite'), 0);
  assert.equal(sizeClass('claude-haiku-5-5'), 1);
  assert.equal(sizeClass('gpt-5.4-mini'), 1);
  assert.equal(sizeClass('gemini-3-flash'), 1);
  assert.equal(sizeClass('claude-sonnet-5-5'), 2);
  assert.equal(sizeClass('gpt-5.5'), 2);
  assert.equal(sizeClass('claude-opus-5-5'), 3);
  assert.equal(sizeClass('gemini-3.1-pro'), 3);
  assert.equal(sizeClass('claude-fable-5-2'), 4);
  assert.equal(sizeClass('claude-mythos-1'), 5);
  // a size word inside another word is not one
  assert.equal(sizeClass('gemini-3'), 2);
  assert.equal(sizeClass('minimax-m2.7'), 2);
  assert.equal(sizeClass(undefined as any), 2);
});

test('a version is the id’s numbers, without a release date or variant', () => {
  assert.deepEqual(versionOf('claude-opus-4-8'), [4, 8]);
  assert.deepEqual(versionOf('gpt-5.4-mini'), [5, 4]);
  assert.deepEqual(versionOf('claude-3-5-haiku-20241022'), [3, 5]);
  assert.deepEqual(versionOf('opus[1m]'), []);
  assert.deepEqual(versionOf(null as any), []);
  assert.ok(compareVersions([5, 5], [5, 4]) > 0);
  assert.ok(compareVersions([5], [5, 1]) < 0);
  assert.equal(compareVersions([5, 0], [5]), 0);
});

test('the ladder keeps the newest model of each size class, cheapest first', () => {
  assert.deepEqual(
    modelLadder(['claude-opus-4-8', 'claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', '', 7 as any]),
    ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  );
  assert.deepEqual(modelLadder(['gpt-5.5', 'gpt-5.4']), ['gpt-5.5']);
  assert.deepEqual(modelLadder(undefined as any), []);
});

test('tiers spread over the ladder, and a listed user pick wins', () => {
  const claude = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'];
  assert.deepEqual(tierModels(claude), { C0: claude[0], C1: claude[1], C2: claude[2], C3: claude[3] });
  assert.deepEqual(tierModels(claude.slice(0, 3)), { C0: claude[0], C1: claude[1], C2: claude[2], C3: claude[2] });
  assert.deepEqual(tierModels(['gpt-5.5-mini', 'gpt-5.5']), { C0: 'gpt-5.5-mini', C1: 'gpt-5.5-mini', C2: 'gpt-5.5', C3: 'gpt-5.5' });
  assert.deepEqual(tierModels(['gpt-5.5']), { C0: 'gpt-5.5', C1: 'gpt-5.5', C2: 'gpt-5.5', C3: 'gpt-5.5' });
  assert.equal(tierModels([]), null);
  assert.deepEqual(tierModels(claude, { C3: 'claude-opus-5-5', C0: 'claude-not-listed', C1: 7 as any })!.C3, 'claude-opus-5-5');
  assert.equal(tierModels(claude, { C0: 'claude-not-listed' })!.C0, claude[0]);
  assert.equal(tierModels(claude, null)!.C0, claude[0]);
});

test('on Claude Code the ladder climbs the aliases by what they resolve to, never older pinned versions', async () => {
  const { claudeModels } = await import('../shared/claudeModels.mjs');
  const row = (value: string, resolvedModel: string) => ({
    value,
    displayName: value,
    description: '',
    resolvedModel,
    supportedEffortLevels: ['low', 'high'],
  });
  const probe = [
    { value: 'default', displayName: 'Default', description: '', resolvedModel: 'claude-opus-5-5' },
    row('opus', 'claude-opus-5-5'),
    row('opus[1m]', 'claude-opus-5-5[1m]'),
    row('opusplan', 'claude-opus-5-5'),
    row('sonnet', 'claude-sonnet-5-5'),
    row('sonnet[1m]', 'claude-sonnet-5-5[1m]'),
    row('haiku', 'claude-haiku-5-5'),
    row('claude-opus-4-8', 'claude-opus-4-8'),
    row('claude-sonnet-4-5', 'claude-sonnet-4-5'),
    row('claude-haiku-4-5', 'claude-haiku-4-5'),
  ];
  const listed = claudeModels(probe);
  const expected = { C0: 'haiku', C1: 'sonnet', C2: 'opus', C3: 'opus' };
  // with the pinned versions the menu folds under More versions, and without them (main's catalogOf leaves them out)
  assert.deepEqual(tierModels(listed), expected);
  assert.deepEqual(tierModels(listed.filter((m: any) => !m.more)), expected);
  assert.deepEqual(modelLadder([{ id: 'x' } as any, { id: '' } as any, null as any]), ['x']);
});
