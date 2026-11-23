// The request ledger's Codex tap (electron/ledger/codexTap.cjs): the app-server's events become one line per model request with
// the account the turn ran on, for success, retry, error and a stop. The Claude Code tap is in tests/requestLedgerClaudeTap.test.ts;
// the ACP tap, account naming, the ledger's wiring and the privacy check are in tests/requestLedgerAcpAccounts.test.ts; each line's
// request key and payment in tests/requestLedgerCost.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexLedgerTap, statusOf, errorStatus, codeOf } = require('../electron/ledger/codexTap.cjs');

const ACCOUNT = { id: 'acct-1', email: 'work@example.com', verified: true };
function codexTap() {
  const out: any[] = [];
  const accountCalls: any[] = [];
  const tap = new CodexLedgerTap({
    record: (r: any) => out.push(r),
    chatOf: (id: string) => `chat-of-${id}`,
    accountOf: (thread: string, turn: string) => (accountCalls.push([thread, turn]), ACCOUNT),
  });
  return { tap, out, accountCalls };
}
const n = (method: string, params: any) => ({ method, params });
const usage = (o: any = {}) => ({
  inputTokens: 120,
  cachedInputTokens: 100,
  cacheWriteInputTokens: 5,
  outputTokens: 30,
  reasoningOutputTokens: 7,
  ...o,
});

test('Codex: each token-usage update is one ok line with the asked model, effort, account and uncached input', () => {
  const { tap, out, accountCalls } = codexTap();
  tap.message(n('turn/started', { threadId: 'th', turn: { id: 'tu' } }));
  tap.emitted({ kind: 'turnStarted', chatId: 'chat-1', turnId: 'tu', model: 'gpt-5', effort: 'high', text: 'my prompt' });
  tap.message(n('thread/tokenUsage/updated', { threadId: 'th', turnId: 'tu', tokenUsage: { last: usage(), total: usage() } }));
  tap.message(n('model/rerouted', { threadId: 'th', turnId: 'tu', fromModel: 'gpt-5', toModel: 'gpt-5-mini' }));
  tap.message(
    n('thread/tokenUsage/updated', { threadId: 'th', turnId: 'tu', tokenUsage: { last: usage({ cachedInputTokens: undefined }) } }),
  );
  tap.message(n('turn/completed', { threadId: 'th', turn: { id: 'tu', status: 'completed', error: null } }));
  assert.deepEqual(accountCalls, [['th', 'tu']]);
  assert.deepEqual(
    out.map(({ key: _k, pay: _p, ...r }) => r),
    [
      {
        harness: 'codex',
        chat: 'chat-1',
        session: 'th',
        turn: 'tu',
        account: ACCOUNT,
        req: 'gpt-5',
        served: undefined,
        effort: 'high',
        outcome: 'ok',
        in: 20,
        cacheRead: 100,
        cacheWrite: 5,
        out: 30,
        reasoning: 7,
      },
      {
        harness: 'codex',
        chat: 'chat-1',
        session: 'th',
        turn: 'tu',
        account: ACCOUNT,
        req: 'gpt-5',
        served: 'gpt-5-mini',
        effort: 'high',
        outcome: 'ok',
        in: 120,
        cacheRead: undefined,
        cacheWrite: 5,
        out: 30,
        reasoning: 7,
      },
    ],
  );
  assert.equal(tap.turns.size, 0, 'a completed turn is forgotten');
});

test("Codex: behind the relay the thread's pin comes with its first request, so an unknown account is asked again", () => {
  const out: any[] = [];
  let pin: any = null;
  const asked: any[] = [];
  const tap = new CodexLedgerTap({
    record: (r: any) => out.push(r),
    chatOf: (id: string) => id,
    accountOf: (thread: string, turn: string) => (asked.push([thread, turn]), pin),
  });
  tap.message(n('turn/started', { threadId: 'th', turn: { id: 'tu' } }));
  pin = ACCOUNT;
  tap.message(n('thread/tokenUsage/updated', { threadId: 'th', turnId: 'tu', tokenUsage: { last: usage() } }));
  tap.message(n('thread/tokenUsage/updated', { threadId: 'th', turnId: 'tu', tokenUsage: { last: usage() } }));
  assert.deepEqual(asked, [
    ['th', 'tu'],
    ['th', 'tu'],
  ]);
  assert.deepEqual(
    out.map((r) => r.account),
    [ACCOUNT, ACCOUNT],
  );
});

test('Codex: the update a stopped turn repeats is not a second request; one that adds to the total is', () => {
  const { tap, out } = codexTap();
  const upd = (total: number, last = usage()) =>
    tap.message(n('thread/tokenUsage/updated', { threadId: 'th', turnId: 'tu', tokenUsage: { last, total: { totalTokens: total } } }));
  tap.message(n('turn/started', { threadId: 'th', turn: { id: 'tu' } }));
  upd(1000);
  upd(1500);
  upd(1500);
  tap.message(n('turn/completed', { threadId: 'th', turn: { id: 'tu', status: 'interrupted' } }));
  assert.deepEqual(
    out.map((r) => r.outcome),
    ['ok', 'ok', 'interrupted'],
  );
});

test('Codex: turnStarted before turn/started merges into one turn; the chat comes from the thread', () => {
  const { tap, out } = codexTap();
  tap.emitted({ kind: 'turnStarted', chatId: 7, turnId: 'tu', model: '', effort: null });
  tap.message(n('turn/started', { threadId: 'th', turn: { id: 'tu' } }));
  tap.message(n('thread/tokenUsage/updated', { threadId: 'th', turnId: 'tu', tokenUsage: { last: { inputTokens: 'x' } } }));
  assert.deepEqual(
    out.map((r) => [r.chat, r.req, r.effort, r.in]),
    [['chat-of-th', undefined, undefined, undefined]],
  );
});

test('Codex: a retried request is a retry line, the final failure one error line with its status, kind and details', () => {
  const { tap, out } = codexTap();
  tap.message(n('turn/started', { threadId: 'th', turn: { id: 'tu' } }));
  tap.message(
    n('error', {
      threadId: 'th',
      turnId: 'tu',
      willRetry: true,
      error: { message: 'stream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } },
    }),
  );
  const limit = {
    message: "You've hit your usage limit",
    codexErrorInfo: 'usageLimitExceeded',
    additionalDetails: 'resets Oct 18 at 11am',
  };
  tap.message(n('error', { threadId: 'th', turnId: 'tu', willRetry: false, error: limit }));
  // the turn's failure repeats the error already written: no second line
  tap.message(n('turn/completed', { threadId: 'th', turn: { id: 'tu', status: 'failed', error: limit } }));
  assert.deepEqual(
    out.map((r) => [r.outcome, r.status, r.code, r.error]),
    [
      ['retry', 502, 'responseStreamDisconnected', 'stream disconnected'],
      ['error', undefined, 'usageLimitExceeded', "You've hit your usage limit — resets Oct 18 at 11am"],
    ],
  );
});

test('Codex: a failed turn without an error notification is one error line; an interrupted turn one stopped line', () => {
  const { tap, out } = codexTap();
  tap.message(n('turn/started', { threadId: 'th', turn: { id: 'a' } }));
  tap.message(
    n('turn/completed', {
      threadId: 'th',
      turn: { id: 'a', status: 'failed', error: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } } },
    }),
  );
  tap.message(n('turn/started', { threadId: 'th', turn: { id: 'b' } }));
  tap.message(n('turn/completed', { threadId: 'th', turn: { id: 'b', status: 'interrupted', error: null } }));
  tap.message(n('turn/started', { threadId: 'th', turn: { id: 'c' } }));
  tap.message(n('turn/completed', { threadId: 'th', turn: { id: 'c', status: 'failed', error: null } }));
  assert.deepEqual(
    out.map((r) => [r.turn, r.outcome, r.status, r.code, r.error]),
    [
      ['a', 'error', 503, 'httpConnectionFailed', undefined],
      ['b', 'interrupted', undefined, undefined, undefined],
      ['c', 'error', undefined, undefined, undefined],
    ],
  );
});

test('Codex: messages of turns it did not see start, without params, or of other kinds write nothing', () => {
  const { tap, out } = codexTap();
  tap.message(n('thread/tokenUsage/updated', { threadId: 'old', turnId: 'old-turn', tokenUsage: { last: usage() } }));
  tap.message(n('turn/completed', { threadId: 'old', turn: { id: 'gone', status: 'interrupted' } }));
  tap.message({ method: 'turn/started' });
  tap.message({ id: 1, result: {} });
  tap.message(null);
  tap.message(n('turn/started', { threadId: 'th', turn: {} }));
  tap.message(n('turn/started', { threadId: 'th', turn: { id: 'tu' } }));
  tap.message(n('thread/tokenUsage/updated', { threadId: 'th', turnId: 'tu', tokenUsage: {} }));
  tap.message(n('model/rerouted', { threadId: 'th', turnId: 'tu', toModel: 5 }));
  tap.message(n('item/completed', { threadId: 'th', turnId: 'tu', item: { type: 'agentMessage', text: 'reply' } }));
  tap.message(n('error', { threadId: 'th', turnId: 7 }));
  tap.emitted({ kind: 'turnStarting', chatId: 'c' });
  tap.emitted({ kind: 'turnStarted', chatId: 'c' });
  tap.emitted(undefined);
  assert.deepEqual(out, []);
});

test('Codex: turns whose turnStarted came after they ended are let go past the bound', () => {
  const { tap } = codexTap();
  for (let i = 0; i < 300; i++) tap.emitted({ kind: 'turnStarted', chatId: 'c', turnId: `t${i}` });
  assert.equal(tap.turns.size, 256);
  assert.equal(tap.turns.has('t0'), false);
  assert.equal(tap.turns.has('t299'), true);
});

test("Codex: errorStatus falls back to the status the error's text names", () => {
  assert.equal(errorStatus({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } }, message: '"status":400' }), 502);
  assert.equal(errorStatus({ codexErrorInfo: 'other', message: '{"type":"error","status": 400,"error":{}}' }), 400);
  assert.equal(errorStatus({ codexErrorInfo: 'usageLimitExceeded', message: 'unexpected status 429 Too Many Requests' }), 429);
  assert.equal(errorStatus({ message: 'no number here' }), undefined);
  assert.equal(errorStatus({ message: 42 }), undefined);
  assert.equal(errorStatus(undefined), undefined);
});

test('Codex: statusOf and codeOf read both shapes of codexErrorInfo', () => {
  assert.equal(statusOf({ responseTooManyFailedAttempts: { httpStatusCode: 429 } }), 429);
  assert.equal(statusOf({ other: {} }), undefined);
  assert.equal(statusOf('usageLimitExceeded'), undefined);
  assert.equal(statusOf(null), undefined);
  assert.equal(codeOf('unauthorized'), 'unauthorized');
  assert.equal(codeOf({ httpConnectionFailed: {} }), 'httpConnectionFailed');
  assert.equal(codeOf(undefined), undefined);
});
