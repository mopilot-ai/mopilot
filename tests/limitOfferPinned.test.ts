// The paid-access offer for an account chats are pinned to (src/session/harness/billing.ts, design/multi-account R-8): it
// can run out while the account in use has room, on either first-tier harness.
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset, tick } from './support/harness-logic-fakes.ts';
import { defined } from './support/defined.ts';

const claudePins: any[] = [];
mock.module(new URL('../src/session/harness/claude.ts', import.meta.url).href, {
  namedExports: {
    recheckClaude: async () => {},
    pinClaudeChat: (...a: any[]) => void claudePins.push(a),
    ...Object.fromEntries(
      ['addClaudeAccount', 'reloginClaudeAccount', 'removeClaudeAccount', 'switchClaudeAccount'].map((n) => [n, () => {}]),
    ),
  },
});
const billing = await import('../src/session/harness/billing.ts');

const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 3600;
const codexReady = (used: number, extra: any = {}) => ({
  conn: 'ready',
  rateLimits: { rateLimits: { primary: { usedPercent: used, windowDurationMins: 300, resetsAt: future() } } },
  account: { type: 'chatgpt' },
  ...extra,
});
const fire = () => fx.listeners.forEach((l) => l(fx.state, fx.state));
let watching = false;
beforeEach(async () => {
  reset();
  claudePins.length = 0;
  if (!watching) {
    fx.native.claude = { apiKey: async () => ({ mode: 'subscription', set: false }) };
    billing.startLimitWatch();
    await tick();
    watching = true;
  }
});

/* ---------- an account a chat is pinned to runs out (R-8) ---------- */
const seg = (harness: string, nativeId: string) => ({ harness, nativeId, start: 0, count: null, model: null, handoff: null });

test("Codex: a chat pinned to an account that isn't the one in use is offered paid access when that account runs out", async () => {
  const out = { used: 100, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: future() + 11 } };
  Object.assign(fx.state, codexReady(10), {
    accounts: {
      active: 'a',
      autoSwitch: false,
      relay: true,
      chatAccounts: { cx: { id: 'pinned-b', pinned: true }, cy: { id: 'pinned-b', pinned: false } },
      accounts: [
        { id: 'a', kind: 'chatgpt', status: 'ok', email: 'a@x', limits: codexReady(10).rateLimits.rateLimits },
        { id: 'pinned-b', kind: 'chatgpt', status: 'ok', email: 'b@x', limits: out },
        { id: 'key', kind: 'apiKey', status: 'ok' },
      ],
    },
    // cx is pinned, cy only placed there by the pool, cz is a Claude chat
    runtime: { cx: {}, cy: {}, cz: {} },
    segments: { cz: [seg('claude', 'claude:z')] },
  });
  // "Ask to use paid access" (auto-switch off alone means Stop)
  fx.state.prefs.limitAsk = { codex: true };
  // the mode switch makes the key the account in use
  fx.store.setCodexMode = async () => void (fx.state.accounts = { ...fx.state.accounts, active: 'key' });
  fire();
  assert.equal(called('toast').length, 1);
  const [text, kind, opts] = defined(called('toast')[0]);
  assert.equal(text, 'Codex (b@x, pinned to a chat) has reached its subscription limit');
  assert.equal(kind, 'error');
  assert.equal(opts.action.label, 'Continue with API key');
  fire();
  assert.equal(called('toast').length, 1, 'offered once per account and window');
  await opts.action.run();
  assert.deepEqual(called('setCodexMode'), [['apiKey']]);
  // unpinned, the relay would keep it on B with auto-switch off: it goes on the account now in use
  assert.deepEqual(called('pinCodexChat'), [['cx', 'key']], 'the pinned chat leaves the account that ran out');
  assert.deepEqual(called('toast').at(-1), ['Codex now bills your API key', 'success']);
});

test('no offer for a pinned account that has room, started over, is the one in use, or another subscription takes over', () => {
  const pool = (limits: any, autoSwitch = false, active = 'a') => ({
    ...codexReady(10),
    accounts: {
      active,
      autoSwitch,
      relay: true,
      chatAccounts: { cx: { id: 'b2', pinned: true } },
      accounts: [
        { id: 'a', kind: 'chatgpt', status: 'ok', limits: codexReady(10).rateLimits.rateLimits },
        { id: 'b2', kind: 'chatgpt', status: 'ok', email: 'b@x', limits: { used: limits.primary.usedPercent, ...limits } },
        { id: 'key', kind: 'apiKey', status: 'ok' },
      ],
    },
    runtime: { cx: {} },
  });
  fx.state.prefs.limitAsk = { codex: true };
  Object.assign(fx.state, pool({ primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: future() } }));
  fire();
  // the window ran out but has started over since (its reset is past)
  Object.assign(fx.state, pool({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: past() } }));
  fire();
  // an old reading of the pinned account (no fresh one since) doesn't ask to pay: a fresh one will
  Object.assign(
    fx.state,
    pool({ at: Date.now() - 11 * 60_000, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: future() + 21 } }),
  );
  fire();
  assert.equal(called('toast').length, 0);
  // "Switch subscription": the other subscription takes over on its own
  fx.state.prefs.limitAsk = {};
  Object.assign(fx.state, pool({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: future() + 13 } }, true));
  fire();
  assert.equal(called('toast').length, 0);
  // the pinned account is the one in use: offered once, as the account in use
  fx.state.prefs.limitAsk = { codex: true };
  Object.assign(fx.state, pool({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: future() + 17 } }, false, 'b2'));
  fire();
  assert.deepEqual(
    called('toast').map((c) => /pinned/.test(c[0])),
    [false],
  );
});

test('Claude: chats pinned to a login that ran out are offered paid access, and taking it moves them', async () => {
  await billing.applyClaudeKey(async () => ({ mode: 'subscription', set: true }) as any);
  const CL1 = 'claude:one';
  const CL2 = 'claude:two';
  fx.state.claude.status = { state: 'ready', usage: { windows: [{ label: '5h', usedPercent: 20, resetsAt: future() }] } };
  fx.state.claudeAccounts = {
    active: 'a',
    autoSwitch: false,
    accounts: [
      { id: 'a', loggedIn: true, email: 'a@x' },
      { id: 'cb', loggedIn: true, email: 'b@x' },
      { id: 'console', loggedIn: true, email: 'k@x', authMethod: 'console' },
    ],
  };
  fx.state.claudeUsage = {
    cb: { windows: [{ label: '5h', usedPercent: 100, resetsAt: future() + 19 }], source: 'live', at: Date.now() },
    console: { windows: [{ label: '5h', usedPercent: 100, resetsAt: future() }], source: 'live', at: Date.now() },
  };
  fx.state.claudeChats = {
    [CL1]: { id: 'cb', pinned: true },
    [CL2]: { id: 'cb', pinned: true },
    'claude:three': { id: 'console', pinned: true },
  };
  fx.state.runtime = { [CL1]: {}, [CL2]: {}, 'claude:three': {} };
  fx.state.segments = { [CL1]: [seg('claude', CL1)], [CL2]: [seg('claude', CL2)], 'claude:three': [seg('claude', 'claude:three')] };
  const modes: string[] = [];
  fx.native.claude = { setAuthMode: async (m: string) => (modes.push(m), { mode: m, set: true }) };
  fx.state.prefs.limitAsk = { claude: true };
  fire();
  // a Console login bills per token: it has no subscription to run out of
  assert.equal(called('toast').length, 1);
  const [text, , opts] = defined(called('toast')[0]);
  assert.equal(text, 'Claude Code (b@x, pinned to 2 chats) has reached its subscription limit');
  // before the click the user pinned the second chat to another login: that newer pin stays (#1988)
  fx.state.claudeChats = { ...fx.state.claudeChats, [CL2]: { id: 'a', pinned: true } };
  await opts.action.run();
  assert.deepEqual(modes, ['apiKey']);
  assert.deepEqual(claudePins, [[CL1, null]]);
});

test("a write that only moved a chat's runtime entry does not run the limit check; any other write does", () => {
  let reads = 0;
  const prefs = fx.state.prefs;
  const before = { ...fx.state, runtime: { a: {} } };
  const after = { ...fx.state, runtime: { a: { turns: [1] } } };
  Object.defineProperty(fx.state, 'prefs', { get: () => (reads++, prefs), configurable: true });
  fx.listeners.forEach((l) => l(after, before));
  assert.equal(reads, 0);
  fx.listeners.forEach((l) => l({ ...after, accounts: { ...after.accounts } }, before));
  assert.ok(reads > 0);
});
