// host:forwardPort (electron/app/ipc/host.cjs; package 2.6): the pane asks for a machine's port on this Mac, the gate applies, and a refusal reaches the window with its code and without a line in the ignored-error log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');

function setup(forwardPort: (id: string, port: unknown) => Promise<unknown>, allowed = () => true) {
  const handlers = new Map<string, any>();
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: () => ({ list: () => ({ machines: [], resolved: true }), forwardPort }), createFolders: () => ({}), allowed },
  );
  return (...a: any[]) => handlers.get('host:forwardPort')({}, ...a);
}

test('the machine and the port reach the service, and its answer is the value; a missing machine is the empty id', async () => {
  const seen: any[] = [];
  const call = setup(async (id, port) => (seen.push([id, port]), { localPort: 41000 }));
  assert.deepEqual(await call('ssh:box', 5173), { value: { localPort: 41000 } });
  await call();
  assert.deepEqual(seen, [
    ['ssh:box', 5173],
    ['', undefined],
  ]);
});

test('B: the gate closed, a bad port and a forward that failed come back as errors with their codes', async () => {
  const closed = setup(
    async () => ({ localPort: 1 }),
    () => false,
  );
  assert.equal((await closed('ssh:box', 80)).error.code, 'not_allowed');
  for (const code of ['bad_port', 'unknown_machine', 'forward_failed']) {
    const call = setup(async () => {
      throw Object.assign(new Error(`no: ${code}`), { code });
    });
    assert.deepEqual(await call('ssh:box', 80), { error: { message: `no: ${code}`, code } });
  }
});

test('host:gitSignIn reads the machine’s Host over a session of the service, closed after, and unknown when there is none (#4123)', async () => {
  const handlers = new Map<string, any>();
  const asked: string[] = [];
  let closed = 0;
  const session = async (id: string) => {
    if (id !== 'ssh:box') throw new Error('That machine is not in the list.');
    return {
      call: async (method: string, params: any) => (
        asked.push(`${method} ${JSON.stringify(params)}`), { gitSignIn: { 'github.com': 'no' } }
      ),
      close: () => void closed++,
    };
  };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: () => ({ list: () => ({ machines: [], resolved: true }), session }), createFolders: () => ({}), allowed: () => true },
  );
  const call = (...a: any[]) => handlers.get('host:gitSignIn')({}, ...a);
  assert.deepEqual(await call('ssh:box'), { value: { 'github.com': 'no' } });
  // the status is a request of the versioned protocol: the connection says hello first (#5050)
  assert.deepEqual(
    asked.map((a) => a.split(' ')[0]),
    ['host.hello', 'host.status'],
  );
  assert.equal(asked[1], 'host.status {"signIn":["github.com"]}');
  assert.equal(closed, 1);
  assert.deepEqual(await call('ssh:nobody'), { value: { 'github.com': 'unknown' } });
  assert.deepEqual(await call(), { value: { 'github.com': 'unknown' } });
});
