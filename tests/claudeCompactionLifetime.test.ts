// Retired SDK process output cannot release a replacement session's compaction hold or publish sibling state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakes, load, fakeBin, flush, lastQuery } from './support/electron-claude.ts';

test('retired Claude messages and terminal events cannot reach a replacement with the same native ID', async () => {
  const t = load();
  const key = 'claude:reused-session';
  const opts = { bin: fakeBin('compaction/claude'), sessionId: 'reused-session' };
  fakes.onQuery = (q: any) => {
    q.reply = null;
  };
  await t.claude.send(key, opts, { role: 'user', content: 'old' });
  const old = lastQuery();
  old.close = () => {};
  await t.claude.retire(key, 0);
  await t.claude.send(key, opts, { role: 'user', content: 'replacement' });
  const current = lastQuery();
  const start = t.events.length;
  old.push(
    { type: 'system', subtype: 'compact_boundary', session_id: 'reused-session', uuid: 'old-compact' },
    { type: 'system', subtype: 'init', permissionMode: 'plan', uuid: 'old-init' },
    { type: 'system', subtype: 'task_started', task_id: 'old-task', task_type: 'local_agent', uuid: 'old-task-message' },
    { type: 'assistant', uuid: 'old-assistant', message: { content: [{ type: 'text', text: 'obsolete' }] } },
    { type: 'result', subtype: 'success', uuid: 'old-result' },
  );
  await flush();
  const stale = t.events.slice(start);
  old.end();
  await flush();
  current.push({ type: 'system', subtype: 'status', status: 'compacting', session_id: 'reused-session', uuid: 'current-compact' });
  await flush();
  current.end();
  await flush();
  assert.equal(stale.length, 0, 'the retired process must not publish messages or task changes');
  assert.equal(t.events.slice(start).filter((e: any) => e.kind === 'closed').length, 1, 'only the current process ends the chat');
  assert.equal(
    t.events.some((e: any) => e.msg?.uuid === 'current-compact'),
    true,
  );
});

for (const failed of [false, true])
  test(`intentional retirement still publishes its own ${failed ? 'error' : 'close'} and task cleanup`, async () => {
    const t = load();
    fakes.onQuery = (q: any) => {
      q.reply = null;
    };
    const key = 'claude:retired-owner';
    await t.claude.send(key, { bin: fakeBin('compaction/claude'), sessionId: 'retired-owner' }, { role: 'user', content: 'one' });
    const q = lastQuery();
    q.push({ type: 'system', subtype: 'task_started', task_id: 'active-task', task_type: 'local_agent' });
    await flush();
    q.close = () => {};
    await t.claude.retire(key, 0);
    q.end(failed ? new Error('native failure') : undefined);
    await flush();
    assert.equal(t.events.filter((e: any) => e.kind === (failed ? 'error' : 'closed')).length, 1);
    assert.equal(t.events.filter((e: any) => e.kind === 'tasks').at(-1).tasks[0].status, 'stopped');
  });

test('a replaced process cannot publish late settings or errors, and current settings remain live', async () => {
  const t = load();
  let finish!: (v: any) => void;
  fakes.onQuery = (q: any) => {
    q.reply = null;
    q.getSettings = () =>
      new Promise((r) => {
        finish = r;
      });
  };
  const key = 'claude:late-settings';
  const opts = { bin: fakeBin('compaction/claude'), sessionId: 'late-settings' };
  await t.claude.send(key, opts, { role: 'user', content: 'old' });
  const old = lastQuery();
  old.push({ type: 'system', subtype: 'init' });
  await flush();
  old.close = () => {};
  await t.claude.retire(key, 0);
  fakes.onQuery = (q: any) => {
    q.reply = null;
  };
  await t.claude.send(key, opts, { role: 'user', content: 'new' });
  const current = lastQuery();
  const start = t.events.length;
  finish({ applied: { ultracode: false, ultracodeAvailable: false } });
  old.end(new Error('obsolete failure'));
  await flush();
  assert.equal(
    t.events.slice(start).some((e: any) => ['settings', 'error', 'closed'].includes(e.kind)),
    false,
  );
  current.push({ type: 'system', subtype: 'init' });
  await flush();
  assert.equal(t.events.slice(start).filter((e: any) => e.kind === 'settings').length, 1);
  current.end();
  await flush();
});

test('retirement cleanup is object-owned even when the same key retires twice', async () => {
  const { createRequire } = await import('node:module');
  const { createSessionLifetime } = createRequire(import.meta.url)('../electron/harness/claude/sessionLifetime.cjs');
  const state = { sessions: new Map(), retiring: new Map(), timing: { retireMs: 0 } };
  const life = createSessionLifetime(state);
  assert.equal(await life.retire('missing'), false);
  let ended!: () => void;
  const first = {
    key: 'key',
    input: {
      close() {
        throw new Error('input close');
      },
    },
    q: {
      close() {
        throw new Error('query close');
      },
    },
    done: new Promise<void>((r) => {
      ended = r;
    }),
  };
  state.sessions.set('key', first);
  life.claim(first);
  assert.equal(life.active(first), true);
  assert.equal(life.owns(first), true);
  const retired = life.retire('key', 100);
  assert.equal(life.active(first), false);
  assert.equal(life.owns(first), true);
  let last!: () => void;
  const second = {
    key: 'key',
    input: { close() {} },
    q: { close() {} },
    done: new Promise<void>((r) => {
      last = r;
    }),
  };
  state.sessions.set('key', second);
  life.claim(second);
  const next = life.retire('key', 100);
  const nextOwner = state.retiring.get('key');
  ended();
  assert.equal(await retired, true);
  assert.equal(state.retiring.get('key'), nextOwner);
  life.finish(first);
  assert.equal(life.owns(second), true);
  last();
  assert.equal(await next, true);
  assert.equal(state.retiring.has('key'), false);
  life.finish(second);
  assert.equal(life.owns(second), false);
  const timeout = { ...second, done: new Promise(() => {}) };
  state.sessions.set('key', timeout);
  life.claim(timeout);
  assert.equal(await life.retire('key'), false);
});

test('an old native Chrome process cannot clear its replacement link on exit', async () => {
  const t = load();
  const changes: any[] = [];
  t.claude.setTools({ enabled: () => false, nativeChrome: () => true });
  t.claude.setChromeLinkListener((...a: any[]) => changes.push(a));
  fakes.onQuery = (q: any) => {
    q.reply = null;
  };
  const key = 'claude:chrome-reuse';
  const opts = { bin: fakeBin('compaction/claude'), sessionId: 'chrome-reuse' };
  await t.claude.send(key, opts, { role: 'user', content: 'old' });
  const old = lastQuery();
  old.close = () => {};
  await t.claude.retire(key, 0);
  await t.claude.send(key, opts, { role: 'user', content: 'new' });
  const current = lastQuery();
  old.end();
  await flush();
  assert.equal(changes.length, 0);
  current.end();
  await flush();
  assert.deepEqual(changes, [[key, null, key]]);
});
