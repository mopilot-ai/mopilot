// What the identity registry's instances say each plan login has left and how big its plan is (electron/identity/drivers,
// contract/registry.cjs), read by harness "auto" through shared/remainingCapacity.mjs: Codex from its last usage reading,
// Claude Code from what main has seen of each login; unknown stays null, and pay per use has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { codexInstance } = req('../electron/identity/drivers/codex.cjs');
const { claudeInstances } = req('../electron/identity/drivers/claude.cjs');
const { instance, PROVIDERS } = req('../electron/identity/contract/registry.cjs');

const NOW = 1_800_000_000_000;
const ahead = NOW / 1000 + 3600;
const past = NOW / 1000 - 60;

test('Codex: percent left of the tightest window still running, and the plan’s size from its plan type', () => {
  const login = (limits: any, planType: string | null = 'pro') =>
    codexInstance({ id: 'a', kind: 'chatgpt', status: 'ok', planType, limits }, 'a', false, NOW);
  const both = login({ primary: { usedPercent: 30, resetsAt: ahead }, secondary: { usedPercent: 72.4, resetsAt: ahead }, used: 72.4 });
  assert.deepEqual([both.left, both.units], [28, 20]);
  // a window past its reset started over: only the other one is known
  assert.equal(login({ primary: { usedPercent: 99, resetsAt: past }, secondary: { usedPercent: 40, resetsAt: ahead } }).left, 60);
  assert.equal(login({ primary: { usedPercent: 99, resetsAt: past } }).left, null, 'every window reset since the reading');
  assert.equal(login({ primary: { resetsAt: null } }).left, 100, 'a window with no figure counts as unused, as the account view reads it');
  assert.equal(login({ used: 130 }).left, 0, 'a reading without windows says how much is used');
  assert.equal(login(null).left, null, 'never read');
  assert.deepEqual(
    ['prolite', 'plus', null, 'free'].map((p) => login(null, p).units),
    [5, 1, null, null],
  );
  // pay per use has no plan usage to read
  const key = codexInstance({ id: 'k', kind: 'apiKey', status: 'ok', limits: { used: 10 } }, 'k', false, NOW);
  assert.deepEqual([key.billing, key.left, key.units], ['apiKey', null, null]);
  const credits = codexInstance({ id: 'm', mopilot: true, status: 'ok' }, 'm', false, NOW);
  assert.deepEqual([credits.billing, credits.left, credits.units], ['credits', null, null]);
});

test('Claude Code: what main last saw left on each login, unknown once a limit it saw has lifted; plan size from the CLI’s tier', () => {
  const marks = new Map<string, any>([
    ['default', { left: 42 }],
    ['max', { left: 0, limitedUntil: NOW + 60_000 }],
    ['back', { left: 0, limitedUntil: NOW - 1 }],
  ]);
  const view = {
    active: 'default',
    accounts: [
      { id: 'default', email: 'a@x', loggedIn: true, subscriptionType: 'pro' },
      { id: 'max', email: 'b@x', loggedIn: true, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
      { id: 'back', email: 'c@x', loggedIn: true, organizationType: 'claude_team' },
      { id: 'new', email: 'd@x', loggedIn: true },
    ],
  };
  const out = claudeInstances(
    view,
    { set: false, mode: 'subscription', baseUrl: null },
    false,
    { get: (id: string) => marks.get(id) },
    NOW,
  );
  assert.deepEqual(
    out.map((i: any) => [i.account, i.limited, i.left, i.units]),
    [
      ['default', false, 42, 1],
      ['max', true, 0, 20],
      ['back', false, null, 1],
      ['new', false, null, null],
    ],
  );
  // without marks: nothing is known
  assert.equal(claudeInstances(view, { set: false, mode: 'subscription', baseUrl: null }, false, null, NOW)[0].left, null);
});

test('an instance keeps a reading in 0..100 and a plan size above zero, else null', () => {
  const make = (o: any) =>
    instance({ harness: 'codex', account: 'a', provider: PROVIDERS.openai, kind: 'cliLogin', billing: 'subscription', ...o });
  assert.deepEqual([make({}).left, make({}).units], [null, null]);
  assert.deepEqual([make({ left: 140 }).left, make({ left: -3 }).left, make({ left: Number.NaN }).left], [100, 0, null]);
  assert.deepEqual([make({ units: 0 }).units, make({ units: 5 }).units, make({ units: '5' }).units], [null, 5, null]);
});
