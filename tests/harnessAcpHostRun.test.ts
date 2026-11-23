// A scheduled run's chat on a remote machine, renderer side (src/session/harness/acp.ts onChatStarted): listed under the task's project like a Host chat the composer starts, with no folder of this Mac unhidden.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset, tick } from './support/harness-logic-fakes.ts';

const acp = await import('../src/session/harness/acp.ts');
let onEvent: any;

beforeEach(async () => {
  reset();
  (globalThis as any).window = new EventTarget();
  fx.native.acp = {
    onEvent: (h: any) => (onEvent = h),
    onHarnesses: () => {},
    harnesses: async () => [],
    onSignIns: () => {},
    signIns: async () => ({}),
    list: async () => [],
  };
  acp.startAcp();
  await tick();
});

test('a scheduled run made a chat on a remote machine: listed under the task’s project, and no folder of this Mac is touched', () => {
  const id = 'acp:host-claude:sched';
  const unhidden = called('unhideFolder').length;
  onEvent({ kind: 'chatStarted', key: id, chatId: id, cwd: '/srv/app', worktreeOf: null, hostId: 'box', projectId: 'p1' });
  assert.equal(called('unhideFolder').length, unhidden);
  const thread = called('upsertThread').find((c) => c[0].id === id)![0];
  assert.equal(thread.cwd, '/srv/app');
  assert.equal(thread.projectId, 'p1');
  assert.deepEqual(called('rememberChatProject').at(-1), [id, 'p1']);
  const loose = 'acp:host-codex:sched';
  onEvent({ kind: 'chatStarted', key: loose, chatId: loose, cwd: '/srv/app', worktreeOf: null, hostId: 'box' });
  assert.equal(called('upsertThread').find((c) => c[0].id === loose)![0].projectId, null);
  assert.deepEqual(called('rememberChatProject').at(-1), [loose, undefined]);
});
