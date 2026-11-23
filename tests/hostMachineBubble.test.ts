// A message sent to a chat on a machine keeps its pictures in the bubble when the Host's turn start replaces the one drawn at send (electron/host/remoteChats.cjs, shared/host/images.mjs withSentPictures, shared/host/turnStartPairs.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CHAT, end, ev, world } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
const { withSentPictures, withoutPreviewPaths, durableEvent } = require('../shared/host/images.mjs');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const { createStartPairs } = require('../shared/host/turnStartPairs.mjs');

const KEY = '00000000-0000-4000-8000-000000000001';
const ID = 'a'.repeat(64);
const PICTURES = [
  { kind: 'image', path: '/Users/me/one.png' },
  { kind: 'image', path: '/Users/me/two.png' },
];
const TEXT = { type: 'text', text: 'look', text_elements: [] };
const hostImage = (id = ID) => ({ type: 'image', url: `host-image:${id}` });
/** The user message of a recorded or shown turn start. */
const userOf = (w: ReturnType<typeof world>) => w.emitted.find((e) => e.kind === 'turnStart')?.user;
const recordOf = (w: ReturnType<typeof world>) => w.items.records.find((r) => r.t === 'user')?.user;
const sentOf = (attachments: any[] | undefined) => ({
  take: () => undefined,
  seen: () => undefined,
  attached: (_chat: string, key?: string) => (key === KEY ? attachments : undefined),
});
const startWith = (user: object) => ev({ kind: 'turnStart', turnId: 't1', user });

async function run(attachments: any[] | undefined, ...items: any[]) {
  const w = world(undefined, undefined, sentOf(attachments));
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  items.forEach((item, i) => w.host.fire.patch(CHAT, i + 1, item));
  await w.chats.settled(CHAT);
  return w;
}

const scoped = (id = ID) => ({
  type: 'image',
  url: `host-image:${encodeURIComponent(JSON.stringify(['m1', id]))}`,
});

test('a turn start that carries the Host’s refs to two pictures draws them from the files this Mac sent while live, and saves only the machine’s refs', async () => {
  const user = {
    id: `u-${KEY}`,
    clientId: KEY,
    messageKey: KEY,
    content: [TEXT, hostImage(), hostImage('b'.repeat(64)), { type: 'mention', name: 'a.txt' }],
  };
  const w = await run(PICTURES, startWith(user));
  assert.deepEqual(userOf(w).content, [
    TEXT,
    { ...scoped(), path: '/Users/me/one.png' },
    { ...scoped('b'.repeat(64)), path: '/Users/me/two.png' },
    { type: 'mention', name: 'a.txt' },
  ]);
  // the composer's files are temporary (pruned after a day): the record keeps the machine's durable refs and no path of this Mac
  assert.deepEqual(recordOf(w).content, [TEXT, scoped(), scoped('b'.repeat(64)), { type: 'mention', name: 'a.txt' }]);
  assert.equal(JSON.stringify(w.items.records).includes('/Users/me'), false);
  assert.equal(userOf(w).clientId, KEY);
});

test('the saved record still draws the pictures after the composer’s temporary files are pruned: the machine route resolves its refs', async () => {
  const { hostPicture, pictureIndex } = require('../electron/app/hostPicture.cjs');
  const { scopedHostImageUrl } = require('../shared/host/images.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-prune-'));
  const file = path.join(dir, 'paste.png');
  fs.writeFileSync(file, PNG);
  const id = createHash('sha256').update(PNG).digest('hex');
  const w = await run(
    [{ kind: 'image', path: file }],
    startWith({
      id: 'u',
      clientId: KEY,
      messageKey: KEY,
      content: [TEXT, hostImage(id)],
    }),
  );
  assert.equal(userOf(w).content[1].path, file, 'live: the file is the preview');
  fs.rmSync(dir, { recursive: true });
  // a day later: the file is gone; reopened from the saved record, the picture comes from the machine
  const saved = w.items.records;
  const url = recordOf(w).content[1].url;
  assert.equal(url, scopedHostImageUrl('m1', id));
  const host = {
    state: () => 'online',
    speaks: () => true,
    call: async () => ({
      imageId: id,
      size: PNG.length,
      mime: 'image/png',
      data: PNG.toString('base64'),
      nextOffset: PNG.length,
      done: true,
    }),
  };
  const live = {
    hostOwnership: { get: () => ({ hostId: 'm1', epoch: 1 }) },
    hostPhone: { imageHostFor: () => host },
  };
  const reply = await hostPicture({
    live,
    chatId: CHAT,
    url,
    nameOf: () => 'Studio',
    knows: pictureIndex(async () => saved),
  });
  assert.deepEqual(reply, {
    picture: `data:image/png;base64,${PNG.toString('base64')}`,
  });
});

test('a Host that echoes the message without its pictures still shows them', async () => {
  const w = await run(PICTURES, startWith({ id: `u-${KEY}`, clientId: KEY, content: [TEXT] }));
  assert.deepEqual(
    userOf(w).content.map((c: any) => c.type),
    ['text', 'localImage', 'localImage'],
  );
  assert.deepEqual(recordOf(w).content, [TEXT], 'a picture the machine never named has nothing durable to save');
});

test('a turn start without a user message is drawn from the Host’s user item, with the pictures sent and the key the window drew it under', async () => {
  const user = { id: `u-${KEY}`, clientId: KEY, content: [TEXT, hostImage()] };
  const w = await run(
    PICTURES,
    ev({ kind: 'turnStart', turnId: 't1', messageKey: KEY }),
    { t: 'user', turnId: 't1', text: 'look', key: KEY, user },
    end(),
  );
  const shown = userOf(w);
  assert.equal(shown.clientId, KEY);
  assert.deepEqual(
    shown.content.map((c: any) => c.path ?? c.type),
    ['text', '/Users/me/one.png', '/Users/me/two.png'],
  );
});

test('a start released by the agent’s first event with the text this Mac sent is keyed by the message and carries its pictures', async () => {
  const w = world(undefined, undefined, { ...sentOf(PICTURES), take: () => 'look' });
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  w.host.fire.patch(CHAT, 1, ev({ kind: 'turnStart', turnId: 't1', messageKey: KEY }));
  w.host.fire.patch(
    CHAT,
    2,
    ev({ kind: 'update', turnId: 't1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } }),
  );
  await w.chats.settled(CHAT);
  const shown = userOf(w);
  assert.equal(shown.clientId, KEY);
  assert.deepEqual(
    shown.content.map((c: any) => c.type),
    ['text', 'localImage', 'localImage'],
  );
});

test('a message with no pictures, one this Mac did not send and a Host ref it cannot match keep what the Host said', async () => {
  const user = { id: 'u', clientId: KEY, content: [TEXT, hostImage()] };
  for (const attachments of [[], [{ kind: 'file', path: '/x' }], undefined]) {
    const w = await run(attachments, startWith(user));
    assert.deepEqual(userOf(w).content[1], { type: 'image', url: `host-image:${encodeURIComponent(JSON.stringify(['m1', ID]))}` });
  }
  const other = await run(PICTURES, startWith({ id: 'u', clientId: 'someone-elses', content: [TEXT, hostImage()] }));
  assert.equal(userOf(other).content[1].type, 'image');
});

test('withSentPictures gives each of the Host’s pictures its file in order, adds the ones the Host left out after the text, and leaves a user without content alone', () => {
  assert.deepEqual(withSentPictures({ content: [hostImage()] }, PICTURES).content, [
    { type: 'image', url: `host-image:${ID}`, path: '/Users/me/one.png' },
    { type: 'localImage', path: '/Users/me/two.png' },
  ]);
  assert.deepEqual(
    withSentPictures({ content: [TEXT, hostImage(), { type: 'mention', name: 'a' }] }, PICTURES).content.map((c: any) => c.path ?? c.type),
    ['text', '/Users/me/one.png', '/Users/me/two.png', 'mention'],
  );
  // more Host pictures than files: the rest keep what the Host said
  assert.deepEqual(
    withSentPictures({ content: [hostImage(), hostImage('c'.repeat(64))] }, [PICTURES[0]]).content[1],
    hostImage('c'.repeat(64)),
  );
  assert.deepEqual(withSentPictures({ id: 'u' }, PICTURES), { id: 'u' });
  assert.deepEqual(withSentPictures({ content: [TEXT] }, [{ kind: 'image' }]), { content: [TEXT] });
  assert.deepEqual(withSentPictures({ content: [TEXT] }, 'nope'), { content: [TEXT] });
});

test('a picture the Host’s echo left without a reference is saved with the one its upload made, so it is still the machine’s picture after a reload', async () => {
  const named = [
    { kind: 'image', path: '/Users/me/one.png', imageId: ID },
    { kind: 'image', path: '/Users/me/two.png', imageId: 'b'.repeat(64) },
  ];
  // the echo has a bare picture: it gets the digest's reference beside the file the live bubble draws from, and one the echo left out is added the same way
  const w = await run(named, startWith({ id: 'u', clientId: KEY, messageKey: KEY, content: [TEXT, { type: 'image' }] }));
  assert.deepEqual(userOf(w).content, [
    TEXT,
    { ...scoped(), path: '/Users/me/one.png' },
    { ...scoped('b'.repeat(64)), path: '/Users/me/two.png' },
  ]);
  assert.deepEqual(recordOf(w).content, [TEXT, scoped(), scoped('b'.repeat(64))]);
  // a digest that is not one names nothing, and a call without the machine's id keeps the old shape
  const odd = withSentPictures({ content: [{ type: 'image' }] }, [{ kind: 'image', path: '/a.png', imageId: 'nope' }], 'm1');
  assert.deepEqual(odd.content, [{ type: 'image', path: '/a.png' }]);
  assert.deepEqual(withSentPictures({ content: [{ type: 'image' }] }, named).content, [
    { type: 'image', path: '/Users/me/one.png' },
    { type: 'localImage', path: '/Users/me/two.png' },
  ]);
});

test('withoutPreviewPaths drops the files a live bubble drew from and the pictures it added, and nothing else', () => {
  const live = {
    id: 'u',
    content: [
      TEXT,
      { ...hostImage(), path: '/tmp/a.png' },
      { type: 'localImage', path: '/tmp/b.png' },
      hostImage('c'.repeat(64)),
      { type: 'mention' },
    ],
  };
  assert.deepEqual(withoutPreviewPaths(live), {
    id: 'u',
    content: [TEXT, hostImage(), hostImage('c'.repeat(64)), { type: 'mention' }],
  });
  assert.deepEqual(withoutPreviewPaths({ id: 'u' }), { id: 'u' });
  assert.equal(withoutPreviewPaths(undefined), undefined);
  const bare = { kind: 'turnEnd' };
  assert.equal(durableEvent(bare), bare);
  assert.deepEqual(durableEvent({ kind: 'turnStart', user: live }).user, withoutPreviewPaths(live));
});

test('a user item that names the message key gives the turn that client id; one nobody keyed keeps the turn id', () => {
  const pairs = createStartPairs();
  const turnStart = (turnId: string) => ({ kind: 'turnStart', turnId });
  pairs.take(null, turnStart('t1'));
  const [keyed] = pairs.take({ t: 'user', turnId: 't1', text: 'hi', key: KEY }, null);
  assert.equal(keyed.user.clientId, KEY);
  pairs.take(null, turnStart('t2'));
  const [plain] = pairs.take({ t: 'user', turnId: 't2', text: 'hi' }, null);
  assert.equal(plain.user.clientId, 't2');
});
