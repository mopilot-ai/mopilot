// IPC for the session rail's Servers section (electron/app/ipc/previews.cjs): a chat's servers without their process or
// output, stopping one, and previews:changed when one becomes ready, exits or is stopped, without dropping earlier listeners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { register, view } = createRequire(import.meta.url)('../electron/app/ipc/previews.cjs');

function setup(devPreviews: any) {
  const handlers = new Map<string, (...a: any[]) => any>();
  const broadcasts: unknown[][] = [];
  const live: any = { devPreviews };
  register({ handle: (n: string, fn: any) => handlers.set(n, fn) }, { live, broadcastAll: (...a: unknown[]) => broadcasts.push(a) });
  const call = (n: string, ...a: unknown[]) => handlers.get(n)!({}, ...a);
  return { call, broadcasts, live };
}

test('a chat lists only what the rail shows of its servers, and Stop tells every window', async () => {
  const earlier: string[] = [];
  const server = {
    id: 's1',
    chatId: 'c',
    name: 'web',
    url: 'http://localhost:5173',
    port: 5173,
    status: 'ready',
    live: true,
    pid: 9,
    lines: ['x'],
  };
  const previews = {
    list: (chatId: string) => (chatId === 'c' ? [server] : []),
    stop: (chatId: string, id: string) => earlier.push(`stop ${chatId} ${id}`),
    onReady: (s: any) => earlier.push(`ready ${s.id}`),
    onExit: undefined as any,
    onChange: undefined as any,
  };
  const { call, broadcasts } = setup(previews);
  assert.deepEqual(await call('previews:list', 'c'), [
    { id: 's1', name: 'web', url: 'http://localhost:5173', port: 5173, status: 'ready', live: true },
  ]);
  assert.deepEqual(await call('previews:list', 7), []);
  // its hooks are watched once, after the earlier listener
  await call('previews:list', 'c');
  previews.onReady(server);
  previews.onExit({ chatId: 'c' });
  // a server added or stopped (by the rail or an agent's preview_stop) tells the windows too
  previews.onChange({ chatId: 'c' });
  assert.deepEqual(earlier, ['ready s1']);
  assert.equal(broadcasts.length, 3);
  assert.ok(broadcasts.every((b) => b[0] === 'previews:changed' && (b[1] as any).chatId === 'c'));
  assert.equal(await call('previews:stop', 'c', 's1'), true);
  assert.deepEqual(earlier.at(-1), 'stop c s1');
  // one already gone, another chat's, or a bad chat id has nothing to stop
  assert.equal(await call('previews:stop', 'c', 'gone'), false);
  assert.equal(await call('previews:stop', 'other', 's1'), false);
  assert.equal(await call('previews:stop', 9, 's1'), false);
  assert.deepEqual(earlier.at(-1), 'stop c s1');
  assert.deepEqual(view({ id: 'x', status: 'starting' }), { id: 'x', name: null, url: null, port: null, status: 'starting', live: false });
});

test('before previews are wired a chat has none and nothing stops', async () => {
  const { call, live } = setup(null);
  assert.deepEqual(await call('previews:list', 'c'), []);
  assert.equal(await call('previews:stop', 'c', 's1'), false);
  live.devPreviews = undefined;
  assert.deepEqual(await call('previews:list', 'c'), []);
});

test('the registry says when a chat’s servers are added or stopped, and a listener that throws changes nothing', () => {
  const { DevPreviews } = createRequire(import.meta.url)('../electron/capabilities/browser/devPreview/servers.cjs');
  const previews = new DevPreviews({ probe: async () => false, pollMs: 60_000 });
  const seen: string[] = [];
  previews.onChange = (s: any) => seen.push(`${s.id} ${s.live}`);
  const s = previews.attach('c', 'http://localhost:4321');
  assert.deepEqual(seen, [`${s.id} true`]);
  previews.onChange = () => {
    throw new Error('listener broke');
  };
  previews.stop('c', s.id);
  assert.deepEqual(previews.list('c'), [], 'the stop stands');
});
