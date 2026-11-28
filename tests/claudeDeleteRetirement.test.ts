// Claude deletion joins prior retirement before capturing a current session; all boundaries are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createDeleteSession } from '../electron/harness/claude/delete.cjs';
import { addDirectories } from '../electron/harness/claude/directoryGrants.cjs';
import { replyPermission, planPermissionReply } from '../electron/harness/claude/permissionReplies.cjs';
import { StderrTail } from '../electron/harness/stderrTail.cjs';
import * as mcpVerbs from '../electron/harness/claude/mcpVerbs.cjs';
import { setNativePermission, applyNativeFlags, observeNativeRestoreMode } from '../electron/harness/claude/nativeSettings.cjs';
import { deferred } from './support/async-scenarios.ts';
import { inertClockPort } from './support/ports/clock.ts';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture() {
  const calls: string[] = [];
  const state = {
    sessions: new Map<string, any>(),
    retiring: new Map<string, Promise<unknown>>(),
    endedTips: new Set(['target']),
    sdk: async () => ({
      deleteSession: async (id: string) => {
        calls.push(`delete:${id}`);
        return 'deleted';
      },
    }),
  };
  const cli = {
    retire: async (key: string) => {
      calls.push(`retire:${key}`);
    },
  };
  const timers: (() => void)[] = [];
  const remove = createDeleteSession(state, cli, (fn: () => void) => timers.push(fn));
  return { state, cli, calls, timers, remove };
}

test('delete joins archive retirement even after the live session entry is removed', async () => {
  const f = fixture();
  const old = deferred();
  f.state.retiring.set('claude:target', old.promise);
  const pending = f.remove('target');
  await flush();
  assert.deepEqual(f.calls, []);
  old.resolve();
  assert.equal(await pending, 'deleted');
  assert.deepEqual(f.calls, ['retire:claude:target', 'delete:target']);
  assert.equal(f.state.endedTips.has('target'), false);
  assert.equal(f.state.retiring.get('claude:target'), old.promise, 'retirement owns its own cleanup');
});

test('prior retirement rejection propagates without delete or owned-map cleanup', async () => {
  const f = fixture();
  const old = deferred();
  f.state.retiring.set('claude:target', old.promise);
  const pending = f.remove('target');
  const error = new Error('retirement failed');
  old.reject(error);
  await assert.rejects(pending, (e) => e === error);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.endedTips.has('target'), true);
  assert.equal(f.state.retiring.get('claude:target'), old.promise);
});

test('a fresh live session appearing during prior retirement is captured and retired', async () => {
  const f = fixture();
  const old = deferred();
  const current = deferred();
  const done = deferred();
  f.state.retiring.set('claude:target', old.promise);
  f.cli.retire = async (key) => {
    f.calls.push(`retire:${key}`);
    await current.promise;
  };
  const pending = f.remove('target');
  f.state.sessions.set('claude:target', { done: done.promise });
  old.resolve();
  await flush();
  assert.deepEqual(f.calls, ['retire:claude:target']);
  current.resolve();
  await flush();
  assert.deepEqual(f.calls, ['retire:claude:target']);
  assert.equal(f.timers.length, 1);
  done.resolve();
  await pending;
  assert.deepEqual(f.calls, ['retire:claude:target', 'delete:target']);
});

test('unrelated retirement never holds a delete; absent current session needs no done timer', async () => {
  const f = fixture();
  const other = deferred();
  f.state.retiring.set('claude:other', other.promise);
  await f.remove('target');
  assert.deepEqual(f.calls, ['retire:claude:target', 'delete:target']);
  assert.equal(f.timers.length, 0);
  assert.equal(f.state.retiring.get('claude:other'), other.promise);
});

test('concurrent delete callers both join existing retirement without taking its ownership', async () => {
  const f = fixture();
  const old = deferred();
  f.state.retiring.set('claude:target', old.promise);
  const a = f.remove('target');
  const b = f.remove('target');
  await flush();
  assert.deepEqual(f.calls, []);
  old.resolve();
  await Promise.all([a, b]);
  assert.equal(f.calls.filter((x) => x === 'delete:target').length, 2);
  assert.equal(f.state.retiring.get('claude:target'), old.promise);
});

test('current retire and SDK failures still reject without dropping transcript-tip state', async () => {
  for (const stage of ['retire', 'sdk', 'delete']) {
    const f = fixture();
    const error = new Error(stage);
    if (stage === 'retire')
      f.cli.retire = async () => {
        throw error;
      };
    if (stage === 'sdk')
      f.state.sdk = async () => {
        throw error;
      };
    if (stage === 'delete')
      f.state.sdk = async () => ({
        deleteSession: async () => {
          throw error;
        },
      });
    await assert.rejects(f.remove('target'), (e) => e === error);
    assert.equal(f.state.endedTips.has('target'), true);
  }
});

test('existing bounded wait for an active session remains usable when done never arrives', async () => {
  const f = fixture();
  const done = deferred();
  f.state.sessions.set('claude:target', { done: done.promise });
  const pending = f.remove('target');
  await flush();
  assert.equal(f.timers.length, 1);
  assert.deepEqual(f.calls, ['retire:claude:target']);
  f.timers[0]();
  await pending;
  assert.deepEqual(f.calls, ['retire:claude:target', 'delete:target']);
});

test('real archive retirement and repeated retire do not let deletion skip the exit barrier', async () => {
  const f = fixture();
  const done = deferred();
  const module = { exports: {} as any };
  const deps: Record<string, unknown> = Object.fromEntries(
    [
      'node:crypto',
      '../../session/contract/inputGuard.cjs',
      './tasks.cjs',
      './liveOutput.cjs',
      './windowVisibility.cjs',
      './chromeTabs.cjs',
      './chromeLink.cjs',
      '../../capabilities/mcp/sdkMcp.cjs',
      './sessionTools.cjs',
      '../../ignored.cjs',
      './transcripts.cjs',
      './sessionOptions.cjs',
      './readOnlyBoundary.cjs',
      '../../platform/processTree.cjs',
      '../../platform/winbin.cjs',
    ].map((name) => [name, name === './tasks.cjs' ? { keepAlive: () => false } : {}]),
  );
  deps['./directoryGrants.cjs'] = { addDirectories };
  deps['./remoteControl.cjs'] = { createRemoteControl: () => ({ onStart() {}, onEnd() {}, set() {}, release: () => null }) };
  deps['./elicitation.cjs'] = { createElicitation: () => () => {} };
  deps['./nativeSettings.cjs'] = { setNativePermission, applyNativeFlags, observeNativeRestoreMode };
  deps['./permissionReplies.cjs'] = { replyPermission, planPermissionReply };
  deps['../stderrTail.cjs'] = { StderrTail };
  deps['./mcpVerbs.cjs'] = mcpVerbs;
  deps['../../platform/ports/clock.cjs'] = inertClockPort;
  const lifetime = { exports: {} };
  runInNewContext(readFileSync(new URL('../electron/harness/claude/sessionLifetime.cjs', import.meta.url), 'utf8'), {
    module: lifetime,
    require: (name: string) => deps[name],
    process: { platform: 'darwin' },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  deps['./sessionLifetime.cjs'] = lifetime.exports;
  runInNewContext(readFileSync(new URL('../electron/harness/claude/sessions.cjs', import.meta.url), 'utf8'), {
    module,
    require: (name: string) => {
      assert.ok(Object.hasOwn(deps, name));
      return deps[name];
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date,
  });
  const state = { ...f.state, timing: { retireMs: 5000 } };
  const key = 'claude:target';
  state.sessions.set(key, {
    key,
    chatId: key,
    perms: new Map(),
    done: done.promise,
    input: { close: () => f.calls.push('input-close') },
    q: { close: () => f.calls.push('query-close') },
  });
  const cli = module.exports.createSessions(state, {});
  assert.equal(cli.retireChat(key), 1);
  assert.equal(await cli.retire(key), false);
  const pending = createDeleteSession(state, cli, () => 0)('target');
  await flush();
  assert.deepEqual(f.calls, ['input-close']);
  assert.equal(state.retiring.size, 1);
  done.resolve();
  await pending;
  assert.deepEqual(f.calls, ['input-close', 'query-close', 'delete:target']);
  assert.equal(state.retiring.size, 0);
});
