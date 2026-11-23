// electron/harness/claude/adapter.cjs: a chat with nowhere to move at its usage limit is told to main (limitHit), whether
// or not a window is open, for the limit continuation (electron/session/limitContinue.cjs); a lapsed login is not a limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');

const CHAT = 'claude:s1';

function adapter(emitReturns: boolean, limitHit?: (chatId: string) => void) {
  return new ClaudeAdapter({
    api: {
      isLive: () => false,
      accounts: () => ({ active: 'default', accounts: [{ id: 'default', loggedIn: true }] }),
      metered: () => false,
      keyMode: () => true,
    },
    state: new SessionStore(),
    prefs: () => null,
    send: async () => ({}),
    enqueue: () => {},
    chatOf: (key: string) => key,
    ref: () => ({ kind: 'claude', id: 's1', instance: null, key: CHAT }),
    emit: () => emitReturns,
    setGoal: () => {},
    moved: () => {},
    notifyLimit: () => {},
    ...(limitHit ? { limitHit } : {}),
  });
}

test('a limit with nowhere to move is told to main, with a window open or not; a lapsed login is not one', () => {
  for (const emitReturns of [true, false]) {
    const hits: string[] = [];
    adapter(emitReturns, (chatId) => hits.push(chatId)).unresolved(CHAT, CHAT, 'limit');
    assert.deepEqual(hits, [CHAT], `window ${emitReturns}`);
  }
  const hits: string[] = [];
  adapter(false, (chatId) => hits.push(chatId)).unresolved(CHAT, CHAT, 'expired');
  assert.deepEqual(hits, []);
  // main wired nothing: the default hook does nothing
  assert.doesNotThrow(() => adapter(false).unresolved(CHAT, CHAT, 'limit'));
});
