// What a finished turn refreshes and reports (src/store/notifications.ts onTurnFinished), per harness family: Codex's
// usage limits are read only after a Codex turn, and usage data names the harness the turn ran on.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, listeners, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const note = (method: string, params: any) =>
  listeners['codex.onItem']({ kind: 'notification', chatId: params.threadId ?? null, method, params });

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

const finish = async (threadId: string) => {
  set({
    prefs: { ...st().prefs, shareUsageData: true },
    runtime: { ...st().runtime, [threadId]: { turns: [{ id: 'T', status: 'inProgress', items: [] }], settings: { model: 'm' } } as any },
  });
  note('turn/completed', { threadId, turn: { id: 'T', status: 'completed', items: [] } });
  await flush();
};

test('a basic or Claude turn reads no Codex usage limits, and its usage data names its own harness', async () => {
  set({
    segments: { c: [{ harness: 'claude', nativeId: 'claude:s1', start: 0, count: null, model: null }] } as any,
  });
  await finish('acp:kimi:1');
  await finish('c');
  assert.deepEqual(callsOf('api.accountRateLimits'), []);
  assert.deepEqual(
    callsOf('telemetry.shareTurn').map((a) => [a[0], a[1]]),
    [
      ['acp:kimi:1', 'acp:kimi'],
      ['c', 'claude'],
    ],
  );
});

test('a Codex turn refreshes its usage limits and reports as Codex', async () => {
  await finish('cx');
  assert.equal(callsOf('api.accountRateLimits').length, 1);
  assert.deepEqual(
    callsOf('telemetry.shareTurn').map((a) => [a[0], a[1]]),
    [['cx', 'codex']],
  );
});
