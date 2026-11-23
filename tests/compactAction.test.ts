// The compaction action preserves custom arguments and distinguishes accepted main-owned input from capability refusal.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll } from './support/store-harness.ts';

const { store, resetState } = await loadStore();
beforeEach(() => {
  resetState();
  resetAll();
});

test('accepted compaction returns its queue receipt and custom instructions intact', async () => {
  const receipt = { action: 'queued', id: 'compact' };
  const calls: unknown[] = [];
  impl['run.runSemantic'] = async (...args: unknown[]) => (calls.push(args), { ok: true, value: receipt });
  assert.equal(await store.compactThread('chat', 'Keep $$ and $&'), receipt);
  assert.deepEqual(calls, [['chat', 'compact', 'Keep $$ and $&']]);
});

test('fresh capability refusal returns false so the composer retains the command', async () => {
  impl['run.runSemantic'] = async () => ({ ok: false, state: 'disabled', why: null });
  impl['run.refusalText'] = () => 'Compaction is unavailable';
  assert.equal(await store.compactThread('chat', 'Keep decisions'), false);
  assert.equal(store.useStore.getState().toasts.at(-1).text, 'Compaction is unavailable');
});
