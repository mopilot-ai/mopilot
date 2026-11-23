// A machine chat's picture read back on reopen with main's own wiring (host:picture): the ownership service main binds (machines.cjs hostOwnership), the machine's connection (remote.cjs through chatIds.cjs), the real image store and read protocol; the reply is the picture, never "try again".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeNet } from './support/host-wire-kit.ts';
import { createHostImages } from '../host/src/chatImages.mjs';
import { createImageProtocol } from '../host/src/imageProtocol.mjs';
import { wireError } from '../host/src/protocol.mjs';
const require = createRequire(import.meta.url);
const { hostPicture, pictureIndex } = require('../electron/app/hostPicture.cjs');
const { createRemoteHost } = require('../electron/host/remote.cjs');
const { withAppChatIds } = require('../electron/host/chatIds.cjs');
const { hostOwnership } = require('../electron/host/machines.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const { digest } = require('../electron/host/imageTransfer.cjs');
const { scopedHostImageUrl } = require('../shared/host/images.mjs');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ID = digest(PNG);
const URL = scopedHostImageUrl('box', ID);
const EPOCH = 2;

test('a reopened machine chat draws its picture: the ownership main binds carries the epoch the machine checks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-picture-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set('c', { hostId: 'box', ownerHostId: 'box', epoch: EPOCH });
  // the machine: the real image store and read protocol, the picture sent by this Mac before
  const images = createHostImages({ dir: path.join(dir, 'images') });
  await images.upload({
    owner: 'mac',
    chatId: 'c',
    imageId: ID,
    offset: 0,
    size: PNG.length,
    mime: 'image/png',
    data: PNG.toString('base64'),
  });
  const media = createImageProtocol({ images, epochs: { current: () => EPOCH, admit: () => undefined } });
  const net = new FakeNet();
  net.handlers['host.hello'] = () => ({
    protocol: { minor: 1, floor: 1 },
    features: ['epoch', 'dedupe', 'isolation', 'lanes', 'chatImages', 'chatImagesChat'],
  });
  net.onRequest = (socket: any, request: any) => {
    const answer = (message: any) => socket.feed(message);
    if (request.method !== 'chat.image') return FakeNet.prototype.onRequest.call(net, socket, request);
    const connection = (socket.media ??= media.connection(() => 'mac'));
    Promise.resolve()
      .then(() => connection.read(connection.prepare(request.method, request.params)))
      .then(
        (result: any) => answer({ id: request.id, result }),
        (error: any) => answer({ id: request.id, error: wireError(error) }),
      );
  };
  const tunnel: any = { state: 'online', acquire: () => ({ socketPath: 'fake', release() {} }), onState: () => () => {}, fail() {} };
  const remote = createRemoteHost({ id: 'box', tunnel, connect: net.connect, epochOf: () => EPOCH, identity: null });
  t.after(() => remote.dispose());
  await remote.connect();
  // main's wiring: live.hostOwnership (ipc/host.cjs) and hostPhone.imageHostFor (machines().hostFor, the app-chat-id view of the connection)
  const live: any = {
    hostOwnership: hostOwnership({ dir, allowed: () => true }),
    hostPhone: { imageHostFor: (id: string) => (id === 'box' ? withAppChatIds(remote, () => false) : null) },
  };
  const reply = await hostPicture({
    live,
    chatId: 'c',
    url: URL,
    nameOf: () => 'This Mac’s Host',
    knows: pictureIndex(async () => [{ t: 'user', turnId: 't', user: { content: [{ type: 'image', url: URL }] } }]),
  });
  assert.deepEqual(reply, { picture: `data:image/png;base64,${PNG.toString('base64')}` });
});
