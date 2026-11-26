// The reopened window reads the chat from its launch URL without waiting for unrelated Codex setup or refreshes.
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { deferred } from './support/async-scenarios.ts';
import { bootImpls, callsOf, flush, loadStore, location, resetAll } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();

beforeEach(() => {
  resetState();
  resetAll();
});

for (const [id, kind, reader] of [
  ['claude:restore', 'claude', 'claude.openClaudeThread'],
  ['acp:kimi:restore', 'acp:kimi', 'acp.openAcpThread'],
]) {
  test(`a restored ${kind} chat opens while Codex is still deciding whether to start`, async () => {
    const used = deferred<boolean>();
    location.hash = `#thread=${encodeURIComponent(id)}`;
    bootImpls({
      'state.read': async () => ({ prefs: { defaultHarness: kind } }),
      'chats.snapshot': async () => ({ chats: { [id]: { kind, meta: {} } }, newer: [] }),
      'codex.used': () => used.promise,
    });
    const booting = store.boot();
    try {
      await flush();
      assert.deepEqual(store.getState().route, { name: 'thread', id });
      assert.deepEqual(callsOf(reader), [[id]]);
      assert.deepEqual(callsOf('codex.start'), []);
    } finally {
      used.resolve(false);
      await booting;
    }
    assert.deepEqual(callsOf(reader), [[id]]);
  });
}

for (const navigateAway of [false, true]) {
  test(`a failed Codex start ${navigateAway ? 'leaves a newer route alone' : 'restores the visible chat from disk'}`, async () => {
    const start = deferred<{ bin: string }>();
    const id = 'restore-from-disk';
    location.hash = `#thread=${id}`;
    bootImpls({
      'codex.used': async () => true,
      'codex.start': () => start.promise,
      'api.threadTurns': async () => {
        throw new Error('Codex is down');
      },
      'codex.rolloutHistory': async () => ({
        turns: [{ id: 'saved-turn', status: 'completed', items: [] }],
        nextCursor: null,
      }),
    });
    const booting = store.boot();
    await flush();
    if (navigateAway) store.navigate({ name: 'home' });
    start.reject(new Error('Codex is down'));
    await booting;
    await flush();
    if (navigateAway) {
      assert.deepEqual(store.getState().route, { name: 'home' });
      assert.deepEqual(callsOf('codex.rolloutHistory'), []);
    } else {
      const runtime = store.getState().runtime[id];
      assert.equal(runtime.fromDisk, true);
      assert.deepEqual(
        runtime.turns.map((turn: { id: string }) => turn.id),
        ['saved-turn'],
      );
    }
  });
}

for (const mixed of [false, true]) {
  test(`${mixed ? 'mixed' : 'Codex'} history opens once the account and thread list are ready, while quota is pending`, async () => {
    const account = deferred<{ active: null; accounts: [] }>();
    const quota = deferred<{ rateLimits: object }>();
    const id = mixed ? 'mixed-restore' : 'codex-restore';
    location.hash = `#thread=${id}`;
    bootImpls({
      'chats.snapshot': async () => ({
        chats: {
          [id]: {
            kind: 'codex',
            meta: {},
            ...(mixed && {
              segments: [
                { harness: 'codex', nativeId: id },
                { harness: 'claude', nativeId: 'claude:mixed-restore' },
              ],
            }),
          },
        },
        newer: [],
      }),
      'codex.used': async () => true,
      'accounts.apply': () => account.promise,
      'api.threadRead': async () => ({ thread: { id } }),
      'api.threadTurns': async () => ({ data: [], nextCursor: null }),
      'api.accountRateLimits': () => quota.promise,
    });
    const reader = mixed ? 'switch.openCompositeThread' : 'api.threadTurns';
    const booting = store.boot();
    try {
      await flush();
      assert.equal(callsOf('accounts.apply').length, 1);
      assert.deepEqual(callsOf(reader), []);
      account.resolve({ active: null, accounts: [] });
      await flush();
      assert.equal(callsOf('api.accountRateLimits').length, 1);
      assert.equal(callsOf(reader).length, 1);
      assert.equal(callsOf(reader)[0][0], id);
    } finally {
      account.resolve({ active: null, accounts: [] });
      quota.resolve({ rateLimits: {} });
      await booting;
    }
    assert.equal(callsOf(reader).length, 1, 'finishing the refresh does not reopen history');
  });
}
