// Phone historical image routing exercises absent owners, authoritative source gates and connection retirement before any decode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { phoneHostImage } = require('../electron/app/phoneHostImages.cjs');
const { createPhoneSteps } = require('../electron/app/phoneSteps.cjs');
const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
const imageId = createHash('sha256').update(bytes).digest('hex');
const ref = { hostId: 'source', imageId };
const current = () => {};
const host = () => ({
  state: () => 'online',
  speaks: () => true,
  call: async () => ({ imageId, size: 8, mime: 'image/png', data: bytes.toString('base64'), nextOffset: 8, done: true }),
});

test('missing owner, local source and absent registered connection cannot borrow another image source', async () => {
  for (const live of [
    {},
    { hostOwnership: { get: () => null } },
    { hostOwnership: { get: () => ({ hostId: '', epoch: 1 }) } },
    { hostOwnership: { get: () => ({ hostId: 'local', epoch: 1 }) } },
    { hostOwnership: { get: () => ({ hostId: 'source', epoch: 1 }) } },
  ])
    assert.equal(await phoneHostImage(live, 'chat', { imageId }, current), null);
  assert.equal(
    await phoneHostImage({ hostOwnership: { get: () => ({ hostId: 'source', epoch: 1 }) } }, 'chat', { ...ref, hostId: 'local' }, current),
    null,
  );
  let fallback = 0;
  const live = {
    hostOwnership: { get: () => ({ hostId: 'source', epoch: 1 }) },
    hostPhone: { imageHostFor: () => null },
    imageHostFor: () => {
      fallback++;
      return host();
    },
  };
  assert.equal(await phoneHostImage(live, 'chat', ref, current), null);
  assert.equal(fallback, 0, 'a closed authoritative Host gate never falls through to a legacy registry');
});

test('an offline source is connected once and its exact owner/connection is rechecked before a historical read', async () => {
  let connects = 0;
  let owner: any = { hostId: 'source', epoch: 1 };
  const connection = {
    ...host(),
    state: () => 'offline',
    connect: async () => {
      connects++;
    },
  };
  const live = { hostOwnership: { get: () => owner }, hostPhone: {}, imageHostFor: () => connection };
  const answer = await phoneHostImage(live, 'chat', { imageId }, current);
  assert.deepEqual(answer.data, bytes);
  assert.equal(connects, 1);
  owner = null;
  assert.throws(answer.check, { code: 'stale_epoch' });
  const oldHost = { ...host(), speaks: () => false };
  const unavailable = {
    ...live,
    hostOwnership: { get: () => ({ hostId: 'source', epoch: 1 }) },
    imageHostFor: () => oldHost,
  };
  assert.equal(await phoneHostImage(unavailable, 'chat', ref, current), null);
});

for (const changed of ['removed', 'host', 'epoch', 'connection'])
  test(`retirement during connect (${changed}) never reads bytes`, async () => {
    let owner: any = { hostId: 'source', epoch: 1 },
      calls = 0;
    const connection = {
      ...host(),
      state: () => 'offline',
      call: async () => {
        calls++;
      },
      connect: async () => {
        if (changed === 'removed') owner = null;
        if (changed === 'host') owner = { hostId: 'another', epoch: 1 };
        if (changed === 'epoch') owner = { hostId: 'source', epoch: 2 };
        if (changed === 'connection') registered = host();
      },
    };
    let registered: any = connection;
    await assert.rejects(
      phoneHostImage({ hostOwnership: { get: () => owner }, hostPhone: { imageHostFor: () => registered } }, 'chat', ref, current),
      { code: 'stale_epoch' },
    );
    assert.equal(calls, 0);
  });

test('phone decode rejects an absent Host image and an oversized inline source without invoking the decoder', async () => {
  const images = () => {
    throw new Error('must not decode');
  };
  for (const source of [{ hostImage: ref }, { url: `data:image/png;base64,${'A'.repeat(Math.ceil((25 * 1024 * 1024 * 4) / 3) + 101)}` }]) {
    const steps = createPhoneSteps({ live: { peerRuntime: { readHistory: { userImage: async () => source } } }, images });
    assert.equal(await steps.userImage('chat', 'message', 0, 360, current), null);
  }
});
