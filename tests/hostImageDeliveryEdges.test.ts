// Remote image preparation can outlive its queued entry or machine; every such retirement refuses before native dispatch, and folder checks restart under the new owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { deliverRemote } = require('../electron/host/remoteSendDelivery.cjs');
const { createSendChecks } = require('../electron/host/remoteSendChecks.cjs');

for (const change of ['dispose', 'connection', 'removed', 'host', 'epoch'])
  test(`image upload finishes after ${change}: no native send or optimistic success is published`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-delivery-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'picked.png');
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    let disposed = false,
      queued = true,
      sends = 0,
      remembered = 0;
    let owner = { hostId: 'host', epoch: 1, folder: '/work' };
    const entry = {
      chatId: 'chat',
      epoch: 1,
      key: 'send',
      state: 'queued',
      options: { item: { text: '', attachments: [{ kind: 'image', path: file }], opts: {} } },
    };
    const host = {
      speaks: () => true,
      call: async (_method: string, p: any) => {
        if (change === 'dispose') disposed = true;
        if (change === 'connection') registered = {};
        if (change === 'removed') queued = false;
        if (change === 'host') owner = { ...owner, hostId: 'another' };
        if (change === 'epoch') owner = { ...owner, epoch: 2 };
        return { result: { imageId: p.imageId, received: p.size, done: true } };
      },
      send: async () => {
        sends++;
      },
    };
    let registered: any = host;
    const deps = {
      checks: { validate: async () => {} },
      subscribed: async () => {},
      disposed: () => disposed,
      outbox: { pending: () => (queued ? [entry] : []) },
      ownerOf: () => owner,
      state: () => ({ get: () => ({}) }),
      projection: {
        remember: () => {
          remembered++;
        },
        forget: () => {},
      },
      toldMode: new Map(),
      hostFor: () => registered,
    };
    const work = deliverRemote(entry, { ...owner }, host, deps);
    if (change === 'removed') assert.equal(await work, false);
    else await assert.rejects(work, { code: change === 'dispose' || change === 'connection' ? 'host_unreachable' : 'stale_epoch' });
    assert.equal(sends, 0);
    assert.equal(remembered, 0);
  });

test('an entry removed during subscription returns without beginning even an empty upload', async () => {
  const entry = { chatId: 'chat', epoch: 1, options: { item: { text: 'x' } } };
  const owner = { hostId: 'host', epoch: 1 };
  assert.equal(
    await deliverRemote(entry, owner, {}, { checks: { validate: async () => {} }, disposed: () => false, outbox: { pending: () => [] } }),
    false,
  );
  let sent = 0;
  const host = {
    send: async () => {
      sent++;
    },
  };
  assert.equal(
    await deliverRemote({ ...entry, key: 'id', state: 'queued' }, owner, host, {
      checks: { validate: async () => {} },
      disposed: () => false,
      outbox: { pending: () => [{ key: 'id', state: 'queued' }] },
      ownerOf: () => owner,
      state: () => ({ get: () => ({}) }),
      projection: { remember: () => {}, forget: () => {} },
      toldMode: new Map(),
      hostFor: () => host,
    }),
    true,
  );
  assert.equal(sent, 1, 'legacy messages with no attachments remain deliverable');
});

test('a folder verdict belonging to a retired owner is discarded and awaited for the new exact owner', async () => {
  let owner = { hostId: 'old', epoch: 1, folder: '/old' };
  const checked: string[] = [];
  const checks = createSendChecks({
    ownerOf: () => owner,
    checkFolder: async (hostId: string) => {
      checked.push(hostId);
    },
  });
  let resolve!: () => void;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  checks.set('chat', 'send', checks.observe(gate));
  const work = checks.validate({ chatId: 'chat', key: 'send', options: { requiresFolderCheck: true } });
  owner = { hostId: 'new', epoch: 2, folder: '/new' };
  resolve();
  await work;
  assert.deepEqual(checked, ['new']);
});

test('a file between two pictures stays as attached while each picture keeps its own uploaded digest, in order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-delivery-mixed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = path.join(dir, 'first.png');
  const second = path.join(dir, 'second.png');
  const note = path.join(dir, 'note.txt');
  fs.writeFileSync(first, Buffer.from('89504e470d0a1a0a01', 'hex'));
  fs.writeFileSync(second, Buffer.from('89504e470d0a1a0a02', 'hex'));
  fs.writeFileSync(note, 'notes');
  const owner = { hostId: 'host', epoch: 1, folder: '/work' };
  const attachments = [
    { kind: 'image', path: first },
    { kind: 'file', path: note },
    { kind: 'image', path: second },
  ];
  const entry = { chatId: 'chat', epoch: 1, key: 'send', state: 'queued', options: { item: { text: 'look', attachments, opts: {} } } };
  const host = {
    speaks: () => true,
    call: async (_method: string, p: any) => ({ result: { imageId: p.imageId, received: p.size, done: true } }),
    send: async () => {},
  };
  let named: any = null;
  await deliverRemote(entry, owner, host, {
    checks: { validate: async () => {} },
    subscribed: async () => {},
    disposed: () => false,
    outbox: { pending: () => [entry] },
    ownerOf: () => owner,
    state: () => ({ get: () => ({}) }),
    projection: {
      remember: (_c: string, _k: string, _t: string, item: any) => {
        named = item;
      },
      forget: () => {},
    },
    toldMode: new Map(),
    hostFor: () => host,
  });
  assert.equal(named.attachments.length, 3);
  assert.deepEqual(named.attachments[1], { kind: 'file', path: note }, 'the file is exactly as attached');
  assert.equal(named.attachments[0].path, first);
  assert.equal(named.attachments[2].path, second);
  assert.match(named.attachments[0].imageId, /^[0-9a-f]{64}$/);
  assert.match(named.attachments[2].imageId, /^[0-9a-f]{64}$/);
  assert.notEqual(named.attachments[0].imageId, named.attachments[2].imageId, 'each picture has its own digest, in order');
});
