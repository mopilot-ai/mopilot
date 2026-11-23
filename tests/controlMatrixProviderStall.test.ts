// CM-K36: a provider that fails while a turn runs is never silent, on any harness (#1534). Each harness family's own
// retry signal (Codex's error with willRetry, Claude Code's system/api_retry, an ACP harness's providerError read from
// its stderr) reaches both the request ledger as a `retry` line and the thread as the willRetry `error` notification
// the retry banner shows (src/store/notifications.ts, src/components/thread/TurnStall.tsx). A family whose ledger
// sees a retry that its thread drops is the bug this guards (Claude's api_retry reached only the ledger).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ClaudeTranslator } from './support/claude-translate.ts';
import { providerRetryError } from '../shared/acpStop.mjs';

export const GUARDS = ['electron/ledger/', 'shared/'];

const require = createRequire(import.meta.url);
const { CodexLedgerTap } = require('../electron/ledger/codexTap.cjs');
const { ClaudeLedgerTap } = require('../electron/ledger/claudeTap.cjs');
const { AcpLedgerTap } = require('../electron/ledger/acpTap.cjs');

/** The thread side of the contract: what the store turns into the retry banner. */
const isRetryBanner = (method: string, p: any, turnId: string) =>
  method === 'error' && p?.willRetry === true && p.turnId === turnId && typeof p.error?.message === 'string' && !!p.error.message;

const FAMILIES = {
  codex(): { ledger: any[]; thread: [string, any][] } {
    const ledger: any[] = [];
    const tap = new CodexLedgerTap({ record: (r: any) => ledger.push(r), chatOf: (t: string) => t, accountOf: () => null });
    tap.message({ method: 'turn/started', params: { threadId: 'th', turn: { id: 'T' } } });
    const msg = { method: 'error', params: { threadId: 'th', turnId: 'T', willRetry: true, error: { message: 'Reconnecting… 2/5' } } };
    tap.message(msg);
    // the app-server's notification reaches the store as it is
    return { ledger, thread: [[msg.method, msg.params]] };
  },
  claude(): { ledger: any[]; thread: [string, any][] } {
    const ledger: any[] = [];
    const tap = new ClaudeLedgerTap({ record: (r: any) => ledger.push(r), chatOf: (k: string) => k, accountOf: () => null });
    const thread: [string, any][] = [];
    const tr = new ClaudeTranslator('th', '/repo', (m: string, p: any) => thread.push([m, p]));
    tr.beginTurn('T');
    const msg = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 2000,
      error_status: 529,
      error: 'overloaded',
    };
    tap.event({ key: 'th', kind: 'message', msg });
    tr.onMessage(msg);
    return { ledger, thread };
  },
  acp(): { ledger: any[]; thread: [string, any][] } {
    const ledger: any[] = [];
    const tap = new AcpLedgerTap({ record: (r: any) => ledger.push(r), chatOf: (k: string) => k });
    const e = { key: 'acp:opencode:th', kind: 'providerError', turnId: 'T', error: 'Rate limit exceeded' };
    tap.event(e);
    // src/session/harness/acp.ts maps the host's event through providerRetryError (tests/harnessAcp.test.ts)
    const p = providerRetryError('acp:opencode:th', e.turnId, 'opencode', e.error);
    return { ledger, thread: [['error', p]] };
  },
};

for (const [family, run] of Object.entries(FAMILIES)) {
  test(`CM-K36 (${family}): a provider retry reaches the request ledger as a retry and the thread as the retry banner`, () => {
    const { ledger, thread } = run();
    assert.equal(ledger.filter((r) => r.outcome === 'retry').length, 1, `${family} ledger: ${JSON.stringify(ledger)}`);
    assert.equal(thread.filter(([m, p]) => isRetryBanner(m, p, 'T')).length, 1, `${family} thread: ${JSON.stringify(thread)}`);
  });
}

test('CM-K36: Claude Code’s api_retry reads as the API’s failure and the attempt; a no-response retry says how long it waited', () => {
  const thread: [string, any][] = [];
  const tr = new ClaudeTranslator('th', '/repo', (m: string, p: any) => thread.push([m, p]));
  // before any turn: nothing to put a banner on
  tr.onMessage({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 429, error: 'rate_limit' });
  assert.equal(thread.filter(([m]) => m === 'error').length, 0);
  tr.beginTurn('T');
  tr.onMessage({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, error_status: 429, error: 'rate_limit' });
  tr.onMessage({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 1,
    error_status: null,
    error: 'unknown',
    no_response: { waited_ms: 30_400, retry_wait_ms: 60_000 },
  });
  tr.onMessage({ type: 'system', subtype: 'api_retry' });
  assert.deepEqual(
    thread.filter(([m]) => m === 'error').map(([, p]) => p.error.message),
    [
      "Claude's API returned 429 rate_limit. Claude Code keeps retrying (attempt 2 of 10).",
      "Claude's API sent no response in 30 s. Claude Code keeps retrying (attempt 1 of 1).",
      "Claude's API returned an error. Claude Code keeps retrying.",
    ],
  );
  // an attempt without a known budget
  tr.onMessage({ type: 'system', subtype: 'api_retry', attempt: 3, error: 'server_error' });
  assert.equal(thread.at(-1)![1].error.message, "Claude's API returned server_error. Claude Code keeps retrying (attempt 3).");
});
