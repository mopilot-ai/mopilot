// Report provenance is stamped by the real notification reducer and invalidated by native-session changes.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { contextUsageKey, contextReportOwner, reportedTokenUsage } from '../src/store/contextUsage.ts';
import { noteOwner } from '../src/harness/ownership.ts';
import { loadStore } from './support/store-harness.ts';
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const set = store.useStore.setState;
const state = store.useStore.getState;
const segment = (harness: string, nativeId: string) => [{ harness, nativeId, start: 0 }] as any;
const usage = { last: { totalTokens: 80 }, total: { totalTokens: 80 }, modelContextWindow: 100 } as any;

test('structured context keys distinguish chat, harness and native ids including delimiters and quotes', () => {
  assert.notEqual(contextUsageKey(segment('codex', 'same'), 'chat'), contextUsageKey(segment('claude', 'same'), 'chat'));
  assert.notEqual(contextUsageKey(segment('acp:kimi', 'same'), 'chat'), contextUsageKey(segment('acp:qwen', 'same'), 'chat'));
  assert.notEqual(contextUsageKey(segment('codex', 'b:c'), 'a'), contextUsageKey(segment('codex', 'c'), 'a:b'));
  assert.notEqual(contextUsageKey(segment('codex', 'x"\\y'), 'a'), contextUsageKey(segment('codex', 'x'), 'a"\\y'));
  assert.equal(contextUsageKey(undefined, 'plain'), contextUsageKey([], 'plain'));
});

test('unowned and missing readings are unavailable instead of claiming current context', () => {
  resetState();
  assert.equal(reportedTokenUsage(state(), 'missing'), null);
  set({ runtime: { chat: { tokenUsage: usage } as any } });
  assert.equal(reportedTokenUsage(state(), 'chat'), null);
});

test('every harness notification owns its report; switching owners invalidates context until a fresh report', () => {
  for (const harness of ['codex', 'claude', 'acp:kimi']) {
    resetState();
    set({ segments: { chat: segment(harness, 'old') } });
    store.applyNotification('thread/tokenUsage/updated', {
      threadId: 'chat',
      turnId: 'turn',
      tokenUsage: usage,
      tokenUsageSource: { harness, nativeId: 'old' },
    });
    assert.deepEqual(reportedTokenUsage(state(), 'chat'), usage);
    assert.equal(state().runtime.chat.tokenUsageOwner, contextUsageKey(state().segments.chat, 'chat'));
    set({ segments: { chat: segment(harness, 'new') } });
    assert.equal(reportedTokenUsage(state(), 'chat'), null);
    assert.deepEqual(state().runtime.chat.tokenUsage, usage, 'historical counters are retained');
    const replacement = { ...usage, last: { totalTokens: 20 } };
    store.applyNotification('thread/tokenUsage/updated', {
      threadId: 'chat',
      turnId: 'new-turn',
      tokenUsage: replacement,
      tokenUsageSource: { harness, nativeId: 'new' },
    });
    assert.deepEqual(reportedTokenUsage(state(), 'chat'), replacement);
    set({ segments: { chat: segment(harness === 'codex' ? 'claude' : 'codex', 'new') } });
    assert.equal(reportedTokenUsage(state(), 'chat'), null, 'the same native id in another harness is another owner');
  }
});

test('a report from a chat without explicit segments is owned by that chat', () => {
  resetState();
  store.applyNotification('thread/tokenUsage/updated', {
    threadId: 'chat',
    turnId: 'turn',
    tokenUsage: usage,
    tokenUsageSource: { harness: 'codex', nativeId: 'chat' },
  });
  assert.equal(state().runtime.chat.tokenUsageOwner, contextUsageKey(undefined, 'chat'));
  assert.deepEqual(reportedTokenUsage(state(), 'chat'), usage);
});

test('late obsolete reports never replace the current session reading, before or after a fresh report', () => {
  resetState();
  set({ segments: { chat: segment('claude', 'current') } });
  const oldSources = [
    ['codex', 'old-code'],
    ['claude', 'old-claude'],
    ['acp:kimi', 'old-acp'],
  ];
  for (const [harness, nativeId] of oldSources) {
    store.applyNotification('thread/tokenUsage/updated', { threadId: 'chat', tokenUsage: usage, tokenUsageSource: { harness, nativeId } });
    assert.equal(reportedTokenUsage(state(), 'chat'), null);
  }
  const current = { ...usage, last: { totalTokens: 20 } };
  store.applyNotification('thread/tokenUsage/updated', {
    threadId: 'chat',
    tokenUsage: current,
    tokenUsageSource: { harness: 'claude', nativeId: 'current' },
  });
  for (const [harness, nativeId] of oldSources) {
    store.applyNotification('thread/tokenUsage/updated', { threadId: 'chat', tokenUsage: usage, tokenUsageSource: { harness, nativeId } });
    assert.deepEqual(reportedTokenUsage(state(), 'chat'), current);
  }
  store.applyNotification('thread/tokenUsage/updated', { threadId: 'chat', tokenUsage: usage });
  assert.equal(reportedTokenUsage(state(), 'chat'), null, 'unattributed reports cannot claim current context');
});

test('malformed source records cannot claim a context owner', () => {
  for (const source of [
    undefined,
    null,
    'old',
    [],
    {},
    { harness: 1 },
    { harness: '' },
    { harness: 'codex' },
    { harness: 'codex', nativeId: 1 },
    { harness: 'codex', nativeId: '' },
  ]) {
    assert.equal(contextReportOwner('chat', source), undefined);
  }
});

test('a native ACP chat without explicit segments accepts its own usage', () => {
  resetState();
  const chatId = 'acp:kimi:session';
  store.applyNotification('thread/tokenUsage/updated', {
    threadId: chatId,
    tokenUsage: usage,
    tokenUsageSource: { harness: 'acp:kimi', nativeId: chatId },
  });
  assert.deepEqual(reportedTokenUsage(state(), chatId), usage);
});

test('native first-tier chats without explicit segments keep their actual family', () => {
  for (const harness of ['codex', 'claude']) {
    resetState();
    const chatId = `native-${harness}`;
    noteOwner(chatId, harness);
    store.applyNotification('thread/tokenUsage/updated', {
      threadId: chatId,
      tokenUsage: usage,
      tokenUsageSource: { harness, nativeId: chatId },
    });
    assert.deepEqual(reportedTokenUsage(state(), chatId), usage);
  }
});
