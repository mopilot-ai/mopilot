// shared/remainingCapacity.mjs: one measure of what a harness or an account has left (fraction left times plan size), read
// by harness "auto" from the identity registry's instances and by MoMo's default brain from the account view, and the
// plan sizes both read: pay per use, all out, unknown usage, several accounts, basic (ACP) harnesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountRemaining, LOW_CAPACITY, planUnits, planUnitsOf, remainingCapacity } from '../shared/remainingCapacity.mjs';

type Inst = {
  account: string;
  status: string;
  limited: boolean;
  active?: boolean;
  billing?: string;
  left?: number | null;
  units?: number | null;
};
const plan = (account: string, left: number | null, units: number | null = null, o: Partial<Inst> = {}): Inst => ({
  account,
  status: 'ok',
  limited: false,
  billing: 'subscription',
  active: false,
  left,
  units,
  ...o,
});
const key = (active: boolean, billing = 'apiKey'): Inst => ({
  account: 'key',
  status: 'ok',
  limited: false,
  billing,
  active,
  left: null,
  units: null,
});

test('nothing known is null: no instances, no signed-in login, an inactive key alone, or no harness kind', () => {
  assert.equal(remainingCapacity(null, 'codex'), null);
  assert.equal(remainingCapacity(undefined, 'codex'), null);
  assert.equal(remainingCapacity([], 'codex'), null);
  assert.equal(remainingCapacity([plan('a', 50)], 'not-a-harness'), null);
  assert.equal(remainingCapacity([plan('a', 50, 1, { status: 'expired' })], 'codex'), null, 'a lapsed login runs nothing');
  assert.equal(remainingCapacity([key(false)], 'claude'), null, 'a key it isn’t set to carries no new session');
  assert.equal(remainingCapacity([{ account: 'x', status: 'ok', limited: false }], 'codex'), null, 'no billing named: not a plan login');
  assert.equal(remainingCapacity([null, plan('a', 40)] as any, 'codex')?.fraction, 0.4, 'an empty entry is skipped');
});

test('pay per use it runs on now is never out and has nothing to measure; it names the billing', () => {
  assert.deepEqual(remainingCapacity([plan('a', 3, 1, { limited: true }), key(true)], 'claude'), {
    limited: false,
    payPerUse: 'apiKey',
    fraction: null,
    units: null,
  });
  assert.equal(remainingCapacity([plan('a', 80), key(true, 'credits')], 'codex')?.payPerUse, 'credits');
  assert.equal(remainingCapacity([{ account: 'k', status: 'ok', limited: false, active: true }], 'codex')?.payPerUse, 'unknown');
  // a key that is there but not in use: the plan logins decide
  assert.deepEqual(remainingCapacity([plan('a', 30, 5), key(false)], 'claude'), {
    limited: false,
    payPerUse: null,
    fraction: 0.3,
    units: 1.5,
  });
});

test('several plan logins together: what each holds by its size, a login out holding none; out only when every one is', () => {
  // a Pro (1) at 50% and a Max 5× at 10%: 0.5 + 0.5 = 1 unit of 6
  const both = remainingCapacity([plan('pro', 50, 1), plan('max', 10, 5)], 'claude');
  assert.deepEqual(both, { limited: false, payPerUse: null, fraction: 1 / 6, units: 1 });
  // one out until its reset: it holds nothing, whatever its last reading said
  assert.deepEqual(remainingCapacity([plan('a', 40, 20), plan('b', 90, 5, { limited: true })], 'codex'), {
    limited: false,
    payPerUse: null,
    fraction: 8 / 25,
    units: 8,
  });
  assert.deepEqual(remainingCapacity([plan('a', 4, 1, { limited: true }), plan('b', null, null, { limited: true })], 'codex'), {
    limited: true,
    payPerUse: null,
    fraction: 0,
    units: 0,
  });
  // an unknown plan size counts as one unit
  assert.equal(remainingCapacity([plan('a', 60)], 'codex')?.units, 0.6);
});

test('a login that is not out with no usage reading leaves the whole not known, never guessed full or empty', () => {
  assert.deepEqual(remainingCapacity([plan('a', 5, 1), plan('b', null, 20)], 'codex'), {
    limited: false,
    payPerUse: null,
    fraction: null,
    units: null,
  });
  assert.deepEqual(remainingCapacity([plan('a', undefined as any)], 'claude'), {
    limited: false,
    payPerUse: null,
    fraction: null,
    units: null,
  });
});

test('a basic (ACP) harness is its own login, billed by the harness, with no usage reading: known only when out', () => {
  const acp = (account: string, o: Partial<Inst> = {}): Inst => ({
    account,
    status: 'ok',
    limited: false,
    billing: 'harness',
    active: true,
    ...o,
  });
  assert.deepEqual(remainingCapacity([acp('kimi'), acp('gemini')], 'acp:gemini'), {
    limited: false,
    payPerUse: null,
    fraction: null,
    units: null,
  });
  assert.equal(remainingCapacity([acp('kimi'), acp('gemini', { limited: true })], 'acp:gemini')?.limited, true);
  assert.equal(remainingCapacity([acp('kimi')], 'acp:gemini'), null);
  assert.equal(remainingCapacity([acp('gemini', { status: 'signedOut' })], 'acp:gemini'), null);
});

test('one account’s remaining: fraction left times its plan size, the fraction alone when the size is unknown', () => {
  assert.equal(accountRemaining({ left: 83, units: 20 }), 16.6);
  assert.equal(accountRemaining({ left: 62, units: null }), 0.62);
  assert.equal(accountRemaining({ left: 0, units: 5 }), 0);
  assert.equal(accountRemaining({ left: null, units: 5 }), null);
  assert.equal(accountRemaining({ left: undefined, units: undefined }), null);
  assert.ok(LOW_CAPACITY > 0 && LOW_CAPACITY < 1);
});

test('plan sizes read the names main holds (raw plan types, CLI tiers) as the account view’s labels', () => {
  // the account view's labels
  assert.deepEqual(
    ['Pro Lite', 'Pro', 'Plus', 'Business', 'Enterprise', 'Free', null].map((p) => planUnits('codex', p)),
    [5, 20, 1, 1, null, null, null],
  );
  assert.deepEqual(
    ['Claude Max 20×', 'Claude Max', 'Claude Pro', 'Claude Team'].map((p) => planUnits('claude', p)),
    [20, 5, 1, 1],
  );
  // what main has: Codex's planType, the Claude CLI's subscription type and rate-limit tier
  assert.deepEqual(
    ['prolite', 'pro_lite', 'pro', 'self_serve_business_usage_based'].map((p) => planUnits('codex', p)),
    [5, 5, 20, 1],
  );
  assert.deepEqual(
    ['max default_claude_max_20x', 'max', 'pro'].map((p) => planUnits('claude', p)),
    [20, 5, 1],
  );
  // a harness with no plan sizes
  assert.equal(planUnits('acp', 'Pro'), null);
  assert.equal(planUnits('toString', 'Pro'), null, 'only its own keys');
  assert.equal(planUnitsOf({ a: 2 }, ''), null);
});
