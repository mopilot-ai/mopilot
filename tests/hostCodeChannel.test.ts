// The channel the code transfer uses (electron/host/codeChannel.cjs): this Mac's own git for a folder here, an authenticated session for a folder on a machine, and nothing that writes into this Mac yet (3.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCodeChannel } = require('../electron/host/codeChannel.cjs');

function make() {
  const calls: any[] = [];
  const closed: string[] = [];
  const session = async (hostId: string) => ({
    call: async (method: string, params: object, opts?: { timeoutMs?: number }) => (
      calls.push({ hostId, method, params, opts }), { from: hostId, method }
    ),
    close: () => void closed.push(hostId),
  });
  const local: any = new Proxy({}, { get: (_t, name: string) => async (q: object) => ({ local: name, q }) });
  return { channel: createCodeChannel({ session, localGit: local }), calls, closed };
}
const code = (c: string) => (e: any) => e?.code === c;

test('a folder on a machine is read and written through a session that ends with the request', async () => {
  const { channel, calls, closed } = make();
  assert.deepEqual(await channel.inspect('box', '/srv/app'), { from: 'box', method: 'git.inspect' });
  await channel.clone('box', { key: 'clone-key-0001', url: 'https://h/r.git', dest: '/srv/r' });
  await channel.carry.plan('box', { path: '/srv/app' });
  await channel.carry.push('box', { key: 'carry-key-0001', path: '/srv/app', untracked: [] });
  await channel.carry.apply('box', { key: 'carry-key-0001', path: '/srv/app', branch: 'b', commit: 'c', parent: 'p' });
  await channel.carry.drop('box', { path: '/srv/app', branch: 'mopilot/carry/x' });
  assert.deepEqual(
    calls.map((c) => [c.method, c.opts?.timeoutMs]),
    [
      ['git.inspect', undefined],
      ['git.clone', 600000],
      ['git.carryPlan', undefined],
      ['git.carryPush', 120000],
      ['git.carryApply', 120000],
      ['git.carryDrop', undefined],
    ],
  );
  assert.equal(closed.length, 6);
});

test("a session that fails ends with its error and one that cannot open is the caller's to see (B2)", async () => {
  const channel = createCodeChannel({
    session: async () => ({
      call: async () => Promise.reject(Object.assign(new Error('refused'), { code: 'target_dirty' })),
      close: () => undefined,
    }),
    localGit: {} as any,
  });
  await assert.rejects(channel.carry.apply('box', {} as any), code('target_dirty'));
  const down = createCodeChannel({ session: async () => Promise.reject(new Error('tunnel down')), localGit: {} as any });
  await assert.rejects(down.inspect('box', '/x'), /tunnel down/);
});

test('a folder on this Mac is read and written with its own git; only a clone into this Mac is not offered yet, and says so', async () => {
  const { channel, calls } = make();
  assert.deepEqual(await channel.inspect('local', '/mac/app'), { local: 'inspect', q: { path: '/mac/app' } });
  assert.deepEqual((await channel.carry.plan('local', { path: '/mac/app' })).local, 'carryPlan');
  assert.deepEqual((await channel.carry.push('local', { key: 'carry-key-0001', path: '/mac/app', untracked: ['a'] })).local, 'carryPush');
  assert.deepEqual((await channel.carry.drop('local', { path: '/mac/app', branch: 'mopilot/carry/key-0001' })).local, 'carryDrop');
  assert.throws(
    () => channel.clone('local', { key: 'clone-key-0001', url: 'https://h/r.git', dest: '/x' }),
    (e: any) => e.code === 'unsupported' && /cannot clone the repository/.test(e.message),
  );
  // the changes from the machine land in the chat's folder here, through the Host's own apply
  const sha = 'a'.repeat(40);
  const ask = { key: 'carry-key-0001', path: '/mac/app', branch: 'mopilot/carry/key-0001', commit: sha, parent: sha };
  const applied = await channel.carry.apply('local', ask);
  assert.equal(applied.local, 'carryApply');
  assert.deepEqual(applied.q, { ...ask, sourceBranch: null });
  assert.deepEqual(calls, []);
});
