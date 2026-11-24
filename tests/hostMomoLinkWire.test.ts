// The owner's wire method for MoMo's link to other machines (host/src/methods/momoLink.mjs, shared/host/methods/momoLink.mjs): each op reaches the tasks service's key flow, a request that does not parse is refused with words, and the veil and the guard keep it to the owner's devices at the running home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import momoLink from '../host/src/methods/momoLink.mjs';
// @ts-ignore
import { parseParams } from '../shared/host/schema.mjs';
import { tasksWorld } from './support/host/momoTasksWorld.ts';

process.env.MOPILOT_MOMO_HOST_LINK = '1';
const machine = { id: 'm1', name: 'Studio mini', link: 'relay:abc123', hostId: 'b'.repeat(32) };
const who = (kind: string) => ({ fingerprint: `fp-${kind}`, name: kind, kind });

test('each op of the owner link method reaches the key flow, and only at the running home', async (t) => {
  const w = await tasksWorld(t);
  const file = momoLink({ momo: w.home });
  const run = (p: object) => (file.handlers['host.momoLink'] as any)(parseParams('host.momoLink', p), 'request', {});
  const { publicKey } = await run({ op: 'key' });
  assert.match(publicKey, /^[A-Za-z0-9+/=]{40,}$/);
  assert.deepEqual(await run({ op: 'allow', machine }), { allowed: true });
  assert.deepEqual((await run({ op: 'contract' })).machines, [], 'a machine allowed now does not wait');
  assert.deepEqual(await run({ op: 'registered', id: 'm1' }), { registered: true });
  assert.deepEqual(await run({ op: 'retired', publicKey }), { forgotten: true });
  assert.deepEqual(await run({ op: 'disallow', id: 'm1' }), { removed: true });
  // while this Host is not the running home the guard refuses it before anything is read
  const away = await tasksWorld(t, { start: false });
  const refused = momoLink({ momo: away.home }).handlers['host.momoLink'] as any;
  await assert.rejects(
    Promise.resolve().then(() => refused({ op: 'key' }, 'request', {})),
    (e: any) => e.code === 'momo_grant_lapsed' || e.code === 'momo_home_away',
  );
});

test('what does not parse is refused with words, and the veil lets only the owner devices at a granted home through', async (t) => {
  for (const bad of [
    {},
    { op: 'nope' },
    { op: 'allow' },
    { op: 'allow', machine: { id: 'm1', name: '', link: 'x', hostId: 'b'.repeat(32) } },
    { op: 'allow', machine: { id: 'm1', name: 'n', link: '', hostId: 'b'.repeat(32) } },
    { op: 'allow', machine: { id: 'm1', name: 'n', link: 'not a link', hostId: 'b'.repeat(32) } },
    { op: 'allow', machine: { id: 'm1', name: 'n', link: 'relay:a b', hostId: 'b'.repeat(32) } },
    ...['__proto__', 'constructor', 'prototype'].map((id) => ({
      op: 'allow',
      machine: { id, name: 'n', link: 'relay:abc', hostId: 'b'.repeat(32) },
    })),
    { op: 'disallow', id: '__proto__' },
    { op: 'registered', id: 'constructor' },
    { op: 'allow', machine: { id: 'm1', name: 'n', link: 'x', hostId: 'short' } },
    { op: 'disallow', id: '../x' },
    { op: 'retired', publicKey: '!' },
  ])
    assert.throws(() => parseParams('host.momoLink', bad), /./, JSON.stringify(bad));
  const w = await tasksWorld(t);
  const veil = momoLink({ momo: w.home }).veils['host.momoLink'];
  assert.equal(veil(who('desktop')), true);
  assert.equal(veil(who('phone')), true);
  for (const kind of ['home', 'cli', 'robot']) assert.equal(veil(who(kind)), false, kind);
  assert.equal(veil(null), false);
  assert.equal(momoLink({ momo: undefined }).veils['host.momoLink'](who('desktop')), false);
  assert.throws(
    () => momoLink({ momo: undefined }).guard('host.momoLink', () => 1)(),
    (e: any) => e.code === 'momo_home_away',
  );
});
