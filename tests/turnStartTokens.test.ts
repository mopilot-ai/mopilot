// A turn's start records the chat's token total (src/store/notifications.ts), so the activity line can count the
// turn's own tokens from it (src/components/thread/turnTokens.tsx).
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll, flush, listeners, bootImpls, impl } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const { turnTokens } = await import('../src/components/thread/turnTokens.tsx');
const st = () => store.useStore.getState();
const note = (method: string, params: any) => listeners['codex.onItem']({ kind: 'notification', chatId: params.threadId, method, params });
const usage = (totalTokens: number) => ({
  total: { totalTokens, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
  last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
  modelContextWindow: null,
});

before(async () => {
  bootImpls();
  await store.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

test("each new turn starts its count from the chat's total then; the same turn started again keeps its start", () => {
  // no usage reported yet: nothing to count from
  note('turn/started', { threadId: 'c', turn: { id: 'T1', status: 'inProgress' } });
  assert.equal(st().runtime.c.turnStartTokens, null);
  note('thread/tokenUsage/updated', { threadId: 'c', turnId: 'T1', tokenUsage: usage(5_000) });
  assert.equal(turnTokens(st().runtime.c), null, 'a turn begun before any usage has no count');
  note('turn/started', { threadId: 'c', turn: { id: 'T2', status: 'inProgress' } });
  assert.equal(st().runtime.c.turnStartTokens, 5_000);
  note('thread/tokenUsage/updated', { threadId: 'c', turnId: 'T2', tokenUsage: usage(17_300) });
  assert.equal(turnTokens(st().runtime.c), 12_300);
  // a repeated start of the running turn does not move its start
  note('turn/started', { threadId: 'c', turn: { id: 'T2', status: 'inProgress' } });
  assert.equal(st().runtime.c.turnStartTokens, 5_000);
  // a pending turn that gets its id starts from the total too
  listeners['codex.onItem']({ kind: 'turnStarting', chatId: 'c', clientId: 'k', text: 'x', attachments: [], opts: {} });
  note('turn/started', { threadId: 'c', turn: { id: 'T3', status: 'inProgress' } });
  assert.equal(st().runtime.c.turnStartTokens, 17_300);
});
