// Production Host image protocol, real private store and native event producers: negotiation, full display input, and exact identity/epoch rechecks at the final wire boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostImages } from '../host/src/chatImages.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createChatLog } from '../host/src/chatLog.mjs';
import { imageReplyForWire } from '../host/src/imagePublication.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createCodexStream } from '../host/src/codexStream.mjs';
import { createTurnBridge } from '../host/src/turnBridge.mjs';
import { helloParams } from '../shared/host/schema.mjs';
import { userInput } from '../shared/userInput.mjs';
const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const imageId = createHash('sha256').update(bytes).digest('hex');
const quiet = { report: () => {} };
function setup(t: any, family = 'acp', anonymous = false, durable = false, known?: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-image-protocol-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host: any = new EventEmitter();
  host.cancel = () => {};
  const calls: any[] = [];
  const emit = (event: any) => host.emit('event', event);
  const codex = createCodexStream({ chatOf: (chatId: string) => chatId, emit });
  let active: any;
  const claude = createTurnBridge({
    state: { get: () => ({ activeTurn: active }) },
    controller: () => ({ ref: () => ({ kind: 'claude' }) }),
    emit,
    answer: () => {},
  });
  const runtime: any = {
    host,
    permit: () => true,
    familyOf: () => family,
    prepare: async () => {},
    send: async (p: any) => {
      p.check?.();
      calls.push(p);
      const user = { id: `u-${p.clientId}`, clientId: p.clientId, messageKey: p.clientId, content: userInput(p.text, p.attachments) };
      const turnId = family === 'claude' ? p.clientId : `native-${family}`;
      if (family === 'codex') codex.started(p.key, turnId, p.text, true, user);
      else if (family === 'claude') {
        active = { id: turnId, human: true };
        claude.noteUser(turnId, p.text, user);
        claude.patched({ chatId: p.key, patch: { turn: 'running' } });
      } else emit({ kind: 'turnStart', key: p.key, turnId, user });
      return { turnId };
    },
  };
  const epochs = createEpochStore(path.join(dir, 'epochs.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'ledger'), quiet) });
  const images = createHostImages({ dir: path.join(dir, 'images') });
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    images,
    ...(known ? { knownClients: () => known } : {}),
    ...(durable ? { dataDir: dir } : {}),
    status: () => ({ running: true }),
  });
  let owner: string | null = 'pair-a';
  const out: any[] = [];
  const conn = anonymous
    ? protocol.connection((m: any) => out.push(m))
    : protocol.connection(
        (m: any) => out.push(m),
        () => owner,
      );
  let sequence = 0;
  const call = (method: string, more: any = {}) =>
    conn.call(method, { chatId: 'chat', epoch: 1, key: `image-request-${++sequence}`, ...more });
  const upload = () => call('chat.attach', { imageId, size: bytes.length, mime: 'image/png', offset: 0, data: bytes.toString('base64') });
  return {
    dir,
    conn,
    call,
    upload,
    calls,
    out,
    epochs,
    owner: (value: string | null) => {
      owner = value;
    },
  };
}

for (const family of ['acp', 'codex', 'claude'])
  test(`${family}: uploaded images reach the original display user and immutable history references without private paths or inline bytes`, async (t) => {
    const h = setup(t, family);
    await h.conn.call('host.hello', helloParams());
    await h.call('chat.subscribe');
    assert.equal((await h.upload()).result.done, true);
    await h.call('chat.send', { key: 'original-message-key', text: 'look', images: [imageId] });
    assert.equal(h.calls[0].clientId, 'original-message-key');
    assert.equal(path.extname(h.calls[0].attachments[0].path), '.png');
    const starts = h.out.filter((frame) => frame.frame?.item?.event?.kind === 'turnStart');
    assert.equal(starts.length, 1);
    const user = starts[0].frame.item.event.user;
    assert.equal(user.clientId, 'original-message-key');
    assert.equal(user.content[1].url, `host-image:${imageId}`);
    assert.equal(JSON.stringify(h.out).includes(path.join(h.dir, 'images')), false);
    assert.equal(JSON.stringify(h.out).includes(bytes.toString('base64')), false);
    const picture = await h.call('chat.image', { imageId, offset: 0 });
    assert.equal(imageReplyForWire('chat.image', { result: picture }).result.data, bytes.toString('base64'));
  });

test('the final wire guard rejects a different still-paired identity and an epoch changed after the image read returned', async (t) => {
  for (const change of ['owner', 'epoch', 'close']) {
    const h = setup(t);
    await h.conn.call('host.hello', helloParams());
    await h.upload();
    const result = await h.call('chat.image', { imageId, offset: 0 });
    if (change === 'owner') h.owner('pair-b');
    if (change === 'epoch') h.epochs.admit('chat', 2);
    if (change === 'close') h.conn.close();
    const reply = imageReplyForWire('chat.image', { result });
    assert.equal(reply.result, undefined);
    assert.ok(reply.code === 'unknown_client' || reply.code === 'stale_epoch');
    assert.equal(JSON.stringify(reply).includes(bytes.toString('base64')), false);
  }
  assert.equal(imageReplyForWire('chat.image', { result: { data: 'unverified' } }).result, undefined);
});

test('old peers and caller-supplied owner fields cannot gain image access', async (t) => {
  const h = setup(t);
  const hello = helloParams();
  await h.conn.call('host.hello', { ...hello, features: hello.features.filter((f: string) => f !== 'chatImages') });
  await assert.rejects(h.upload(), /Update/);
  assert.equal(h.calls.length, 0);
  const newer = setup(t);
  await newer.conn.call('host.hello', helloParams());
  await newer.upload();
  newer.owner('pair-b');
  await assert.rejects(newer.call('chat.image', { owner: 'pair-a', imageId, offset: 0 }), /not available/);
});

test('a picture one paired client sent to the chat is read by another client of the Host, never through a field the caller supplies, and not by one the Host does not know', async (t) => {
  const h = setup(t, 'acp', false, false, ['pair-a', 'pair-b']);
  await h.conn.call('host.hello', helloParams());
  await h.upload();
  h.owner('pair-b');
  const read = await h.call('chat.image', { imageId, offset: 0 });
  assert.equal(imageReplyForWire('chat.image', { result: read }).result.data, bytes.toString('base64'));
  // another chat's picture with the same id is not found
  await assert.rejects(h.call('chat.image', { chatId: 'other-chat', imageId, offset: 0 }), /not available/);
  // what a client the Host does not know (one unpaired and gone from its request log) stored is not offered to the others
  const stranger = setup(t, 'acp', false, false, ['pair-b']);
  await stranger.conn.call('host.hello', helloParams());
  stranger.owner('pair-x');
  await stranger.upload();
  stranger.owner('pair-b');
  await assert.rejects(
    stranger.call('chat.image', {
      owner: 'pair-x',
      owners: ['pair-x'],
      imageId,
      offset: 0,
    }),
    /not available/,
  );
  // the CLI on the Host's own machine sent it: a paired client reads it too
  const cli = setup(t, 'acp', false, false, []);
  await cli.conn.call('host.hello', helloParams());
  cli.owner('local-cli');
  await cli.upload();
  cli.owner('pair-b');
  assert.equal((await cli.call('chat.image', { imageId, offset: 0 })).done, true);
});

test('a connection opened without an authenticated identity cannot upload or read images', async (t) => {
  const h = setup(t, 'acp', true);
  await h.conn.call('host.hello', helloParams());
  await assert.rejects(h.upload(), /Pair this client/);
  await assert.rejects(h.call('chat.image', { imageId, offset: 0 }), /Pair this client|unknown_client|pair/i);
  assert.equal(h.calls.length, 0);
});

for (const family of ['acp', 'claude', 'codex'])
  test(`${family}: image user identity and private references survive a fresh journal reader without re-dispatch`, async (t) => {
    const h = setup(t, family, false, true);
    await h.conn.call('host.hello', helloParams());
    await h.call('chat.subscribe');
    await h.upload();
    const send = { key: 'durable-image-key', text: 'keep this picture', images: [imageId] };
    await h.call('chat.send', send);
    await h.call('chat.send', send);
    assert.equal(h.calls.length, 1, 'the same request is not sent twice');
    const snapshots: any[] = [];
    const fresh = createChatLog({ dataDir: h.dir, epoch: () => 1 });
    fresh.hub.subscribe('chat', { send: (f) => (snapshots.push(f), true), close: () => {} });
    const users = snapshots[0].snapshot.items.filter((i: any) => i.t === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0].messageKey, send.key);
    assert.equal(users[0].user.clientId, send.key);
    assert.deepEqual(users[0].user.content[1], { type: 'image', url: `host-image:${imageId}` });
    assert.equal(JSON.stringify(snapshots).includes(path.join(h.dir, 'images')), false);
  });
