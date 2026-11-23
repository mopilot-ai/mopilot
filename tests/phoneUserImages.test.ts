// The pictures a user attached to a message, on the way to a paired phone: counted in the rows (chromePanelLive.cjs), kept by id in the live feed, read back from the harness's record (session/userImage.cjs), shrunk (app/phoneSteps.cjs userImage) and asked for as messages.image (remote/methods/steps.cjs, shared/remote/schema.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';
import { parseParams } from '../shared/remote/schema.mjs';

const require = createRequire(import.meta.url);
const { createPhoneSteps } = require('../electron/app/phoneSteps.cjs');
const { readUserImage, pictureAt, imagesOf, peerUserImage } = require('../electron/session/userImage.cjs');
const { peerHistoryReader } = require('../electron/session/peerTranscript.cjs');
const { rowsOf, withoutPictureOnlyRows } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { createItemFeed } = require('../electron/harness/remoteItemFeed.cjs');
const { openPhoneItems } = require('../electron/app/chromePanelPhones.cjs');

const URL = 'data:image/png;base64,iVBORw0KGgo=';
const user = (content: any[], id = 'u1') => ({
  id: 't',
  status: 'completed',
  items: [{ id, type: 'userMessage', content }],
});
const text = (t: string) => ({ type: 'text', text: t, text_elements: [] });

test('rows count the pictures a message came with, also when it is pictures alone; the side panel leaves such a row out', () => {
  const { rows } = rowsOf([
    user([text('look'), { type: 'image', url: '[image/png, 40 KB, not included]' }, { type: 'localImage', path: '/a.png' }], 'u1'),
    user([{ type: 'localImage', path: '/b.png' }], 'u2'),
    user([text('plain')], 'u3'),
  ]);
  assert.deepEqual(
    rows.map((r: any) => [r.text, r.images]),
    [
      ['look', 2],
      ['', 1],
      ['plain', undefined],
    ],
  );
  assert.deepEqual(
    withoutPictureOnlyRows(rows).map((r: any) => r.text),
    ['look', 'plain'],
  );
  // a message with neither text nor pictures is no row
  assert.equal(rowsOf([user([{ type: 'mention', name: 'x', path: '/x' }])]).rows.length, 0);
  assert.equal(rowsOf([{ id: 't', items: [{ id: 'u', type: 'userMessage' }] }]).rows.length, 0);
});

test('a message’s picture: a data: URL or a file, by item id or a saved row’s id, newest segment first; a link is never fetched', async () => {
  const read: string[] = [];
  const pages: Record<string, any> = {
    old: { turns: [user([{ type: 'image', url: URL }], 'o1')] },
    new: {
      turns: [
        {
          id: 't',
          items: [
            { id: 'a1', type: 'agentMessage', text: 'hi' },
            ...user([text('x'), { type: 'localImage', path: '/p.png' }, { type: 'image', url: 'https://x.test/a.png' }], 'n1').items,
          ],
        },
      ],
    },
  };
  const readTurns = async (seg: any) => (read.push(seg.id), pages[seg.id]);
  const record = {
    segments: [
      { id: 'old', nativeId: 'old', kind: 'codex' },
      { id: 'new', nativeId: 'new', kind: 'codex' },
    ],
  };
  assert.deepEqual(await readUserImage(record, readTurns, 'n1', 0), {
    path: '/p.png',
  });
  assert.deepEqual(read, ['old', 'new']);
  assert.deepEqual(await readUserImage(record, readTurns, JSON.stringify(['old', 't', 'o1']), 0), { url: URL });
  assert.equal(await readUserImage(record, readTurns, 'n1', 1), null, 'a link');
  assert.equal(await readUserImage(record, readTurns, 'n1', 5), null, 'no such picture');
  assert.equal(await readUserImage(record, readTurns, 'a1', 0), null, 'not a message of the user');
  assert.equal(await readUserImage(record, readTurns, 'zzz', 0), null);
  assert.equal(await readUserImage(record, readTurns, '[bad', 0), null);
  assert.equal(
    await readUserImage(record, readTurns, JSON.stringify(['live', 't', 'o1']), 0),
    null,
    'a live-scoped ref is never in history',
  );
  assert.equal(await readUserImage(undefined, readTurns, 'n1', 0), null);
  assert.equal(await readUserImage({ segments: [{ id: 'q' }] }, async () => ({ turns: [{ items: 'x' }, null] }), 'n1', 0), null);
  assert.equal(await readUserImage({ segments: [{ id: 'q' }] }, async () => null, 'n1', 0), null);
  assert.deepEqual(imagesOf(null), []);
  assert.equal(pictureAt({ content: [] }, 0), null);
  // by chat id, the record and the reader looked up at each read
  const chats = { records: new Map([['c', record]]) };
  assert.deepEqual(await peerUserImage(chats, () => readTurns)('c', 'o1', 0), {
    url: URL,
  });
  assert.equal(await peerUserImage(chats, () => readTurns)('gone', 'o1', 0), null);
  assert.equal(typeof peerHistoryReader(chats, () => readTurns).userImage, 'function');
});

const fakeImages = () => {
  const made: any[] = [];
  const picture = (w: number, h: number): any => ({
    getSize: () => ({ width: w, height: h }),
    resize: (o: any) => picture(o.width, o.height),
    toJPEG: () => Buffer.from('jpeg'),
  });
  return {
    made,
    nativeImage: {
      createFromDataURL: (u: string) => (made.push(['url', u]), picture(2000, 1000)),
      createFromBuffer: (b: Buffer) => (made.push(['file', b.toString()]), picture(b.toString() === 'empty' ? 0 : 100, 50)),
    },
  };
};

test('a message’s picture for a phone: from the record or the live feed, a file read once under a size cap, shrunk to a JPEG', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-images-'));
  const file = path.join(dir, 'shot.png');
  fs.writeFileSync(file, 'bytes');
  fs.writeFileSync(path.join(dir, 'empty.png'), 'empty');
  const sources: Record<string, any> = {
    a: { url: URL },
    f: { path: file },
    e: { path: path.join(dir, 'empty.png') },
    gone: { path: path.join(dir, 'nope.png') },
  };
  const { made, nativeImage } = fakeImages();
  const live: any = {
    peerRuntime: {
      readHistory: {
        userImage: async (_c: string, id: string) => sources[id] ?? null,
      },
    },
    phoneLiveImage: (_c: string, id: string) => (id === 'live' ? { url: URL } : null),
  };
  const steps = createPhoneSteps({ live, images: () => nativeImage });
  assert.deepEqual(await steps.userImage('c', 'a', 0, 360), {
    data: Buffer.from('jpeg').toString('base64'),
    width: 360,
    height: 180,
  });
  assert.deepEqual(await steps.userImage('c', 'f', 0, 360), {
    data: Buffer.from('jpeg').toString('base64'),
    width: 100,
    height: 50,
  });
  assert.deepEqual(made.at(-1), ['file', 'bytes']);
  assert.equal(await steps.userImage('c', 'e', 0, 360), null, 'a picture with no size');
  assert.equal(await steps.userImage('c', 'gone', 0, 360), null, 'a file that is gone');
  assert.ok(await steps.userImage('c', 'live', 0, 360), 'a turn not saved yet');
  assert.equal(await steps.userImage('c', 'none', 0, 360), null);
  // too large a file is not read
  const big = path.join(dir, 'big.png');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 26 * 1024 * 1024);
  sources.big = { path: big };
  assert.equal(await steps.userImage('c', 'big', 0, 360), null);
  // an inline picture beyond the size cap is not decoded
  sources.huge = { url: 'x'.repeat(Math.ceil((25 * 1024 * 1024 * 4) / 3) + 101) };
  assert.equal(await steps.userImage('c', 'huge', 0, 360), null);
  // an older runtime without the reader, and no live feed
  assert.equal(await createPhoneSteps({ live: {}, images: () => nativeImage }).userImage('c', 'a', 0, 360), null);
  fs.rmSync(dir, { recursive: true });
});

test('the live feed keeps a Claude message’s pictures as the app’s own turn does, and finds them by item id', () => {
  const out: any[] = [];
  const feed = createItemFeed({ emit: (e: any) => out.push(e) });
  const chat = 'claude:s';
  const start = {
    key: 'k',
    kind: 'turnStarting',
    turnId: 't',
    clientId: 'q',
    text: 'look',
  };
  feed.push(chat, 'claude', {
    ...start,
    attachments: [{ kind: 'image', path: '/a.png' }, { kind: 'file', path: '/b.txt' }, { kind: 'image' }],
  });
  const item = feed.snapshot(chat, 10).liveItems.find((x: any) => x.type === 'userMessage');
  assert.deepEqual(
    item.content.map((c: any) => c.type),
    ['text', 'localImage', 'mention', 'localImage'],
  );
  assert.equal(item.content[1].path, '/a.png');
  feed.push('claude:t', 'claude', { ...start, clientId: 'r' });
  assert.equal(feed.snapshot('claude:t', 10).liveItems.find((x: any) => x.type === 'userMessage').content.length, 1);
  const phones = openPhoneItems({
    service: () => ({ onFeedEvent: () => {}, attached: false }),
    chatOf: (k: string) => k,
    rows: async () => [],
  });
  assert.equal(typeof phones.liveImage, 'function');
  assert.equal(phones.liveImage('nobody', 'u-q', 0), null);
});

test('messages.image: a followed chat only, the Mac’s answer as it is, {} when there is none; the schema bounds the id, place and side', async () => {
  const asked: any[] = [];
  const r = rig({
    ops: {
      userImage: async (...a: any[]) => (asked.push(a), a[1] === 'i1' ? { data: 'eA==', width: 2, height: 1 } : null),
    },
  });
  const p = r.phone('p1');
  const reply = async (params: any) => p.ask('messages.image', params);
  assert.equal((await reply({ chatId: 'c1', itemId: 'i1', index: 0 })).ok, false);
  await p.ask('chat.follow', { chatId: 'c1' });
  assert.deepEqual((await reply({ chatId: 'c1', itemId: 'i1', index: 2, maxSide: 5000 })).result, { data: 'eA==', width: 2, height: 1 });
  assert.deepEqual(asked[0].slice(0, 4), ['c1', 'i1', 2, 1024]);
  assert.equal(typeof asked[0][4], 'function');
  assert.deepEqual((await reply({ chatId: 'c1', itemId: 'i9', index: 0 })).result, {});
  const bare = rig();
  const q = bare.phone('p1');
  await q.ask('chat.follow', { chatId: 'c1' });
  assert.deepEqual((await q.ask('messages.image', { chatId: 'c1', itemId: 'i1', index: 0 })).result, {});
  assert.deepEqual(parseParams('messages.image', { chatId: 'c1', itemId: 'x', index: 3 }), {
    chatId: 'c1',
    itemId: 'x',
    index: 3,
    maxSide: 360,
  });
  assert.throws(() => parseParams('messages.image', { chatId: 'c1', itemId: '', index: 0 }), /message/);
  assert.throws(
    () =>
      parseParams('messages.image', {
        chatId: 'c1',
        itemId: 'x'.repeat(2049),
        index: 0,
      }),
    /message/,
  );
  for (const index of [-1, 100, 1.5, '1'])
    assert.throws(() => parseParams('messages.image', { chatId: 'c1', itemId: 'x', index }), /picture/);
});

test('saved image identity keeps the native source, turn and segment slice when item ids repeat', async () => {
  const record = {
    segments: [
      { kind: 'codex', nativeId: 'old', count: 1 },
      { kind: 'codex', nativeId: 'new' },
    ],
  };
  const pages: any = {
    old: {
      turns: [
        user([{ type: 'localImage', path: '/old' }]),
        { ...user([{ type: 'localImage', path: '/excluded' }], 'secret'), id: 'excluded' },
      ],
    },
    new: { turns: [user([{ type: 'localImage', path: '/new' }])] },
  };
  const read = async (seg: any) => pages[seg.nativeId];
  assert.deepEqual(await readUserImage(record, read, '["old","t","u1"]', 0), { path: '/old' });
  assert.deepEqual(await readUserImage(record, read, '["new","t","u1"]', 0), { path: '/new' });
  assert.equal(await readUserImage(record, read, '["old","wrong","u1"]', 0), null);
  assert.equal(await readUserImage(record, read, 'secret', 0), null);
});

test('phone live references discard image bytes and local paths without changing attachment order', () => {
  const { phoneMessageItems } = require('../electron/app/phoneMessageItems.cjs');
  const items = [
    { type: 'userMessage', id: 'u', content: [text('look'), { type: 'image', url: URL }, { type: 'localImage', path: '/secret' }] },
    { type: 'agentMessage', text: 'reply' },
  ];
  const sent = phoneMessageItems(items);
  assert.deepEqual(sent[0].content, [text('look'), { type: 'image' }, { type: 'image' }]);
  assert.deepEqual(items[0].content?.[1], { type: 'image', url: URL }, 'the feed retains the original for messages.image');
  assert.equal(sent[1], items[1]);
});

test('live references include the exact turn and cannot satisfy a saved source/turn reference', async () => {
  const phones = openPhoneItems({ service: () => ({ attached: true, onFeedEvent: () => {} }), chatOf: () => 'c', rows: async () => [] });
  phones.live('claude', {
    key: 'k',
    kind: 'turnStarting',
    turnId: 't',
    clientId: 'q',
    text: 'look',
    attachments: [{ kind: 'image', path: '/live' }],
  });
  const snapshot = await phones.items('c', 20);
  const item = snapshot.items.find((x: any) => x.type === 'userMessage');
  assert.deepEqual(phones.liveImage('c', item.messageId, 0), { path: '/live' });
  assert.equal(phones.liveImage('c', '["wrong-source","wrong-turn","u-q"]', 0), null);
  assert.equal(phones.liveImage('c', 'u-q', 0), null);
  assert.equal(phones.liveImage('c', '[bad', 0), null);
  assert.deepEqual(item.content.at(-1), { type: 'image' });
});

test('image reads retire on unfollow, loss of reachability and replacement pair; step images share the guard', async () => {
  for (const method of ['messages.image', 'steps.thumbnail']) {
    for (const retire of ['unfollow', 'gone', 'pair']) {
      let finish!: (v: unknown) => void;
      const pending = new Promise((r) => {
        finish = r;
      });
      const r = rig({ ops: { userImage: () => pending, stepImage: () => pending } });
      const p = r.phone('p1');
      await p.ask('chat.follow', { chatId: 'c1' });
      await p.ask(method, { chatId: 'c1', itemId: 'u', callId: 'u', index: 0 }, 'image-read');
      if (retire === 'unfollow') await p.ask('chat.unfollow', { chatId: 'c1' });
      if (retire === 'gone') r.known.delete('c1');
      if (retire === 'pair') {
        r.link.removePair('p1');
        r.link.addPair('p1');
      }
      finish({ data: 'secret' });
      await settle();
      const reply = p.inbox.find((m: any) => m.inReplyTo === 'image-read');
      assert.equal(reply?.result?.data, undefined);
      if (retire !== 'pair') assert.equal(reply.ok, false);
    }
  }
});

test('JPEG answers are shrunk below the sealed frame budget and refused if even the smallest decode cannot fit', async () => {
  const picture = (size: number, stubborn = false): any => ({
    getSize: () => ({ width: size, height: size }),
    resize: ({ width }: any) => picture(width, stubborn),
    toJPEG: () => Buffer.alloc(stubborn || size > 256 ? 300_000 : 100_000),
  });
  const live = { peerRuntime: { readHistory: { userImage: async () => ({ url: URL }) } } };
  for (const stubborn of [false, true]) {
    const steps = createPhoneSteps({ live, images: () => ({ createFromDataURL: () => picture(1024, stubborn) }) });
    const result = await steps.userImage('c', 'u', 0, 1024);
    if (stubborn) assert.equal(result, null);
    else {
      assert.equal(result.width, 256);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 256_000);
    }
  }
});

test('a large image history has bounded native reads and retired queued reads never dispatch', async () => {
  const { createImageReads } = require('../electron/remote/phoneImageReads.cjs');
  const read = createImageReads(2, 3);
  let running = 0,
    peak = 0,
    current = true;
  const finishes: (() => void)[] = [];
  const check = () => {
    if (!current) throw new Error('retired');
  };
  const operation = () => {
    running++;
    peak = Math.max(peak, running);
    return new Promise((r) =>
      finishes.push(() => {
        running--;
        r('image');
      }),
    );
  };
  const jobs = Array.from({ length: 5 }, () => read(check, operation).catch((e: Error) => e.message));
  await assert.rejects(read(check, operation), /still loading/);
  assert.equal(peak, 2);
  current = false;
  finishes.splice(0).forEach((done) => done());
  assert.deepEqual(await Promise.all(jobs), Array(5).fill('retired'));
  current = true;
  const retry = read(check, async () => 'retry');
  assert.equal(await retry, 'retry');
});

test('bounded file reads join short reads, close the handle, and refuse a file that grows past its checked size', async (t) => {
  let closes = 0;
  let bytes = Buffer.from('bytes');
  t.mock.method(fs.promises, 'open', async () => ({
    stat: async () => ({ size: 5, isFile: () => true }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const count = Math.min(2, length, bytes.length - position);
      bytes.copy(buffer, offset, position, position + count);
      return { bytesRead: count };
    },
    close: async () => {
      closes++;
    },
  }));
  const { made, nativeImage } = fakeImages();
  const live = { peerRuntime: { readHistory: { userImage: async () => ({ path: '/short-read' }) } } };
  const steps = createPhoneSteps({ live, images: () => nativeImage });
  assert.ok(await steps.userImage('c', 'u', 0, 360));
  assert.deepEqual(made.at(-1), ['file', 'bytes']);
  bytes = Buffer.from('growing');
  assert.equal(await steps.userImage('c', 'u', 0, 360), null);
  bytes = Buffer.from('cut');
  assert.equal(await steps.userImage('c', 'u', 0, 360), null);
  assert.equal(closes, 3);
});
