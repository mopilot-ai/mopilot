// Reading a harness's plan usage again for a usage view: Claude Code's logins with the reason given; Codex's app-server login while it runs, started only by the user's Refresh, and its pool through main, asked again only for a new reading or with no app-server.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const calls: unknown[][] = [];
const state: any = { conn: 'ready', accounts: { accounts: [] } };
mock.module('../src/store/core.ts', { namedExports: { get: () => state } });
mock.module('../src/store/accounts.ts', { namedExports: { refreshAccountsUsage: async (r: string) => calls.push(['pool', r]) } });
mock.module('../src/store/connection.ts', {
  namedExports: {
    refreshRateLimits: async () => calls.push(['rateLimits']),
    // starting only from idle, as connection.ts does
    ensureCodex: () => (state.conn === 'idle' ? (calls.push(['start']), Promise.resolve()) : undefined),
  },
});
mock.module('../src/session/harness/claude/usage.ts', {
  namedExports: { refreshClaudeUsage: async (r: string) => calls.push(['claude', r]) },
});
const { refreshPlanUsage } = await import('../src/session/harness/planUsage.ts');

async function run(h: 'claude' | 'codex', reason: 'surface' | 'now', s: Record<string, unknown> = {}) {
  Object.assign(state, { conn: 'ready', accounts: { accounts: [] } }, s);
  calls.length = 0;
  await refreshPlanUsage(h, reason);
  return [...calls];
}

test("Claude Code reads its logins with the view's reason, whatever Codex is doing", async () => {
  assert.deepEqual(await run('claude', 'surface', { conn: 'idle' }), [['claude', 'surface']]);
  assert.deepEqual(await run('claude', 'now'), [['claude', 'now']]);
});

test('Codex: a running app-server is read, its pool asked again only for a new reading; only Refresh starts an idle one', async () => {
  const pool = { accounts: { accounts: [{ id: 'a' }] } };
  assert.deepEqual(await run('codex', 'surface'), [['rateLimits']]);
  assert.deepEqual(await run('codex', 'now'), [['rateLimits']]);
  assert.deepEqual(await run('codex', 'surface', pool), [['rateLimits']]);
  assert.deepEqual(await run('codex', 'now', pool), [['rateLimits'], ['pool', 'now']]);
  // left idle: opening a view never starts it, Refresh does (starting reads its rate limits); the pool is read through main
  assert.deepEqual(await run('codex', 'surface', { conn: 'idle' }), []);
  assert.deepEqual(await run('codex', 'now', { conn: 'idle' }), [['start']]);
  assert.deepEqual(await run('codex', 'surface', { ...pool, conn: 'idle' }), [['pool', 'surface']]);
  assert.deepEqual(await run('codex', 'now', { ...pool, conn: 'idle' }), [['start'], ['pool', 'now']]);
  // one that failed shows its error elsewhere and is not restarted from here
  assert.deepEqual(await run('codex', 'now', { ...pool, conn: 'error' }), [['pool', 'now']]);
});
