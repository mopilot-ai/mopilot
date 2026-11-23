// Opening a durable linked chat hydrates its own saved selection before copied transcript defaults on the public Claude renderer path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, claude, claudeThreadId, baseNative, flush } from './support/claude-chat/fixture.ts';

test('a linked chat reopened from a copied transcript displays its saved model and effort, with independent per-field fallback', async () => {
  for (const [suffix, config, expected] of [
    ['both', { model: 'sonnet', effort: 'low' }, { model: 'sonnet', effort: 'low' }],
    ['model', { model: 'sonnet' }, { model: 'sonnet', effort: 'high' }],
    ['effort', { effort: 'low' }, { model: 'opus', effort: 'low' }],
  ] as const) {
    const id = claudeThreadId(`linked-hydration-${suffix}`);
    fx.state.threads[id] = { id, cwd: '/child' };
    fx.state.claude.models = [
      { id: 'opus', resolved: 'claude-opus-parent' },
      { id: 'sonnet', resolved: 'claude-sonnet-child' },
    ];
    fx.state.chatConfig[id] = config;
    fx.state.runtime[id] = { turns: [], settings: null };
    baseNative({ sessionSettings: async () => ({ model: 'claude-opus-parent', effort: 'high' }) });
    await claude.openClaudeThread(id);
    await flush();
    assert.deepEqual(fx.state.runtime[id].settings, expected);
  }
});
