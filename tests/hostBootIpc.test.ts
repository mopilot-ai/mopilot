// Add by command's IPC (electron/app/ipc/host.cjs): how a command stands goes to every window, and the four calls reach the machines
// service's boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');

test('the boot’s view is broadcast, and start, view, allow and deny reach the service', async () => {
  const handlers = new Map<string, any>();
  const said: any[] = [];
  let opts: any;
  const calls: string[] = [];
  const boot = {
    start: async (retry: boolean) => (calls.push(retry ? 'retry' : 'start'), { state: 'waiting' }),
    view: () => (calls.push('view'), { state: 'idle' }),
    allow: () => (calls.push('allow'), { id: 'relay:h_1' }),
    deny: () => void calls.push('deny'),
  };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: (...a: any[]) => said.push(a), live: {} },
    {
      create: (o: any) => ((opts = o), { list: () => ({ machines: [], resolved: true }), boot }),
      createFolders: () => ({}),
      allowed: () => true,
    },
  );
  await handlers.get('host:machines')!({});
  opts.onBoot({ state: 'asking' });
  assert.deepEqual(said.at(-1), ['host:boot', { state: 'asking' }]);
  assert.deepEqual(await handlers.get('host:bootStart')!({}), { value: { state: 'waiting' } });
  await handlers.get('host:bootStart')!({}, true);
  await handlers.get('host:bootStart')!({}, 'yes');
  assert.deepEqual(await handlers.get('host:bootView')!({}), { value: { state: 'idle' } });
  assert.deepEqual(await handlers.get('host:bootAllow')!({}), { value: { id: 'relay:h_1' } });
  await handlers.get('host:bootDeny')!({});
  assert.deepEqual(calls, ['start', 'retry', 'start', 'view', 'allow', 'deny']);
});

test('what a machine chat waits for: the lane answers a window that opens later and is broadcast on every change', async () => {
  const handlers = new Map<string, any>();
  const said: any[] = [];
  let remote: any;
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: (...a: any[]) => said.push(a), live: {} },
    {
      create: () => ({ list: () => ({ machines: [], resolved: true }) }),
      createFolders: () => ({}),
      allowed: () => true,
      makeRemoteChats: (o: any) => ((remote = o), { get: () => null, forget: async () => null }),
    } as any,
  );
  assert.deepEqual(await handlers.get('host:attentions')!({}), {});
  remote.attention('c1', { kind: 'paused', reason: 'approval_timeout' });
  assert.deepEqual(said.at(-1), ['host:attention', { chatId: 'c1', attention: { kind: 'paused', reason: 'approval_timeout' } }]);
  assert.deepEqual(await handlers.get('host:attentions')!({}), { c1: { kind: 'paused', reason: 'approval_timeout' } });
});
