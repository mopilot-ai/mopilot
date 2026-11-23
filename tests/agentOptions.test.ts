// The one shape of an agent's model options (shared/host/agentOptions.mjs, #4935): the default-effort rule, the resolved name read from what Claude Code reports, and the validator for what a Host sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeResolvedName, defaultEffort, optionFields, RESOLVED_ID_MAX, RESOLVED_MAX } from '../shared/host/agentOptions.mjs';

test("A/B: the default effort is the agent's own when it is a level, else high, else the first, else none", () => {
  assert.equal(defaultEffort(['low', 'medium'], 'medium'), 'medium');
  assert.equal(defaultEffort(['low', 'high', 'max'], 'xhigh'), 'high', 'a level the model lacks is not its default');
  assert.equal(defaultEffort(['low', 'high']), 'high');
  assert.equal(defaultEffort(['low', 'medium']), 'low');
  assert.equal(defaultEffort(['', 7, 'max']), 'max');
  assert.equal(defaultEffort([], 'high'), null);
  assert.equal(defaultEffort(undefined), null);
});

test('the resolved name is the version in the description, the one a default names, or the pinned id; never an alias', () => {
  assert.equal(claudeResolvedName({ value: 'opus', description: 'Opus 5.5 · Best' }), 'Opus 5.5');
  assert.equal(claudeResolvedName({ value: 'default', description: 'Use the default model (currently Fable 5.2) · x' }), 'Fable 5.2');
  assert.equal(
    claudeResolvedName({ value: 'default', description: 'Use the default model (currently opus) · x' }),
    null,
    'an alias is no name',
  );
  assert.equal(claudeResolvedName({ value: 'opus', description: 'Opus 5.5.1 beta' }), 'Opus 5.5.1');
  assert.equal(claudeResolvedName({ value: 'x', description: 'Opus 5.5x' }), null);
  assert.equal(claudeResolvedName({ value: 'x', resolvedId: 'claude-opus-5-5' }), 'Opus 5.5');
  assert.equal(claudeResolvedName({ value: 'x', resolvedId: 'claude-sonnet-5' }), 'Sonnet 5');
  assert.equal(claudeResolvedName({ value: 'x', resolvedId: 'claude-haiku-4-5-20251001' }), 'Haiku 4.5');
  assert.equal(claudeResolvedName({ value: 'x', resolvedId: 'something-else', description: 7 }), null);
  assert.equal(claudeResolvedName({ value: 'opus[1m]', description: 'Opus 5.5 · Long' }), 'Opus 5.5 1M');
  assert.equal(claudeResolvedName({ value: 'opus[1m]', description: 'Opus 5.5 1M · Long' }), 'Opus 5.5 1M', 'the CLI already says 1M');
  assert.equal(claudeResolvedName({}), null);
});

test('W: a resolved name over the limit, equal to the id or to a bare alias, an effort outside the levels and a non-boolean fast flag are dropped', () => {
  const ok = optionFields(
    { id: 'opus', resolvedModel: ' Opus 5.5 ', resolvedId: ' claude-opus-5-5 ', defaultEffort: 'low', supportsFastMode: false },
    ['low'],
  );
  assert.deepEqual(ok, { resolvedModel: 'Opus 5.5', resolvedId: 'claude-opus-5-5', defaultEffort: 'low', supportsFastMode: false });
  assert.deepEqual(optionFields({ id: 'opus', resolvedModel: 'x'.repeat(RESOLVED_MAX + 1) }, []), {});
  assert.equal(optionFields({ id: 'opus', resolvedModel: 'x'.repeat(RESOLVED_MAX) }, []).resolvedModel?.length, RESOLVED_MAX);
  assert.deepEqual(optionFields({ id: 'opus', resolvedModel: 'opus' }, []), {});
  assert.deepEqual(optionFields({ id: 'opus', resolvedModel: 'Opus' }, []), {});
  assert.equal(
    optionFields({ id: 'gpt-5.6', resolvedModel: 'GPT-5.6' }, []).resolvedModel,
    'GPT-5.6',
    'a name with a version is a name even when it differs only in case',
  );
  assert.deepEqual(
    optionFields({ id: 'a', resolvedId: 'y'.repeat(RESOLVED_ID_MAX + 1), supportsFastMode: 1, defaultEffort: 'high' }, ['low']),
    {},
  );
  assert.deepEqual(optionFields({ id: 'a', resolvedModel: 5, resolvedId: '  ' }, []), {});
});

test('W: supportsAutoMode is kept only as a boolean, false included; anything else is not reported', () => {
  assert.deepEqual(optionFields({ id: 'a', supportsAutoMode: false }, []), { supportsAutoMode: false });
  assert.deepEqual(optionFields({ id: 'a', supportsAutoMode: true }, []), { supportsAutoMode: true });
  assert.deepEqual(optionFields({ id: 'a', supportsAutoMode: 'no' }, []), {});
  assert.deepEqual(optionFields({ id: 'a' }, []), {});
});
