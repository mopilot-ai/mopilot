// The Codex pool's "Stop" choice and limit attribution (electron/identity/codexAccounts.cjs): with auto-switch off no
// path moves a chat or the app to another account, and a usage reading or a limited turn is charged to
// the login that produced it, not to whichever account is active now. Codex and the main app-server are
// faked (tests/support/electron-accounts.ts); data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, codex, flush, sub } from './support/electron-accounts.ts';

const homes = { b: 'b@example.com', c: 'c@example.com' };
const reading = (rateLimits: object) => ({ method: 'account/rateLimits/updated', params: { rateLimits } });
const FULL = { primary: { usedPercent: 100, resetsAt: 9e9 } };

/* ---------- relay routing (pickFor) ---------- */
test('Stop: a chat whose account ran out stays on it; the user pin is kept and nothing is announced', (t) => {
  const { a, notices } = setup(t, { state: { autoSwitch: false, accounts: [sub('b'), sub('c')], chatPins: { mine: 'b' } }, homes });
  a.pins.set('auto', { id: 'b', at: 0 });
  a.markLimited(a.get('b'), 9e9);
  assert.equal(a.pickFor('mine', new Set()).id, 'b');
  assert.equal(a.state.chatPins.mine, 'b');
  assert.equal(a.pickFor('auto', new Set()).id, 'b');
  assert.ok(a.pins.get('auto').at > 0, 'the pin is refreshed, not moved');
  assert.equal(notices().filter((n) => n.kind === 'moved').length, 0);
  // the refusal that follows ends the search
  assert.equal(a.pickFor('mine', new Set(['b'])), undefined);
});

test('Stop in a single pool: a new chat runs on the active account even when it is out, and the app never switches', async (t) => {
  const { a, notices } = setup(t, { state: { pool: 'single', autoSwitch: false, accounts: [sub('b'), sub('c')] }, homes });
  const switched: string[] = [];
  a.switchTo = async (id: string) => void switched.push(id);
  a.markLimited(a.get('default'), 9e9);
  assert.equal(a.pickFor('t1', new Set()).id, 'default');
  assert.equal(a.pins.get('t1').id, 'default');
  assert.equal(a.pickFor(null, new Set()).id, 'default');
  await flush();
  assert.deepEqual(switched, []);
  assert.equal(notices().length, 0);
  // the same request with auto-switch on does switch (the policy, not the pool, decides)
  a.state.autoSwitch = true;
  assert.notEqual(a.pickFor('t2', new Set()).id, 'default');
  await flush();
  assert.equal(switched.length, 1);
});

test('Stop in a spread pool still places a new chat on the account with the most left (placement is not a move)', (t) => {
  const { a } = setup(t, { state: { autoSwitch: false, accounts: [sub('b', { limits: { used: 5 } })] }, homes });
  a.get('default').limits = { used: 60 };
  assert.equal(a.pickFor('fresh', new Set()).id, 'b');
  // once placed, it stays there when that account runs out
  a.markLimited(a.get('b'), 9e9);
  assert.equal(a.pickFor('fresh', new Set()).id, 'b');
});

/* ---------- token refresh failover (answerRefresh) ---------- */
test('Stop: a lapsed sign-in is reported, never replaced by another account', async (t) => {
  const { a, sent, notices } = setup(t, { state: { autoSwitch: false, accounts: [sub('b')] }, homes });
  // no login can refresh: the current one has lapsed
  codex.handle = () => ({});
  await a.answerRefresh({ id: 7 });
  assert.equal(a.state.active, 'default');
  assert.match(sent.find((m) => m.id === 7).error.message, /Sign in again/);
  assert.equal(notices().filter((n) => n.kind === 'switched').length, 0);
  // the same lapse with auto-switch on moves to the healthy login
  a.state.autoSwitch = true;
  await a.answerRefresh({ id: 8 });
  assert.equal(a.state.active, 'b');
});

/* ---------- limit attribution without the relay ---------- */
test('usage pushed by the app-server updates the login it holds and fails over when reached', async (t) => {
  const { a, events } = setup(t);
  a.applied = 'default';
  const failovers: string[] = [];
  a.failover = async (r: string) => {
    failovers.push(r);
    throw new Error('ignored');
  };
  const d = a.get('default');
  a.onMainMessage({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'other', primary: { usedPercent: 99 } } } });
  a.onMainMessage({ method: 'account/rateLimits/updated', params: {} });
  assert.equal(d.limits, undefined);
  a.onMainMessage({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { primary: { usedPercent: 40 }, secondary: { usedPercent: 10 } } },
  });
  assert.equal(d.limits.used, 40);
  a.onMainMessage({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { limitId: 'codex', secondary: { usedPercent: 100, resetsAt: 9e9 } } },
  });
  // the primary window carries over from before
  assert.deepEqual([d.limits.primary.usedPercent, d.limits.reached], [40, true]);
  await flush();
  assert.deepEqual(failovers, ['limit']);
  assert.ok(events.some((e) => e.type === 'changed'));
  // with the relay, usage comes from response headers instead
  a.relay = {};
  a.onMainMessage({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 1 } } } });
  assert.equal(d.limits.primary.usedPercent, 40);
  a.relay = null;
  // a primary-only reading keeps the secondary window
  a.onMainMessage({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 41 } } } });
  assert.equal(d.limits.secondary.usedPercent, 100);
  // a first reading with no previous windows
  d.limits = null;
  a.onMainMessage({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 3 } } } });
  assert.equal(d.limits.secondary, null);
  // nothing active: nothing to update
  a.state.accounts = [];
  a.onMainMessage({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 1 } } } });
});

test("a reading that arrives while the app-server is still moving to another login is nobody's", async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b')] }, homes });
  const failovers: string[] = [];
  a.failover = async (r: string) => void failovers.push(r);
  a.applied = 'default';
  // switchTo sets the new account before apply() finishes
  a.state.active = 'b';
  a.onMainMessage(reading(FULL));
  assert.equal(a.get('b').limits, undefined, "the previous login's reading never lands on b");
  assert.equal(a.get('default').limits, undefined);
  await flush();
  assert.deepEqual(failovers, []);
  // once b is applied, its own readings count
  a.applied = 'b';
  a.onMainMessage(reading({ primary: { usedPercent: 12 } }));
  assert.equal(a.get('b').limits.used, 12);
});

test('a reached reading is confirmed with the login’s own usage before moving away', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b'), sub('c')] }, homes });
  a.applied = 'default';
  const switched: string[] = [];
  a.switchTo = async (id: string) => void switched.push(id);
  // the sidecar says default still has room: a late reading from another login, not a limit
  codex.handle = (m) => (m === 'account/rateLimits/read' ? { rateLimits: { primary: { usedPercent: 20 } } } : {});
  a.onMainMessage(reading(FULL));
  await flush(20);
  assert.deepEqual(switched, []);
  assert.equal(a.get('default').limits.reached, false);
  // the login itself is out (the others have room): move on
  const others = path.join(a.root, path.sep);
  codex.handle = (m, _p, home) =>
    m === 'account/rateLimits/read' ? { rateLimits: home.startsWith(others) ? { primary: { usedPercent: 10 } } : FULL } : {};
  a.onMainMessage(reading(FULL));
  await flush(20);
  assert.equal(switched.length, 1);
});

test('a reached reading after the user moved the app elsewhere during the check does not switch again', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b')] }, homes });
  a.applied = 'default';
  const switched: string[] = [];
  a.switchTo = async (id: string) => void switched.push(id);
  codex.handle = (m) => {
    if (m !== 'account/rateLimits/read') return {};
    a.state.active = 'b';
    a.applied = 'b';
    return { rateLimits: FULL };
  };
  await a.failover('limit');
  assert.deepEqual(switched, []);
});

test('a limited turn is charged to the login it started on, not the one the app moved to since', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b'), sub('c')] }, homes });
  const marked: string[] = [];
  const mark = a.markLimited.bind(a);
  a.markLimited = (x: any, r?: number) => (marked.push(x.id), mark(x, r));
  a.switchTo = async (id: string) => void (a.state.active = a.applied = id);
  a.applied = 'default';
  a.onMainMessage({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'u1' } } });
  // a reading moved the app to b while the turn was still running on default
  a.state.active = a.applied = 'b';
  a.onMainMessage({
    method: 'turn/completed',
    params: { threadId: 't1', turn: { id: 'u1', error: { codexErrorInfo: 'usageLimitExceeded' } } },
  });
  await flush(20);
  assert.deepEqual(marked, ['default']);
  assert.equal(a.limited(a.get('b')), false);
  assert.equal(a.turnLogins.size, 0, 'the turn is forgotten once it ends');
  // a turn that started mid-switch has no known login: the active one is charged
  a.applied = 'b';
  a.state.active = 'c';
  a.onMainMessage({ method: 'turn/started', params: { threadId: 't2', turn: { id: 'u2' } } });
  assert.equal(a.turnLogins.get('u2'), null);
  // the app-server exiting forgets every running turn
  for (const l of a.server.listeners) l({ kind: 'exit' });
  assert.equal(a.turnLogins.size, 0);
});

test('behind the relay a limited turn is charged by its routing pin, and turn starts are not tracked', async (t) => {
  const { a } = setup(t, { state: { autoSwitch: false, accounts: [sub('b'), sub('c')] }, homes });
  a.relay = {};
  a.applied = 'default';
  a.pins.set('t1', { id: 'c', at: Date.now() });
  a.onMainMessage({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'u1' } } });
  assert.equal(a.turnLogins.size, 0);
  a.onMainMessage({
    method: 'turn/completed',
    params: { threadId: 't1', turn: { id: 'u1', error: { codexErrorInfo: 'usageLimitExceeded' } } },
  });
  await flush();
  assert.equal(a.limited(a.get('c')), true);
  assert.equal(a.limited(a.get('default')), false);
  a.relay = null;
});

/* ---------- guard: every writer of the active account is reviewed ---------- */
// Paths that run on their own (a limit, a lapsed login, a model request). Each must keep the account with
// "Stop", as the matrix below checks; a new one has to be added there.
const AUTOMATIC = ['answerRefresh', 'failover', 'onTurnLimit', 'pickFor'];
// Paths the user started: a sign-in, a removal, a billing choice, the CLI's own login changing, the switch itself, and
// letting go of the account when none is left to fall back to (from a removal or a MoPilot sign-out).
const ON_REQUEST = ['#remove', 'finishLogin', 'releaseMain', 'setMode', 'setMoPilotKey', 'switchTo', 'switchSelection', 'syncDefault'];

test('every method that changes the active Codex account is either user-started or covered by the Stop matrix', () => {
  const dir = path.join(import.meta.dirname, '..', 'electron');
  const files = ['identity/codexAccounts.cjs', ...fs.readdirSync(path.join(dir, 'identity/accounts')).map((f) => `identity/accounts/${f}`)];
  const writers = new Set<string>();
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/state\.active = |(?<!async )\bswitchTo\(/.test(line)) return;
      let j = i;
      while (j >= 0 && !/^(?: {2}(?:async )?|(?:async )?function )(#?[A-Za-z]\w*)\(.*\{$/.test(lines[j])) j--;
      writers.add(/^(?: {2}(?:async )?|(?:async )?function )(#?[A-Za-z]\w*)\(/.exec(lines[j] ?? '')?.[1] ?? `${f}:${i + 1}`);
    });
  }
  assert.deepEqual([...writers].sort(), [...AUTOMATIC, ...ON_REQUEST].sort());
});

test('Stop matrix: no automatic path moves the app or a chat to another account', async (t) => {
  const runs: Record<string, (a: any) => Promise<unknown> | unknown> = {
    answerRefresh: (a) => ((codex.handle = () => ({})), a.answerRefresh({ id: 1 })),
    failover: (a) => a.failover('limit'),
    onTurnLimit: (a) => a.onTurnLimit('mine'),
    pickFor: (a) => a.pickFor('mine', new Set()),
  };
  assert.deepEqual(Object.keys(runs), AUTOMATIC);
  for (const pool of ['single', 'spread']) {
    for (const [name, run] of Object.entries(runs)) {
      const { a, notices } = setup(t, { state: { pool, autoSwitch: false, accounts: [sub('b')], chatPins: { mine: 'default' } }, homes });
      a.applied = 'default';
      const switched: string[] = [];
      a.switchTo = async (id: string) => void switched.push(id);
      a.markLimited(a.get('default'), 9e9);
      await run(a);
      await flush();
      const where = `${name} (${pool})`;
      assert.deepEqual([a.state.active, switched], ['default', []], where);
      assert.equal(a.state.chatPins.mine, 'default', where);
      assert.equal(a.pins.get('mine').id, 'default', where);
      assert.deepEqual(
        notices().filter((n) => ['moved', 'switched', 'resume'].includes(n.kind)),
        [],
        where,
      );
    }
  }
});

test('Stop chosen while an automatic move is still reading usage or a token: the move is dropped', async (t) => {
  const moves: Record<string, (a: any) => Promise<unknown>> = {
    // the token of the login to move to is being read
    answerRefresh: async (a) => {
      codex.handle = () => ({});
      const tokens = a.tokens.bind(a);
      a.tokens = async (x: any, force?: boolean) => {
        if (x.id === 'b') a.state.autoSwitch = false;
        return tokens(x, force);
      };
      return a.answerRefresh({ id: 1 });
    },
    // the candidates' usage is being read
    failover: async (a) => {
      a.refreshUsage = async (ids: string[]) => void (ids.includes('b') && (a.state.autoSwitch = false));
      return a.failover('limit');
    },
    onTurnLimit: async (a) => {
      a.refreshUsage = async () => void (a.state.autoSwitch = false);
      return a.onTurnLimit('mine');
    },
  };
  for (const [name, run] of Object.entries(moves)) {
    const { a, notices } = setup(t, { state: { pool: 'single', accounts: [sub('b')] }, homes });
    a.applied = 'default';
    const switched: string[] = [];
    a.switchTo = async (id: string) => void switched.push(id);
    a.markLimited(a.get('default'), 9e9);
    await run(a);
    await flush();
    assert.deepEqual([a.state.active, switched], ['default', []], name);
    assert.deepEqual(
      notices().filter((n) => ['switched', 'resume'].includes(n.kind)),
      [],
      name,
    );
  }
});

test('the app moving elsewhere while the candidates are read leaves the move to whoever moved it', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b'), sub('c')] }, homes });
  const switched: string[] = [];
  a.switchTo = async (id: string) => void switched.push(id);
  a.markLimited(a.get('default'), 9e9);
  a.refreshUsage = async (ids: string[]) => void (ids.includes('b') && (a.state.active = 'c'));
  await a.failover('limit');
  assert.deepEqual(switched, []);
});

test('before any apply (a restart with no window) a managed app-server holds the CLI login; an apply in flight holds none', async (t) => {
  const { a } = setup(t, { state: { active: 'b', accounts: [sub('b')] }, homes });
  a.failover = async () => {};
  for (const l of a.server.listeners) l({ kind: 'exit' });
  assert.equal(a.heldLogin()?.id, 'default', 'the app-server read $CODEX_HOME/auth.json, whatever is active');
  a.onMainMessage(reading({ primary: { usedPercent: 33 } }));
  assert.deepEqual([a.get('default').limits?.used, a.get('b').limits], [33, undefined]);
  // a login pushed as external tokens and then lost leaves nothing known
  a.mainMode = 'external';
  assert.equal(a.heldLogin(), null);
  a.mainMode = 'managed';
  // while apply() runs, a reading may belong to either login
  a.server.reply = (m: any) => (m.method === 'account/login/start' ? undefined : { result: {} });
  const applying = a.apply();
  await flush();
  assert.deepEqual([a.pendingApply, a.heldLogin()], [true, null]);
  a.onMainMessage(reading({ primary: { usedPercent: 90 } }));
  assert.equal(a.get('default').limits.used, 33);
  // the login answers: b is held from now on
  const [login] = a.mainPending.keys();
  a.onMainMessage({ id: login, result: {} });
  await applying;
  assert.deepEqual([a.pendingApply, a.heldLogin()?.id], [false, 'b']);
});

test('a lone login at its limit is not re-read: there is nowhere to move', async (t) => {
  const { a, requests } = setup(t);
  a.applied = 'default';
  const reads: string[][] = [];
  a.refreshUsage = async (ids: string[]) => void reads.push(ids);
  a.onMainMessage(reading(FULL));
  await flush();
  assert.deepEqual(reads, [[]]);
  assert.ok(!requests().includes('account/rateLimits/read'));
});
