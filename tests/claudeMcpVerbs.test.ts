// A Claude Code session's connector sign-in and reconnect (electron/harness/claude/mcpVerbs.cjs): sign-in returns only an
// openable page, and a reconnect asked during a turn runs once the turn ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { load, fakeBin, fakes, lastQuery, until } from './support/electron-claude.ts';

const verbs = createRequire(import.meta.url)('../electron/harness/claude/mcpVerbs.cjs');

test('sign-in keeps an http(s) page and whether the CLI waits for its callback', async () => {
  const asked: unknown[] = [];
  const answer = { authUrl: 'https://auth.example/x?y=1', callbackExpected: true, state: 's' };
  const s = { q: { mcpAuthenticate: async (...a: unknown[]) => (asked.push(a), answer) } };
  assert.deepEqual(await verbs.authenticate(s, 'stripe'), { authUrl: 'https://auth.example/x?y=1', callbackExpected: true });
  // no redirect URI: the CLI serves the callback on localhost and reconnects the server itself
  assert.deepEqual(asked, [['stripe']]);
  assert.deepEqual(verbs.signInAnswer({ requiresUserAction: false, callbackExpected: false }), { callbackExpected: false });
  assert.deepEqual(verbs.signInAnswer({ authUrl: 'not a url' }), { callbackExpected: false });
  assert.deepEqual(verbs.signInAnswer(null), { callbackExpected: false });
  assert.throws(() => verbs.signInAnswer({ authUrl: 'file:///etc/passwd' }), /cannot open/);
  assert.throws(() => verbs.signInAnswer({ requiresUserAction: true }), /did not return a sign-in page/);
  assert.throws(() => verbs.signInAnswer({ authUrl: 'nope', callbackExpected: true }), /did not return a sign-in page/);
  await assert.rejects(verbs.authenticate({ q: {} }, 'x'), /cannot sign in/);
  await assert.rejects(verbs.authenticate({}, 'x'), /cannot sign in/);
});

test('a reconnect the rail asks for during a turn waits for its end, once per server, and says when it settles', async () => {
  const calls: string[] = [];
  const ignored: unknown[] = [];
  let changed = 0;
  const reconnectMcpServer = async (n: string) => {
    calls.push(n);
    if (n === 'bad') throw new Error('no');
  };
  const s: any = { busy: true, q: { reconnectMcpServer } };
  const o = { ignored: (what: string, e: unknown) => ignored.push([what, (e as Error).message]), changed: () => changed++ };
  assert.deepEqual(await verbs.reconnect(s, 'a', true), { queued: true });
  assert.deepEqual(await verbs.reconnect(s, 'a', true), { queued: true });
  assert.deepEqual(await verbs.reconnect(s, 'bad', true), { queued: true });
  assert.deepEqual(verbs.queued(s), { waiting: ['a', 'bad'], reconnecting: [] });
  verbs.afterTurn(s, { ...o, ignored: () => assert.fail('the turn is still running') });
  assert.deepEqual(calls, []);
  s.busy = false;
  verbs.afterTurn(s, o);
  // listed as reconnecting until each settles, so a read meanwhile doesn't show a plain failure
  assert.deepEqual(verbs.queued(s), { waiting: [], reconnecting: ['a', 'bad'] });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['a', 'bad']);
  assert.deepEqual(ignored, [['reconnect a Claude Code connector after its turn', 'no']]);
  assert.deepEqual(verbs.queued(s), { waiting: [], reconnecting: [] });
  assert.equal(changed, 2);
  verbs.afterTurn(s, { ...o, changed: () => assert.fail('nothing waits') });
  // the CLI saying it is idle ends the wait even while a prompt is still counted as owed
  s.busy = true;
  await verbs.reconnect(s, 'idle', true);
  verbs.afterTurn(s, { ...o, idle: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['a', 'bad', 'idle']);
  s.busy = false;
  assert.deepEqual(await verbs.reconnect(s, 'now', true), { queued: false });
  assert.deepEqual(calls, ['a', 'bad', 'idle', 'now']);
  // the agent's reconnect tool, inside its own turn, gets the server back for that turn
  s.busy = true;
  assert.deepEqual(await verbs.reconnect(s, 'tool'), { queued: false });
  assert.deepEqual(calls, ['a', 'bad', 'idle', 'now', 'tool']);
  assert.deepEqual(verbs.queued({}), { waiting: [], reconnecting: [] });
  verbs.afterTurn({ q: {} }, { ...o, changed: () => assert.fail('nothing waits') });
});

test('the session control signs in, holds a rail reconnect until the CLI is idle, and then says it changed', async () => {
  const t = load();
  const key = 'claude:mcp-verbs';
  // the CLI keeps working on the prompt until the test says it is idle
  fakes.onQuery = (q: any) => {
    q.reply = () => [];
    q.mcpAuthenticate = async (name: string) => ({ authUrl: `https://auth.example/${name}`, callbackExpected: true });
  };
  await t.claude.send(key, { bin: fakeBin('sessions/claude'), sessionId: 'mcp-verbs', ephemeral: true }, { role: 'user', content: 'hi' });
  const q = lastQuery();
  await until('the prompt reaches the CLI', () => q.inputs.length > 0);
  assert.deepEqual(await t.call('claude:control', key, 'authenticateMcp', { name: 'stripe' }), {
    authUrl: 'https://auth.example/stripe',
    callbackExpected: true,
  });
  assert.deepEqual(await t.call('claude:control', key, 'reconnectMcp', { name: 'github', afterTurn: true }), { queued: true });
  assert.deepEqual(await t.call('claude:control', key, 'mcpQueued'), { waiting: ['github'], reconnecting: [] });
  const reconnected = () => q.calls.some((c: any[]) => c[0] === 'reconnectMcpServer' && c[1] === 'github');
  // a subagent's idle, or the CLI working again, is not the turn's end
  q.push({ type: 'system', subtype: 'session_state_changed', state: 'idle', parent_tool_use_id: 'tool-1' });
  q.push({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  q.push({ type: 'system', subtype: 'status' });
  await until('the messages are read', () => t.events.filter((e) => e.key === key && e.kind === 'message').length >= 3);
  assert.equal(reconnected(), false);
  q.push({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await until('the reconnect', reconnected);
  await until('the rail is told', () => t.events.some((e) => e.key === key && e.kind === 'mcpChanged'));
  assert.deepEqual(await t.call('claude:control', key, 'mcpQueued'), { waiting: [], reconnecting: [] });
  // the agent's own reconnect, mid-turn, is not held
  assert.deepEqual(await t.call('claude:control', key, 'reconnectMcp', { name: 'tool' }), { queued: false });
  await t.call('claude:control', key, 'close');
});
