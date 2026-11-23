// A native Claude root plan approval announces its authoritative acceptance before SDK continuation, never on stale callbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakes, fakeBin, lastQuery, flush } from './support/electron-claude.ts';
import { deferred } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { createState } = require('../electron/harness/claude/state.cjs');
const { createSessions } = require('../electron/harness/claude/sessions.cjs');
const bin = fakeBin('plan-acceptance/claude');

async function fixture(t: any, permission = 'default') {
  const state = createState();
  const events: any[] = [];
  state.emit = (e: any) => events.push(e);
  const sessions = createSessions(state, {
    auth: {
      billingSig: () => 'subscription',
      sessionStale: () => false,
      configIdOf: () => 'default',
      nativeChromeFor: () => false,
      sessionEnv: () => ({}),
    },
    cli: { findBinary: async () => bin },
    catalog: { noteCatalog() {} },
    chrome: {},
  });
  fakes.onQuery = (q: any) => {
    q.reply = null;
  };
  const s = await sessions.startSession('claude:plan', { sessionId: 'plan', ephemeral: true, permission });
  const q = lastQuery();
  t.after(async () => {
    q.end();
    await flush();
  });
  const ask = (tool = 'ExitPlanMode', opts?: any) => {
    const pending = q.options.canUseTool(tool, {}, opts);
    const id = events.filter((e) => e.kind === 'permission').at(-1)?.requestId;
    return { pending, id, callback: s.perms.get(id) };
  };
  return { state, events, sessions, s, q, ask, accepted: () => events.filter((e) => e.kind === 'planAccepted') };
}

test('a native root approval is emitted before its awaiting SDK call continues, with its generated request id', async (t) => {
  const f = await fixture(t);
  const { pending, id } = f.ask();
  let continued = false;
  const continuation = pending.then(() => {
    continued = true;
    assert.equal(f.accepted().length, 1);
  });
  assert.equal(f.sessions.resolvePermission(id, { behavior: 'allow', updatedInput: {} }), true);
  assert.equal(continued, false);
  assert.deepEqual(f.accepted(), [{ key: 'claude:plan', kind: 'planAccepted', requestId: id }]);
  await continuation;
  assert.equal(f.sessions.resolvePermission(id, { behavior: 'allow' }), false);
  assert.equal(f.accepted().length, 1);
});

test('denied, ordinary-tool, subagent, aborted, replaced and superseded native approvals do not emit acceptance', async (t) => {
  const f = await fixture(t);
  for (const result of [null, { behavior: 'deny' }]) {
    const ask = f.ask();
    f.sessions.resolvePermission(ask.id, result);
    await ask.pending;
  }
  const tool = f.ask('Bash');
  f.sessions.resolvePermission(tool.id, { behavior: 'allow' });
  await tool.pending;
  const worker = f.ask('ExitPlanMode', { agentID: 'worker' });
  f.sessions.resolvePermission(worker.id, { behavior: 'allow' });
  await worker.pending;
  const ac = new AbortController();
  const cancelled = f.ask('ExitPlanMode', { signal: ac.signal });
  ac.abort();
  assert.equal((await cancelled.pending).behavior, 'deny');
  cancelled.callback({ behavior: 'allow' });
  const replaced = f.ask();
  f.state.sessions.set(f.s.key, {});
  replaced.callback({ behavior: 'allow' });
  await replaced.pending;
  f.state.sessions.set(f.s.key, f.s);
  f.s.perms.delete(replaced.id);
  const superseded = f.ask();
  f.s.sent++;
  f.sessions.resolvePermission(superseded.id, { behavior: 'allow' });
  await superseded.pending;
  assert.deepEqual(f.accepted(), []);
  const allowed = f.ask('ExitPlanMode', { signal: new AbortController().signal });
  f.sessions.resolvePermission(allowed.id, { behavior: 'allow' });
  await allowed.pending;
  assert.equal(f.accepted().length, 1, 'a live root request with a signal still works');
});

test('accepted native permission changes survive a rejected control response when ExitPlanMode restores the base', async (t) => {
  for (const [initial, requested, native] of [
    ['full-access', 'default', 'default'],
    ['default', 'full-access', 'bypassPermissions'],
  ]) {
    const f = await fixture(t, initial);
    const entered = deferred<void>();
    const response = deferred<void>();
    f.q.setPermissionMode = async () => {
      entered.resolve();
      await response.promise;
    };
    const changed = f.sessions.control(f.s.key, 'setPermissionMode', requested);
    const rejected = assert.rejects(changed, /response failed/);
    await entered.promise;
    f.q.push({ type: 'system', subtype: 'status', permissionMode: native });
    await flush();
    f.q.push({ type: 'system', subtype: 'status', permissionMode: 'plan' });
    await flush();
    response.reject(new Error('response failed'));
    await rejected;
    const ask = f.ask();
    f.sessions.resolvePermission(ask.id, { behavior: 'allow' });
    assert.equal((await ask.pending).updatedPermissions.find((item: any) => item.type === 'setMode').mode, native);
  }
});

test('late successful controls cannot overwrite a newer root native mode receipt before plan exit', async (t) => {
  for (const [initial, requested, accepted, newer] of [
    ['default', 'full-access', 'bypassPermissions', 'default'],
    ['full-access', 'default', 'default', 'auto'],
    ['default', 'full-access', 'bypassPermissions', 'acceptEdits'],
  ]) {
    const f = await fixture(t, initial);
    const entered = deferred<void>();
    const response = deferred<void>();
    f.q.setPermissionMode = async () => {
      entered.resolve();
      await response.promise;
    };
    const changed = f.sessions.control(f.s.key, 'setPermissionMode', requested);
    await entered.promise;
    f.q.push({ type: 'system', subtype: 'status', permissionMode: accepted });
    f.q.push({ type: 'system', subtype: 'init', permissionMode: newer });
    f.q.push({ type: 'system', subtype: 'status', permissionMode: 'plan' });
    await flush();
    response.resolve();
    await changed;
    const ask = f.ask();
    f.sessions.resolvePermission(ask.id, { behavior: 'allow' });
    assert.equal((await ask.pending).updatedPermissions.find((item: any) => item.type === 'setMode').mode, newer);
  }
});

test('plan, unknown, subagent, non-status and retired native messages never change the plan return scope', async (t) => {
  const f = await fixture(t, 'full-access');
  f.q.push(
    { type: 'system', subtype: 'status', permissionMode: 'plan' },
    { type: 'system', subtype: 'status', permissionMode: 'unknown' },
    { type: 'system', subtype: 'commands_changed', permissionMode: 'default' },
    { type: 'assistant', permissionMode: 'default', message: { content: [] } },
    { type: 'system', subtype: 'status', permissionMode: 'default', parent_tool_use_id: 'agent' },
    { type: 'system', subtype: 'init', permissionMode: 'default', parent_tool_use_id: 'agent' },
  );
  await flush();
  f.state.sessions.set(f.s.key, {});
  f.q.push({ type: 'system', subtype: 'status', permissionMode: 'default' });
  await flush();
  f.state.sessions.set(f.s.key, f.s);
  const ask = f.ask();
  f.sessions.resolvePermission(ask.id, { behavior: 'allow' });
  assert.equal((await ask.pending).updatedPermissions.find((item: any) => item.type === 'setMode').mode, 'bypassPermissions');
});
