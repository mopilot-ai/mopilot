import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deferred } from './support/async-scenarios.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-cards-'));
process.env.CODEX_HOME = path.join(tmp, 'codex');
const { Accounts, limitInfo } = createRequire(import.meta.url)('../electron/identity/codexAccounts.cjs');
const { UsageRefresh } = createRequire(import.meta.url)('../electron/identity/contract/usageRefresh.cjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const snapshot = (used = 5, patch = {}) => ({ limitId: 'codex', primary: { usedPercent: used, resetsAt: 4e9 }, ...patch });
const row = (id = 'a', patch = {}) => ({ id, kind: 'chatgpt', status: 'ok', limits: limitInfo(snapshot(90)), ...patch });
function manager(rows = [row()]) {
  const a = Object.create(Accounts.prototype);
  a.state = { active: 'a', accounts: rows };
  a.usageRefresh = new UsageRefresh();
  a.resetAttempts = new Map();
  a.resetting = new Map();
  a.changed = () => {};
  return a;
}

test('account manager initializes shared redemption locks without starting an app-server', () => {
  const server = { intercepts: new Set(), listeners: new Set() };
  const a = new Accounts({
    userData: tmp,
    server,
    broadcast: () => {},
    findBin: () => {
      throw new Error('no process permitted');
    },
  });
  assert.equal(a.resetAttempts.size, 0);
  assert.equal(a.resetting.size, 0);
  a.dispose();
});

test('only existing ChatGPT subscription accounts can use reset cards', () => {
  const a = manager([row(), row('legacy', { kind: undefined }), row('key', { kind: 'apiKey' }), row('credits', { mopilot: true })]);
  assert.equal(a.resetAccount('a').id, 'a');
  assert.equal(a.resetAccount('legacy').id, 'legacy');
  for (const id of ['missing', 'key', 'credits']) assert.throws(() => a.resetAccount(id), /subscription account/);
});

test('reset reads request full card details from the selected account and prefer the Codex quota', async () => {
  const a = manager([row('a'), row('b')]);
  const calls: any[] = [];
  a.sidecar = (account: any) => ({
    call: async (...args: any[]) => {
      calls.push([account.id, ...args]);
      return { rateLimits: snapshot(90), rateLimitsByLimitId: { codex: snapshot(5) }, rateLimitResetCredits: { availableCount: 1 } };
    },
  });
  let changes = 0;
  a.changed = () => changes++;
  await a.resetCredits('b');
  assert.deepEqual(calls, [['b', 'account/rateLimits/read', { excludeResetCreditDetails: false }]]);
  assert.equal(a.get('b').limits.used, 5);
  assert.equal(a.get('a').limits.used, 90);
  assert.equal(changes, 1);
});

test('reset usage supports legacy windows and backend limit states', async () => {
  for (const snap of [
    snapshot(),
    snapshot(5, { limitId: undefined }),
    { secondary: { usedPercent: 5 } },
    { rateLimitReachedType: 'primary' },
  ]) {
    const a = manager();
    a.readUsage = async () => ({ rateLimits: snap });
    const before = Date.now();
    await a.resetCredits('a');
    // `at` is the read time, so it is checked as a range rather than against a second clock read
    const { at, ...limits } = a.get('a').limits;
    const { at: _at, ...expected } = limitInfo(snap);
    assert.deepEqual(limits, expected);
    assert.ok(at >= before && at <= Date.now(), `read at ${at}`);
  }
});

test('unavailable or unrelated quota does not erase known usage', async () => {
  for (const reply of [
    null,
    {},
    { rateLimits: {} },
    { rateLimits: snapshot(5, { limitId: 'other' }) },
    { rateLimitsByLimitId: { other: snapshot() } },
  ]) {
    const a = manager(),
      previous = a.get('a').limits;
    a.readUsage = async () => reply;
    await a.resetCredits('a');
    assert.equal(a.get('a').limits, previous);
  }
});

test('late reset-card reads preserve newer quota and do not update removed accounts', async () => {
  for (const update of ['headers', 'removed']) {
    const a = manager(),
      account = a.get('a'),
      pending = deferred();
    a.readUsage = () => pending.promise;
    a.changed = () => assert.fail('late read should not broadcast');
    const read = a.resetCredits('a');
    if (update === 'headers') account.limits = limitInfo(snapshot(99));
    else a.state.accounts = [];
    const previous = account.limits;
    pending.resolve({ rateLimits: snapshot(5) });
    await read;
    assert.equal(account.limits, previous);
  }
});

test('reset reads retain full-detail params across an authentication refresh; network failures propagate', async () => {
  for (const error of ['401 unauthorized', 'network unavailable']) {
    const a = manager(),
      calls: any[] = [];
    a.sidecar = () => ({
      call: async (...args: any[]) => {
        calls.push(args);
        if (calls.length === 1) throw new Error(error);
        return { rateLimits: snapshot() };
      },
    });
    a.refresh = async (account: any) => assert.equal(account.id, 'a');
    if (error.startsWith('401')) {
      await a.resetCredits('a');
      assert.deepEqual(calls[0], calls[1]);
    } else await assert.rejects(a.resetCredits('a'), /network unavailable/);
  }
});

test('all known redemption outcomes release the lock and finish the logical attempt', async () => {
  for (const outcome of ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']) {
    const a = manager();
    a.sidecar = (account: any) => ({
      call: async (method: string, params: any) => {
        assert.equal(account.id, 'a');
        assert.equal(method, 'account/rateLimitResetCredit/consume');
        assert.equal(params.creditId, 'card');
        assert.match(params.idempotencyKey, /^[0-9a-f-]{36}$/);
        return { outcome };
      },
    });
    assert.deepEqual(await a.consumeResetCredit('a', 'card'), { outcome });
    assert.equal(a.resetting.size, 0);
    assert.equal(a.resetAttempts.size, 0);
  }
});

test('uncertain failures reuse the request key for explicit cards and count-only redemption', async () => {
  for (const creditId of ['card', null, undefined]) {
    const a = manager(),
      params: any[] = [];
    a.sidecar = () => ({
      call: async (_method: string, p: any) => {
        params.push(p);
        if (params.length === 1) throw new Error('timeout');
        return { outcome: 'alreadyRedeemed' };
      },
    });
    await assert.rejects(a.consumeResetCredit('a', creditId), /timeout/);
    assert.equal(a.resetting.size, 0);
    assert.equal(a.resetAttempts.size, 1);
    await a.consumeResetCredit('a', creditId);
    assert.deepEqual(params[0], params[1]);
    assert.equal(params[0].creditId, creditId ?? null);
    assert.equal(a.resetAttempts.size, 0);
  }
});

test('unknown or missing outcomes retain the request key instead of assuming success', async () => {
  for (const reply of [{ outcome: 'unknown' }, {}, null]) {
    const a = manager(),
      keys: string[] = [];
    a.sidecar = () => ({
      call: async (_m: string, p: any) => {
        keys.push(p.idempotencyKey);
        return keys.length === 1 ? reply : { outcome: 'reset' };
      },
    });
    await a.consumeResetCredit('a');
    await a.consumeResetCredit('a');
    assert.equal(keys[0], keys[1]);
  }
});

test('overlapping redemptions across windows are blocked per account but not across accounts', async () => {
  const a = manager([row(), row('b')]),
    pending = deferred(),
    calls: string[] = [];
  a.sidecar = (account: any) => ({
    call: () => {
      calls.push(account.id);
      return account.id === 'a' ? pending.promise : Promise.resolve({ outcome: 'reset' });
    },
  });
  const first = a.consumeResetCredit('a', 'one');
  await assert.rejects(a.consumeResetCredit('a', 'two'), /already being used/);
  a.state.active = 'b';
  await a.consumeResetCredit('b');
  pending.resolve({ outcome: 'reset' });
  await first;
  assert.deepEqual(calls, ['a', 'b']);
});
