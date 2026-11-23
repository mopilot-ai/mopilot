// main's agent-tab command argument (src/lib/agentTabRequest.ts): a chat id with an optional key, focus, duplicate
// source and automatic mark, and nothing for anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentTabRequest } from '../src/lib/agentTabRequest.ts';

test('agentTabRequest reads a chat id with an optional key, focus, duplicate source and automatic mark', () => {
  assert.deepEqual(agentTabRequest({ chatId: 'c', tabKey: 'tab_aa1111', focus: false, after: 'tab_bb2222' }), {
    chatId: 'c',
    tabKey: 'tab_aa1111',
    focus: false,
    after: 'tab_bb2222',
  });
  // an empty or non-string key is the chat's original tab; a focus or source that is not one is left out
  assert.deepEqual(agentTabRequest({ chatId: 'c', tabKey: '', focus: 'no', after: '' }), { chatId: 'c', tabKey: null });
  assert.deepEqual(agentTabRequest({ chatId: 'c', tabKey: 7, focus: true, after: null }), {
    chatId: 'c',
    tabKey: null,
    focus: true,
    after: null,
  });
  // only a true `auto` marks a request at the agent's own pace
  assert.deepEqual(agentTabRequest({ chatId: 'c', auto: true }), { chatId: 'c', tabKey: null, auto: true });
  for (const auto of ['yes', 1, false, null]) assert.deepEqual(agentTabRequest({ chatId: 'c', auto }), { chatId: 'c', tabKey: null });
  for (const bad of [null, undefined, 'c', 3, {}, { chatId: '' }, { chatId: 5 }]) assert.equal(agentTabRequest(bad), null);
});
