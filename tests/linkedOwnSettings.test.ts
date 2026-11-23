// Renderer synchronization keeps persisted linked-chat selections and ignores failures from superseded settings sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnSettingsSync } from '../src/harness/claude/ownSettings.ts';

test('a saved config is sent before the chat opens, later runtime choices win, and unchanged selections coalesce', async () => {
  const calls: any[] = [];
  const sync = createOwnSettingsSync({
    familyOf: (id) => (id === 'other' ? 'codex' : 'claude'),
    send: async (...a) => {
      calls.push(a);
    },
  });
  const state: any = {
    runtime: {},
    chatConfig: { child: { model: 'sonnet', effort: 'low' }, other: { model: 'gpt' } },
    claudeChats: {},
    claude: { models: [{ id: 'sonnet' }, { id: 'opus' }] },
  };
  sync(state);
  assert.deepEqual(calls.slice(), [['child', { model: 'sonnet', effort: 'low', account: null }]]);
  sync(state);
  assert.equal(calls.length, 1);
  state.runtime.child = { settings: { model: 'opus', effort: null } };
  state.claudeChats.child = { id: 'parent-login' };
  sync(state);
  assert.deepEqual(calls.at(-1), ['child', { model: 'opus', effort: null, account: 'parent-login' }]);
  state.runtime.child = {};
  state.chatConfig.child = { model: 'unlisted' };
  sync(state);
  assert.equal(calls.at(-1)[1].model, null);
  state.chatConfig = {};
  state.runtime = { empty: {} };
  state.claudeChats = {};
  sync(state);
  assert.deepEqual(calls.at(-1), ['empty', { account: null }], 'unread settings cannot clear main-owned model choices');
});

test('a failed current send retries; an older rejection cannot clear a newer successful send receipt', async () => {
  const calls: any[] = [];
  const rejects: ((e: Error) => void)[] = [];
  const sync = createOwnSettingsSync({
    familyOf: () => 'claude',
    send: (...a) => {
      calls.push(a);
      return new Promise((_resolve, reject) => rejects.push(reject));
    },
  });
  const state: any = {
    runtime: {},
    chatConfig: { child: { model: 'sonnet' } },
    claudeChats: {},
    claude: { models: [{ id: 'sonnet' }, { id: 'opus' }] },
  };
  sync(state);
  rejects[0](new Error('failed'));
  await Promise.resolve();
  sync(state);
  assert.equal(calls.length, 2);
  state.chatConfig.child.model = 'opus';
  sync(state);
  rejects[1](new Error('retired'));
  await Promise.resolve();
  sync(state);
  assert.equal(calls.length, 3);
});
