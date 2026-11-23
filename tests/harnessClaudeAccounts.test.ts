// Claude Code harness, renderer side (src/session/harness/claude.ts): detection, models, plan usage, logins.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset, tick } from './support/harness-logic-fakes.ts';
import { defined } from './support/defined.ts';

const intervals: (() => void)[] = [];
const realInterval = globalThis.setInterval;
globalThis.setInterval = ((fn: () => void) => (intervals.push(fn), { unref() {} })) as any;
after(() => void (globalThis.setInterval = realInterval));
const claude = await import('../src/session/harness/claude.ts');
const { claudeThreadId } = await import('../src/harness/types.ts');

const flush = async () => {
  for (let i = 0; i < 12; i++) await tick();
};
const ready = (o: any = {}) => ({
  state: 'ready',
  bin: '/bin/claude',
  version: '2.1',
  candidates: [],
  auth: { subscriptionType: 'max' },
  plan: { organizationType: null, rateLimitTier: 'default_claude_max_20x' },
  ...o,
});
const USAGE = 'Current session: 10% used · resets 5pm\nCurrent week (all models): 40% used';

let detects: any[];
function claudeNative(o: any = {}) {
  detects = [];
  fx.native.claude = {
    detect: async (bin: any, force: boolean, verify: boolean, account?: string) => (detects.push({ bin, force, verify, account }), ready()),
    probe: async () => ({
      models: [{ value: 'opus', displayName: 'Opus' }],
      account: { subscriptionType: 'max', email: 'me@x' },
      fastBlocked: null,
    }),
    refreshAccounts: async () => fx.state.claudeAccounts,
    signInEnded: async () => {},
    list: async () => [],
    usage: async () => ({ state: 'success', text: USAGE }),
    ...o,
  };
}

beforeEach(() => {
  reset();
  claudeNative();
});

test('detection signed out: status from auth, no probe, nothing loaded', async () => {
  let probed = 0;
  claudeNative({
    detect: async () => ready({ state: 'signin', bin: null, auth: null, plan: null, error: 'Not logged in' }),
    probe: async () => probed++,
  });
  fx.state.claude.status = { state: 'ready', email: 'old@x', usage: null };
  fx.state.claudeUsage = { default: { windows: [], at: 1 } };
  await claude.detectClaude(true);
  const st = fx.state.claude.status;
  assert.deepEqual([st.state, st.bin, st.plan, st.email, st.error], ['signin', null, null, 'old@x', 'Not logged in']);
  assert.deepEqual(st.usage, { windows: [], at: 1 });
  assert.equal(probed, 0);
  // a ready login the CLI can't be found for is not probed either
  claudeNative({ detect: async () => ready({ bin: null }), probe: async () => probed++ });
  fx.state.claude.status = { state: 'ready' };
  await claude.detectClaude(true);
  assert.equal(probed, 0);
  assert.equal(fx.state.claude.status.email, null);
  await flush();
});

test('detection ready: models, plan, email, accounts, chats and usage; the usage timer starts once', async () => {
  fx.state.claude.status = { state: 'detecting', email: null };
  await claude.detectClaude(true);
  await flush();
  const st = fx.state.claude.status;
  assert.deepEqual([st.state, st.plan, st.email, st.fastBlocked], ['ready', 'Claude Max 20×', 'me@x', null]);
  assert.deepEqual(
    fx.state.claude.models.map((m: any) => m.id),
    ['opus'],
  );
  assert.deepEqual(
    fx.state.claudeUsage.default.windows.map((w: any) => [w.label, w.usedPercent]),
    [
      ['5h', 10],
      ['Weekly', 40],
    ],
  );
  assert.equal(fx.state.claude.status.usage.fetchState, 'success');
  const timers = intervals.length;
  await claude.detectClaude(true);
  await flush();
  assert.equal(intervals.length, timers, 'one usage timer');
  // detection on its own asks as a surface opening; a Re-check the user asked for reads at once
  const reasons: string[] = [];
  claudeNative({ usage: async (_b: string, _id: string, why: string) => (reasons.push(why), { state: 'success', text: USAGE }) });
  await claude.detectClaude(true);
  await flush();
  await claude.detectClaude(true, true);
  await flush();
  assert.deepEqual(reasons, ['surface', 'now']);
  // the plan falls back to detection's when the probe has none
  claudeNative({ probe: async () => ({ models: [], account: { email: null }, fastBlocked: 'extra_usage_disabled' }) });
  await claude.detectClaude(true);
  assert.deepEqual([fx.state.claude.status.plan, fx.state.claude.status.fastBlocked], ['Claude Max 20×', 'extra_usage_disabled']);
  await flush();
});

test('detection with an API key names its billing; a failed probe keeps the error', async () => {
  claudeNative({ detect: async () => ready({ state: 'apikey', billing: { label: 'Console key' } }) });
  await claude.detectClaude(true);
  assert.equal(fx.state.claude.status.plan, 'Console key');
  claudeNative({ detect: async () => ready({ state: 'apikey' }) });
  await claude.detectClaude(true);
  assert.equal(fx.state.claude.status.plan, 'API key');
  claudeNative({
    probe: async () => {
      throw new Error('probe timed out');
    },
  });
  await claude.detectClaude(true);
  assert.equal(fx.state.claude.status.error, 'probe timed out');
  claudeNative({
    probe: async () => {
      throw 'raw';
    },
  });
  await claude.detectClaude(true);
  assert.equal(fx.state.claude.status.error, 'raw');
  await flush();
});

test('a detection in flight is shared; a newer one or another login wins over a stale result', async () => {
  let release: (v: any) => void = () => {};
  claudeNative({ detect: () => new Promise((r) => (release = r)) });
  const a = claude.detectClaude(true);
  assert.equal(claude.detectClaude(), a);
  const firstRelease = release;
  const b = claude.detectClaude(true);
  const secondRelease = release;
  secondRelease(ready({ state: 'signin', bin: null }));
  await b;
  firstRelease(ready({ state: 'error', bin: null, error: 'stale' }));
  await a;
  assert.equal(fx.state.claude.status.state, 'signin', 'the older detection is dropped');
  // the login in use changed while detecting
  const c = claude.detectClaude(true);
  fx.state.claudeAccounts = { active: 'other', accounts: [] };
  release(ready({ state: 'error', bin: null }));
  await c;
  assert.equal(fx.state.claude.status.state, 'detecting');
  // the login changed while the account list was read
  fx.state.claudeAccounts = { active: 'default', accounts: [] };
  let listed = 0;
  let releaseAccounts: (v: any) => void = () => {};
  claudeNative({ refreshAccounts: () => new Promise((r) => (releaseAccounts = r)), list: async () => (listed++, []) });
  const d = claude.detectClaude(true);
  await flush();
  fx.state.claudeAccounts = { active: 'moved', accounts: [] };
  releaseAccounts({ active: 'moved', accounts: [] });
  await d;
  assert.equal(listed, 0);
  // a failed account refresh is ignored
  fx.state.claudeAccounts = { active: 'default', accounts: [] };
  claudeNative({
    refreshAccounts: async () => {
      throw new Error('x');
    },
    list: async () => (listed++, []),
  });
  await claude.detectClaude(true);
  assert.equal(listed, 1);
  await flush();
});

test('a detection that fails says why instead of staying "detecting"; a stale one leaves the newer status', async () => {
  claudeNative({
    detect: async () => {
      throw new Error("Error invoking remote method 'claude:detect': Error: spawn EACCES");
    },
  });
  await claude.detectClaude(true);
  assert.deepEqual([fx.state.claude.status.state, fx.state.claude.status.error], ['error', 'spawn EACCES']);
  // superseded by a newer detection while it failed: the newer one's status stands
  let fail: (e: Error) => void = () => {};
  claudeNative({ detect: () => new Promise((_r, j) => (fail = j)) });
  const old = claude.detectClaude(true);
  const failOld = fail;
  claudeNative();
  await claude.detectClaude(true);
  failOld(new Error('late'));
  await old;
  assert.equal(fx.state.claude.status.state, 'ready');
  // Re-check reports a login whose own check failed, instead of saying nothing
  claudeNative({
    detect: async (_b: any, _f: any, _v: any, account?: string) => {
      if (account === 'work') throw new Error('timed out');
      return ready();
    },
  });
  await claude.recheckClaude('work');
  assert.deepEqual(called('toast').at(-1), ['Claude Code: timed out', 'error']);
  await flush();
});

test('verifying a login clears its authentication errors, on its own chats only', async () => {
  const mine = claudeThreadId('auth-a');
  const other = claudeThreadId('auth-b');
  const clean = claudeThreadId('auth-c');
  const authErr = (id: string) => ({ id, status: 'failed', items: [], error: { message: 'Failed to authenticate' } });
  fx.state.claudeAccounts = {
    active: 'default',
    accounts: [
      { id: 'default', loggedIn: true },
      { id: 'work', loggedIn: true },
    ],
  };
  fx.state.claudeChats = { [other]: { id: 'work' } };
  fx.state.runtime = {
    [mine]: { turns: [authErr('t1'), { id: 't2', status: 'failed', error: { message: 'Network' }, items: [] }] },
    [other]: { turns: [authErr('t3')] },
    [clean]: { turns: [{ id: 't4', error: null, items: [] }] },
    'codex-1': { turns: [authErr('t5')] },
  };
  await claude.detectClaude(true, true);
  assert.equal(fx.state.runtime[mine].turns[0].error, null);
  assert.equal(fx.state.runtime[mine].turns[1].error.message, 'Network');
  assert.equal(fx.state.runtime[other].turns[0].error.message, 'Failed to authenticate');
  assert.equal(fx.state.runtime['codex-1'].turns[0].error.message, 'Failed to authenticate');
  // the account main names is the one verified
  fx.state.runtime[mine].turns.push(authErr('t6'));
  claudeNative({ detect: async () => ready({ account: 'work' }) });
  await claude.detectClaude(true, true);
  assert.equal(fx.state.runtime[other].turns[0].error, null);
  assert.equal(fx.state.runtime[mine].turns[2].error.message, 'Failed to authenticate');
  // a second verify of the first login adds to its dismissed set
  claudeNative();
  await claude.detectClaude(true, true);
  assert.equal(fx.state.runtime[mine].turns[2].error, null);
  await flush();
});

test('Re-check says what happened: signed in, still signed out, or the error', async () => {
  await claude.recheckClaude();
  assert.deepEqual(called('toast').at(-1), ['Claude Code is signed in.']);
  claudeNative({ detect: async () => ready({ state: 'apikey' }) });
  await claude.recheckClaude();
  assert.deepEqual(called('toast').at(-1), ['Claude Code is signed in.']);
  claudeNative({ detect: async () => ready({ state: 'signin', bin: null }) });
  await claude.recheckClaude();
  assert.match(defined(called('toast').at(-1))[0], /still signed out/);
  claudeNative({ detect: async () => ready({ state: 'error', bin: null, error: 'boom\nstack' }) });
  await claude.recheckClaude();
  assert.deepEqual(called('toast').at(-1), ['Claude Code: boom', 'error']);
  // a refused key says so, never `claude auth login`
  claudeNative({ detect: async () => ready({ state: 'error', error: 'Key refused.', rejected: true }) });
  await claude.recheckClaude();
  assert.deepEqual([called('toast').at(-1), fx.state.claude.status.rejected], [['Claude Code: Key refused.', 'error'], true]);
  claudeNative({ detect: async () => ready({ state: 'missing', bin: null }) });
  await claude.recheckClaude();
  assert.deepEqual(called('toast').at(-1), ["Claude Code isn't found. Install it, or set its location in Settings.", 'error']);
  // another login: checked on its own, and its result is what the toast reports
  claudeNative({
    detect: async (_b: any, _f: any, _v: any, account?: string) => (
      detects.push(account), account === 'work' ? ready({ state: 'signin' }) : ready()
    ),
  });
  await claude.recheckClaude('work');
  assert.ok(detects.includes('work'));
  assert.match(defined(called('toast').at(-1))[0], /still signed out/);
  claudeNative({
    detect: async (_b: any, _f: any, _v: any, account?: string) => (account === 'work' ? ready({ state: 'apikey' }) : ready()),
  });
  await claude.recheckClaude('work');
  assert.deepEqual(called('toast').at(-1), ['Claude Code is signed in.']);
  // the active login named explicitly is checked once
  await claude.recheckClaude('default');
  assert.deepEqual(called('toast').at(-1), ['Claude Code is signed in.']);
  await flush();
});

test('signing in again from a terminal: the command opens beside the chat and the login is re-checked after', async () => {
  fx.state.route = { name: 'thread', id: 'x' };
  claudeNative({ reloginCommand: async () => ['/bin/claude', 'auth', 'login'] });
  await claude.reloginClaudeAccount('work');
  assert.deepEqual(called('openPaneTab').at(-1), [
    'terminal',
    { command: ['/bin/claude', 'auth', 'login'], title: 'claude auth login', cwd: '/home/me', signIn: true },
  ]);
  assert.equal(called('navigate').length, 0);
  // the relogging login is verified on the next re-check, then forgotten
  claudeNative({ detect: async (_b: any, _f: any, _v: any, account?: string) => (detects.push(account ?? 'active'), ready()) });
  await claude.recheckClaude();
  assert.deepEqual(detects, ['active', 'work']);
  await claude.recheckClaude();
  assert.deepEqual(detects.slice(2), ['active']);
  // no command: nothing opens
  claudeNative({
    reloginCommand: async () => {
      throw new Error('no bin');
    },
  });
  await claude.reloginClaudeAccount('work');
  assert.equal(called('openPaneTab').length, 1);
  await flush();
});

test('adding a login: in Settings the terminal is embedded; elsewhere it opens beside the chat', async () => {
  fx.state.route = { name: 'settings' };
  claudeNative({
    addAccount: async () => ({ state: { active: 'default', accounts: [{ id: 'new' }] }, command: ['claude', 'auth', 'login'] }),
  });
  assert.equal(claude.useClaudeLoginTerm(), null);
  await claude.addClaudeAccount();
  assert.ok(fx.notified >= 1);
  const term = claude.useClaudeLoginTerm()!;
  assert.deepEqual([term.title, term.command], ['claude auth login', ['claude', 'auth', 'login']]);
  assert.deepEqual(fx.state.claudeAccounts.accounts, [{ id: 'new' }]);
  fx.cleanups.forEach((c) => c());
  claudeNative({
    refreshAccounts: async () => {
      throw new Error('x');
    },
  });
  claude.endClaudeLoginTerm();
  assert.equal(claude.useClaudeLoginTerm(), null);
  await flush();
  fx.state.route = { name: 'plugins' };
  claudeNative({ addAccount: async () => ({ state: fx.state.claudeAccounts, command: ['c'] }) });
  await claude.addClaudeAccount();
  assert.deepEqual(called('navigate').at(-1), [{ name: 'home' }]);
  fx.state.route = { name: 'home' };
  await claude.addClaudeAccount();
  assert.equal(called('navigate').length, 1);
  claudeNative({
    addAccount: async () => {
      throw new Error("Error invoking remote method 'claude:add': Error: no CLI");
    },
  });
  await claude.addClaudeAccount();
  assert.deepEqual(called('toast').at(-1), ['no CLI', 'error']);
  claudeNative({ cancelAccountLogin: async () => ({ active: 'default', accounts: [] }) });
  await claude.cancelClaudeLogin();
  assert.deepEqual(fx.state.claudeAccounts.accounts, []);
});

test('switching the login in use swaps the status to its usage and detects again', async () => {
  fx.state.claudeUsage = { work: { windows: [{ label: '5h', usedPercent: 3 }], at: 1 } };
  fx.state.claude.status = { state: 'ready', bin: '/bin/claude', email: 'a@x', plan: 'Max', usage: null };
  let detected = 0;
  claudeNative({
    setActiveAccount: async (id: string) => ({ active: id, accounts: [{ id, loggedIn: true }] }),
    detect: () => (detected++, new Promise(() => {})),
  });
  await claude.switchClaudeAccount('work');
  assert.equal(fx.state.claudeAccounts.active, 'work');
  assert.deepEqual([fx.state.claude.status.email, fx.state.claude.status.plan], [null, null]);
  assert.deepEqual(fx.state.claude.status.usage, { windows: [{ label: '5h', usedPercent: 3 }], at: 1 });
  await flush();
  assert.equal(detected, 1);
  // the same login again changes nothing else
  await claude.switchClaudeAccount('work');
  await flush();
  assert.equal(detected, 1);
  fx.state.claudeUsage = {};
  await claude.switchClaudeAccount('other');
  assert.equal(fx.state.claude.status.usage, null);
  claudeNative({
    setActiveAccount: async () => {
      throw 'nope';
    },
  });
  await claude.switchClaudeAccount('x');
  assert.deepEqual(called('toast').at(-1), ['nope', 'error']);
  await flush();
});

test("removing a login: the CLI's own signs out in the background; an added one is forgotten with its chats", async () => {
  const chatA = claudeThreadId('rm-a');
  fx.state.claude.status.bin = null;
  let loggedOut = 0;
  claudeNative({ logout: async () => loggedOut++ });
  await claude.removeClaudeAccount('default');
  assert.equal(loggedOut, 0);
  fx.state.claude.status.bin = '/bin/claude';
  await claude.removeClaudeAccount('default');
  assert.equal(loggedOut, 1);
  claudeNative({
    logout: async () => {
      throw new Error('busy');
    },
  });
  await claude.removeClaudeAccount('default');
  assert.deepEqual(called('toast').at(-1), ['busy', 'error']);
  fx.state.claudeChats = { [chatA]: { id: 'work' }, keep: { id: 'home' } };
  claudeNative({ removeAccount: async () => ({ active: 'default', accounts: [{ id: 'home' }] }) });
  await claude.removeClaudeAccount('work');
  assert.deepEqual(Object.keys(fx.state.claudeChats), ['keep']);
  claudeNative({
    removeAccount: async () => {
      throw new Error('locked');
    },
  });
  await claude.removeClaudeAccount('home');
  assert.deepEqual(called('toast').at(-1), ['locked', 'error']);
  await flush();
});

test('auto-switch, pinning a chat, and the login a chat runs on', async () => {
  claudeNative({ setAccountAutoSwitch: async (on: boolean) => ({ active: 'default', accounts: [], autoSwitch: on }) });
  await claude.setClaudeAutoSwitch(true);
  assert.equal(fx.state.claudeAccounts.autoSwitch, true);
  const chat = claudeThreadId('pin');
  claude.pinClaudeChat(chat, 'work');
  assert.deepEqual(fx.state.claudeChats[chat], { id: 'work', pinned: true });
  // no account list: only the CLI's own login counts as signed in
  assert.equal(claude.claudeChatAccount(chat), 'default');
  fx.state.claudeChats[chat] = { id: 'default' };
  assert.equal(claude.claudeChatAccount(chat), 'default');
  fx.state.claudeAccounts = {
    active: 'home',
    accounts: [
      { id: 'work', loggedIn: true },
      { id: 'old', loggedIn: false },
    ],
  };
  fx.state.claudeChats[chat] = { id: 'work' };
  assert.equal(claude.claudeChatAccount(chat), 'work');
  fx.state.claudeChats[chat] = { id: 'old' };
  assert.equal(claude.claudeChatAccount(chat), 'home');
  fx.state.claudeChats[chat] = { id: 'gone' };
  assert.equal(claude.claudeChatAccount(chat), 'home');
  claude.pinClaudeChat(chat, null);
  assert.equal(fx.state.claudeChats[chat], undefined);
  assert.equal(claude.claudeChatAccount('nobody'), 'home');
});

test('plan usage: every signed-in subscription login; readings, failures and removed logins', async () => {
  const reads: string[] = [];
  claudeNative({ usage: async (_bin: string, id: string) => (reads.push(id), { state: 'success', text: USAGE }) });
  fx.state.claude.status = { state: 'ready', bin: '/bin/claude', usage: null };
  fx.state.claudeAccounts = {
    active: 'a',
    accounts: [
      { id: 'a', loggedIn: false },
      { id: 'b', loggedIn: true, authMethod: 'claude.ai' },
      { id: 'k', loggedIn: true, authMethod: 'console' },
      { id: 'out', loggedIn: false },
    ],
    same: { default: 'b' }, // the CLI login folded into b (#1312): read, so main sees a later re-sign
  };
  await claude.refreshClaudeUsage();
  await flush();
  assert.deepEqual(reads.sort(), ['a', 'b', 'default']);
  assert.equal(fx.state.claudeUsage.default, undefined, "a folded login's figures are not kept: its account shows them once");
  assert.equal(fx.state.claude.status.usage.windows.length, 2, 'the login in use updates the status');
  assert.equal(fx.state.claudeUsage.b.windows.length, 2);
  // an answer older than the chat's live reading, asked for again each minute, leaves the store as it is
  const live = {
    windows: [{ label: '5h', usedPercent: 1, resetsAt: 9e9 }],
    at: Date.now() + 60_000,
    fetchState: 'success',
    fetchError: null,
  };
  const read = fx.state.claudeUsage.b;
  fx.state.claudeUsage = { ...fx.state.claudeUsage, b: live };
  claudeNative({ usage: async () => ({ state: 'success', text: USAGE, measuredAt: 1 }) });
  await claude.refreshClaudeUsage();
  assert.equal(fx.state.claudeUsage.b, live);
  fx.state.claudeUsage = { ...fx.state.claudeUsage, b: read };
  // an unrecognized reading is kept as a failure without losing the last reading
  claudeNative({ usage: async () => ({ state: 'success', text: 'something' }) });
  await claude.refreshClaudeUsage();
  await flush();
  assert.equal(fx.state.claudeUsage.b.fetchState, 'unavailable');
  assert.equal(fx.state.claudeUsage.b.windows.length, 2);
  // a login removed while its read was running gets no entry back
  claudeNative({
    usage: async (_b: string, id: string) => {
      if (id === 'b')
        fx.state.claudeAccounts = {
          ...fx.state.claudeAccounts,
          accounts: fx.state.claudeAccounts.accounts.filter((x: any) => x.id !== 'b'),
        };
      return { state: 'success', text: USAGE };
    },
  });
  fx.state.claudeUsage = {};
  await claude.refreshClaudeUsage();
  await flush();
  assert.equal(fx.state.claudeUsage.b.fetchState, 'loading', 'the reading itself is dropped');
  // no account list yet: the login in use; Claude gone mid-read reports it (main backs off; nothing retries here)
  fx.state.claudeAccounts = { active: 'default', accounts: [] };
  const p = claude.refreshClaudeUsage();
  fx.state.claude.status = { ...fx.state.claude.status, bin: null };
  await p;
  assert.equal(fx.state.claudeUsage.default.fetchState, 'error');
  assert.equal(fx.state.claudeUsage.default.fetchError, 'Claude Code is not installed.');
});
