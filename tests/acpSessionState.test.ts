// ACP state reducers retain source-owned settings across replay and reject malformed optional updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { acpStateUpdate } from '../shared/acpSessionState.mjs';
const require = createRequire(import.meta.url);
const { recordSessionUpdate } = require('../electron/harness/acp/sessionUpdates.cjs');

test('optional or malformed state updates do not invent options, commands or usage', () => {
  assert.equal(acpStateUpdate(null, null), null);
  assert.deepEqual(acpStateUpdate(null, { sessionUpdate: 'available_commands_update' }).commands, []);
  assert.equal(acpStateUpdate(null, { sessionUpdate: 'config_option_update', configOptions: {} }), null);
  assert.deepEqual(acpStateUpdate(null, { sessionUpdate: 'usage_update' }).usage, { used: null, size: null });
  assert.deepEqual(acpStateUpdate(null, { sessionUpdate: 'usage_update', used: 1, size: 2 }).usage, { used: 1, size: 2 });
});

test('native updates preserve the settings object during reapply and record only the current live generation', () => {
  const recorded: any[] = [],
    published: any[] = [],
    unattended: any[] = [];
  const host = {
    quirksOf: (id: string) => {
      assert.equal(id, 'custom');
      return null;
    },
    items: { append: (...args: any[]) => recorded.push(args), appendUpdate: (...args: any[]) => recorded.push(args) },
    now: () => 1,
    emitEvent: (e: any) => published.push(e),
    unattended: (...args: any[]) => unattended.push(args),
  };
  const chat: any = { key: 'acp:custom:id', harness: 'custom', state: null, loading: false, prompting: null };
  for (const value of [null, undefined, false, 'update']) recordSessionUpdate(host, chat, value);
  assert.equal(recorded.length, 0);
  recordSessionUpdate(host, chat, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
  const state = chat.state;
  assert.equal(recorded[0][1].t, 'mode');
  chat.reapplying = true;
  chat.prompting = { turnId: 'turn' };
  recordSessionUpdate(host, chat, { sessionUpdate: 'current_mode_update', currentModeId: 'ask' });
  assert.equal(chat.state, state);
  assert.equal(recorded.at(-1)[1].turnId, 'turn');
  chat.reapplying = false;
  recordSessionUpdate(host, chat, { sessionUpdate: 'current_mode_update', currentModeId: null });
  chat.prompting = null;
  recordSessionUpdate(host, chat, { sessionUpdate: 'tool_call' });
  recordSessionUpdate(host, chat, { sessionUpdate: 'tool_call_update' });
  assert.equal(unattended.length, 2);
  chat.loading = true;
  const before = recorded.length;
  recordSessionUpdate(host, chat, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'native' }] });
  assert.equal(recorded.length, before);
  assert.deepEqual(chat.state.commands, [{ name: 'native' }]);
  assert.ok(published.length > 0);
});
