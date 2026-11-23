// A picture sent to a chat on a machine is read back from it for a window (electron/app/hostPicture.cjs, host:picture): drawn when the machine has it, and otherwise the real reason: away, moved, not paired any more, a Host too old, or no longer there. The machine is the real image store and read protocol (host/src/chatImages.mjs, imageProtocol.mjs), so who sent the picture counts as it does there.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHostImages } from '../host/src/chatImages.mjs';
import { createImageProtocol } from '../host/src/imageProtocol.mjs';
import { HostRefusal } from '../host/src/hostFs.mjs';
const require = createRequire(import.meta.url);
const { hostPicture, hostPictureHandler, pictureIndex } = require('../electron/app/hostPicture.cjs');
const { digest } = require('../electron/host/imageTransfer.cjs');
const { scopedHostImageUrl } = require('../shared/host/images.mjs');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ID = digest(PNG);
const URL = scopedHostImageUrl('box', ID);
const nameOf = (id: string) => (id === 'box' ? 'Studio' : null);
const BARE = `host-image:${ID}`;
const ELSEWHERE = scopedHostImageUrl('elsewhere', ID);
/** The chat's saved records: its messages name these pictures. */
const records = (...urls: string[]) => [
  {
    t: 'user',
    turnId: 't',
    user: { content: urls.map((url) => ({ type: 'image', url })) },
  },
];
const knowsOf = (...urls: string[]) => pictureIndex(async () => records(...urls));
const knows = knowsOf(URL, BARE, ELSEWHERE);
const upload = (images: any, owner: string, chatId: string, bytes = PNG) =>
  images.upload({
    owner,
    chatId,
    imageId: digest(bytes),
    offset: 0,
    size: bytes.length,
    mime: 'image/png',
    data: bytes.toString('base64'),
  });

/** This Mac ('mac') asks a machine whose image store holds what the clients of its chats uploaded; `others` are the other clients of its account. */
function world(
  t: any,
  o: {
    state?: string;
    connectFails?: boolean;
    speaks?: boolean;
    throws?: any;
    others?: string[];
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-picture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const images = createHostImages({ dir });
  const media = createImageProtocol({
    images,
    epochs: { current: () => 3, admit: () => undefined },
    clients: () => o.others ?? ['phone'],
  });
  const calls: any[] = [];
  const connection = media.connection(() => 'mac');
  const host: any = {
    state: () => o.state ?? 'online',
    connect: async () => {
      if (o.connectFails) throw Object.assign(new Error('away'), { code: 'host_unreachable' });
    },
    speaks: () => o.speaks ?? true,
    call: async (method: string, p: any) => {
      calls.push([method, p.imageId]);
      if (o.throws) throw o.throws;
      return connection.read(connection.prepare(method, p));
    },
  };
  const live: any = {
    hostOwnership: { get: (chat: string) => (chat === 'local-chat' ? { hostId: 'local', epoch: 0 } : { hostId: 'box', epoch: 3 }) },
    hostPhone: { imageHostFor: (id: string) => (id === 'box' ? host : null) },
  };
  return { live, calls, host, images };
}
const ask = (w: any, url = URL, chatId = 'c', k = knows) => hostPicture({ live: w.live, chatId, url, nameOf, knows: k });

test('a picture this Mac sent comes back as a data URL', async (t) => {
  const w = world(t);
  await upload(w.images, 'mac', 'c');
  assert.deepEqual(await ask(w), {
    picture: `data:image/png;base64,${PNG.toString('base64')}`,
  });
  assert.deepEqual(w.calls, [['chat.image', ID]]);
});

test('a picture another client of the account sent to the chat (the phone, an earlier key of this Mac) is shown, and one of another chat is not', async (t) => {
  const w = world(t);
  await upload(w.images, 'phone', 'c');
  assert.deepEqual(await ask(w), {
    picture: `data:image/png;base64,${PNG.toString('base64')}`,
  });
  // the same reference in a chat nobody sent it to: the machine does not have it
  assert.deepEqual(await ask(w, URL, 'c2'), { gone: true, machine: 'Studio' });
  // a client the machine does not know of
  const stranger = world(t, { others: [] });
  await upload(stranger.images, 'phone', 'c');
  assert.deepEqual(await ask(stranger), { gone: true, machine: 'Studio' });
});

test('a reference that names no machine is read from the machine that owns the chat', async (t) => {
  const w = world(t);
  await upload(w.images, 'mac', 'c');
  assert.equal('picture' in (await ask(w, BARE)), true);
});

test('a machine that is away, at the start or while fetching, is offline under its name', async (t) => {
  const idle = world(t, { state: 'offline', connectFails: true });
  assert.deepEqual(await ask(idle), { offline: 'Studio' });
  const down = world(t, {
    state: 'offline',
    throws: new Error('socket closed'),
  });
  assert.deepEqual(await ask(down), { offline: 'Studio' });
  const away = world(t, {
    throws: Object.assign(new Error('x'), { code: 'host_unreachable' }),
  });
  assert.deepEqual(await ask(away), { offline: 'Studio' });
  const none = world(t);
  none.live.hostPhone.imageHostFor = () => null as any;
  assert.deepEqual(await ask(none), { offline: 'Studio' });
});

test('each refusal says what it is: moved, not paired, a Host too old, gone, or a plain failure to try again', async (t) => {
  const refuse = (code: string) => world(t, { throws: Object.assign(new Error('refused'), { code }) });
  assert.deepEqual(await ask(refuse('stale_epoch')), { retry: 'Studio' });
  assert.deepEqual(await ask(refuse('unknown_client')), { blocked: 'Studio' });
  assert.deepEqual(await ask(refuse('forbidden')), { blocked: 'Studio' });
  assert.deepEqual(await ask(refuse('feature_missing')), { update: 'Studio' });
  assert.deepEqual(await ask(refuse('unsupported')), { update: 'Studio' });
  assert.deepEqual(await ask(refuse('image_unavailable')), {
    gone: true,
    machine: 'Studio',
  });
  assert.deepEqual(await ask(refuse('something_else')), { retry: 'Studio' });
  // the real refusal of the machine for a picture it does not hold
  const w = world(t, {
    throws: new HostRefusal('image_unavailable', 'That image is not available on this Host.'),
  });
  assert.deepEqual(await ask(w), { gone: true, machine: 'Studio' });
});

test('a picture an online machine no longer has is gone with its name, a Host too old to read pictures is to be updated, and a machine without a name is "the machine"', async (t) => {
  const w = world(t);
  w.host.call = async () => ({ imageId: 'other', size: 1 });
  assert.deepEqual(await ask(w), { gone: true, machine: 'Studio' });
  const old = world(t, { speaks: false });
  assert.deepEqual(await ask(old), { update: 'Studio' });
  const unnamed = world(t);
  unnamed.live.hostPhone.imageHostFor = () => null as any;
  assert.deepEqual(await ask(unnamed, ELSEWHERE), { offline: 'the machine' });
  // a host that has no feature list: not told to update
  const plain = world(t);
  plain.host.speaks = undefined;
  plain.host.call = async () => ({ imageId: 'other', size: 1 });
  assert.deepEqual(await ask(plain), { gone: true, machine: 'Studio' });
});

test('a reference that is not a Host picture, and a chat that runs here, are gone and ask no machine', async (t) => {
  const w = world(t);
  assert.deepEqual(await ask(w, 'data:image/png;base64,AA'), { gone: true });
  assert.deepEqual(await ask(w, URL, 'local-chat'), { gone: true });
  assert.deepEqual(
    await hostPicture({
      live: { hostOwnership: { get: () => null } },
      chatId: 'c',
      url: URL,
      nameOf,
      knows,
    }),
    { gone: true },
  );
  assert.deepEqual(await hostPicture({ live: {}, chatId: 'c', url: URL, nameOf, knows }), { gone: true });
  assert.deepEqual(w.calls, []);
});

test('a picture the chat’s own history does not name is refused: another chat’s, another machine’s, or a guess', async (t) => {
  const w = world(t);
  const other = scopedHostImageUrl('box', digest(Buffer.from('another chat’s picture')));
  const elsewhere = scopedHostImageUrl('other-machine', ID);
  for (const url of [other, elsewhere, `host-image:${digest(Buffer.from('x'))}`]) {
    await assert.rejects(ask(w, url), {
      code: 'invalid',
      message: 'That picture is not in this chat.',
    });
  }
  await assert.rejects(ask(w, ELSEWHERE, 'c', knowsOf(URL)), {
    code: 'invalid',
  });
  await assert.rejects(
    ask(
      w,
      URL,
      'c',
      pictureIndex(async () => [{ t: 'assistant' }, { t: 'user' }, { t: 'user', user: { content: [{ url: 1 }, null] } }]),
    ),
    {
      code: 'invalid',
    },
  );
  assert.deepEqual(w.calls, [], 'no machine was asked');
});

test('the chat’s pictures are listed once for the pictures of one draw, and a reference the list lacks is refused in that window and looked for again after it', async (t) => {
  const w = world(t);
  await upload(w.images, 'mac', 'c');
  let reads = 0;
  let at = 1000;
  let saved = records(URL);
  const knowsNow = pictureIndex(
    async () => (reads++, saved),
    () => at,
  );
  for (let i = 0; i < 5; i++) assert.equal('picture' in (await ask(w, URL, 'c', knowsNow)), true);
  assert.equal(reads, 1, 'five pictures, one read of the history');
  // a reference the list lacks is refused from a list under 300 ms old: guesses do not each read the whole history
  saved = records(URL, BARE);
  for (let i = 0; i < 3; i++) await assert.rejects(ask(w, BARE, 'c', knowsNow), { code: 'invalid' });
  assert.equal(reads, 1);
  // a message another client saved half a second after the list is found in a fresh read, asked a second after it
  at += 1000;
  assert.equal('picture' in (await ask(w, BARE, 'c', knowsNow)), true);
  assert.equal(reads, 2);
  // and that read is coalesced and bounded: guesses right after it do not read again
  for (let i = 0; i < 3; i++) await assert.rejects(ask(w, `host-image:${'f'.repeat(64)}`, 'c', knowsNow), { code: 'invalid' });
  assert.equal(reads, 2);
  // a picture already listed is known without a read for the whole window, and after it the history is read again
  assert.equal('picture' in (await ask(w, URL, 'c', knowsNow)), true);
  assert.equal(reads, 2);
  at += 5000;
  assert.equal('picture' in (await ask(w, URL, 'c', knowsNow)), true);
  assert.equal(reads, 3);
  // another chat has its own list
  await assert.rejects(
    ask(
      w,
      URL,
      'other',
      pictureIndex(async () => records()),
    ),
    { code: 'invalid' },
  );
});

test('a picture of the biggest size the Host takes is drawn: it is not refused after the whole download', async (t) => {
  const { MAX_IMAGE_BYTES } = require('../shared/host/images.mjs');
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length)]);
  const id = digest(big);
  const url = scopedHostImageUrl('box', id);
  const w = world(t);
  w.host.call = async (_m: string, p: any) => {
    const data = big.subarray(p.offset, p.offset + p.limit);
    const next = p.offset + data.length;
    return { imageId: id, size: big.length, mime: 'image/png', data: data.toString('base64'), nextOffset: next, done: next === big.length };
  };
  const reply = await ask(w, url, 'c', knowsOf(url));
  assert.equal('picture' in reply && reply.picture.length > MAX_IMAGE_BYTES, true);
});

test('IPC: host:picture answers with the picture or why not, names the machine from its row, and is refused while Host is off', async (t) => {
  const { register } = require('../electron/app/ipc/host.cjs');
  let allowed = true;
  const handlers = new Map<string, any>();
  const w = world(t, { state: 'offline', connectFails: true });
  const own = { ...w.live };
  w.live.acpHost = { items: { readAsync: async () => records(URL, ELSEWHERE) } };
  const svc: any = { row: (id: string) => (id === 'box' ? { name: 'Studio' } : undefined) };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    {
      app: { getPath: () => '/ud' },
      shell: { openExternal: async () => undefined },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll: () => undefined,
      live: w.live,
    },
    { create: () => svc, allowed: () => allowed },
  );
  // registering made main's own ownership and phone services: the chat is put on the machine after it
  Object.assign(w.live, own);
  const call = (...a: any[]) => handlers.get('host:picture')({}, ...a);
  assert.deepEqual(await call('c', URL), { value: { offline: 'Studio' } });
  assert.deepEqual(await call(undefined, undefined), { value: { gone: true } });
  // a reference its chat does not hold is refused with a plain error, and a chat with no saved history holds none
  assert.equal(
    (await call('c', scopedHostImageUrl('box', digest(Buffer.from('guess'))))).error.message,
    'That picture is not in this chat.',
  );
  w.live.acpHost = undefined;
  assert.equal((await call('c', BARE)).error.code, 'invalid');
  w.live.acpHost = {
    items: { readAsync: async () => records(URL, ELSEWHERE) },
  };
  // a machine its registry has no row for is "the machine"
  assert.deepEqual(await call('c', scopedHostImageUrl('elsewhere', ID)), { value: { offline: 'the machine' } });
  allowed = false;
  assert.equal((await call('c', URL)).error.code, 'not_allowed');
});

test('the lists of chats are bounded (the least recently asked go first), a history that cannot be read is to try again and not gone, and one read serves pictures asked together', async (t) => {
  const w = world(t);
  await upload(w.images, 'mac', 'c');
  let reads = 0;
  const at = 1000;
  const knowsNow = pictureIndex(
    async () => (reads++, records(URL)),
    () => at,
  );
  for (let i = 0; i < 40; i++) assert.equal(await knowsNow(`chat-${i}`, URL), true);
  assert.equal(reads, 40);
  await knowsNow('chat-39', URL);
  assert.equal(reads, 40, 'a recent chat is still listed');
  await knowsNow('chat-0', URL);
  assert.equal(reads, 41, 'the oldest of 40 chats was dropped to stay within 32');
  // asked together, one read
  reads = 0;
  const together = pictureIndex(async () => (reads++, await Promise.resolve(records(URL))));
  assert.deepEqual(await Promise.all([together('x', URL), together('x', BARE), together('x', URL)]), [true, false, true]);
  assert.equal(reads, 1);
  // the history cannot be read right now: nothing is said of the picture, and nothing is remembered
  let broken = true;
  const flaky = pictureIndex(async () => {
    if (broken) throw new Error('EIO');
    return records(URL);
  });
  assert.deepEqual(await ask(w, URL, 'c', flaky), { retry: 'Studio' });
  broken = false;
  assert.equal('picture' in (await ask(w, URL, 'c', flaky)), true);
});

test('a Host that cannot read a chat’s pictures for every client says "update", not that a sibling client’s picture is gone', async (t) => {
  const { CHAT_IMAGE_FEATURE, IMAGE_FEATURE } = require('../shared/host/images.mjs');
  const { FEATURES, helloParams } = require('../shared/host/schema.mjs');
  assert.ok(FEATURES.includes(CHAT_IMAGE_FEATURE) && helloParams().features.includes(CHAT_IMAGE_FEATURE));
  const lacking = (feature: string) => {
    const w = world(t);
    w.host.speaks = (f: string) => f !== feature;
    return w;
  };
  // its refusal for a picture it does not find in the asking client's own scope
  assert.deepEqual(await ask(lacking(CHAT_IMAGE_FEATURE)), { update: 'Studio' });
  assert.deepEqual(await ask(lacking(IMAGE_FEATURE)), { update: 'Studio' });
  // a Host that has both and does not find it says gone
  assert.deepEqual(await ask(world(t)), { gone: true, machine: 'Studio' });
  // no bytes and no refusal from a Host without the per-chat read
  const quiet = lacking(CHAT_IMAGE_FEATURE);
  quiet.host.call = async () => ({ imageId: 'other', size: 1 });
  assert.deepEqual(await ask(quiet), { update: 'Studio' });
});

test('a machine that could not read a picture it holds (a fault, not absence) is to try again; a record it cannot read is such a fault', async (t) => {
  const faulty = world(t, { throws: new HostRefusal('image_fault', 'The image record could not be read.') });
  assert.deepEqual(await ask(faulty), { retry: 'Studio' });
  // the real store: a damaged record is a fault with its own code, an absent picture stays "not available"
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-picture-fault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const images = createHostImages({ dir });
  await upload(images, 'mac', 'c');
  const meta = fs.readdirSync(dir).find((n) => n.endsWith('.json'))!;
  fs.writeFileSync(path.join(dir, meta), '{ not json');
  await assert.rejects(images.read({ owner: 'mac', chatId: 'c', imageId: ID, offset: 0, limit: 10 }), { code: 'image_fault' });
  await assert.rejects(images.read({ owner: 'mac', chatId: 'other', imageId: ID, offset: 0, limit: 10 }), { code: 'image_unavailable' });
  // an unexpected fault of the disk, with no code of its own
  const broken = createHostImages({ dir });
  t.mock.method(fs.promises, 'readdir', () => Promise.reject(Object.assign(new Error('EMFILE'), { code: 'EMFILE' })));
  await assert.rejects(broken.attachments('mac', 'c', [ID]), { code: 'image_fault' });
  t.mock.restoreAll();
});

test('who may read a chat’s picture: every client currently paired with the Host, for that chat; a client removed from it cannot, and what it sent stays readable to the paired ones', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-picture-removed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const images = createHostImages({ dir });
  let paired = ['phone', 'mac'];
  // the request log names who ever sent the chat a request, a removed client included
  const media = createImageProtocol({
    images,
    epochs: { current: () => 3, admit: () => undefined },
    clients: () => paired,
    guard: { clients: (chat: string) => (chat === 'c' ? ['phone', 'mac', 'gone'] : []) },
  });
  await upload(images, 'gone', 'c');
  const read = async (who: string | null, chatId = 'c') => {
    const connection = media.connection(() => who);
    return connection.read(connection.prepare('chat.image', { chatId, epoch: 3, imageId: ID, offset: 0, limit: 64 }));
  };
  // both paired clients read a picture a since-removed client sent
  for (const who of ['phone', 'mac']) assert.equal((await read(who)).done, true);
  // the removed client holds no identity on the Host (host/src/server.mjs imageIdentity): refused, even though its own copy is on disk
  await assert.rejects(read(null), { code: 'unknown_client' });
  // the phone is removed too: the one client left paired still reads what the removed ones sent
  paired = ['mac'];
  assert.equal((await read('mac')).done, true);
  // another chat's picture is never found
  await assert.rejects(read('mac', 'other'), { code: 'image_unavailable' });
});

test('host:picture reads the chat records from the live acpHost: no service or a nullish read is refused, a record that names the picture is served', async (t) => {
  const w = world(t);
  await upload(w.images, 'mac', 'c');
  const machines = () => ({ row: () => ({ name: 'Studio' }) });
  const serve = (acpHost: any, chat = 'c') => hostPictureHandler(() => ({ ...w.live, acpHost }), machines)(chat, URL);
  const notHere = { code: 'invalid', message: 'That picture is not in this chat.' };
  // the machine has the picture, but nothing saved on this Mac names it: each shape of a missing read is refused
  await assert.rejects(serve(undefined, 'c-0'), notHere);
  await assert.rejects(serve({}, 'c-1'), notHere);
  // a service that cannot read at all is a history that cannot be read now: try again, never "gone"
  assert.deepEqual(await serve({ items: {} }, 'c-2'), { retry: 'Studio' });
  await assert.rejects(serve({ items: { readAsync: async () => undefined } }, 'c-3'), notHere);
  // with no live services at all, nothing can name or serve the picture
  await assert.rejects(Promise.resolve().then(() => hostPictureHandler(() => null, machines)('c', URL)));
  // a saved message that names the picture is read by the chat's id and the picture comes back
  let asked = '';
  const named = {
    items: {
      readAsync: async (id: string) => {
        asked = id;
        return records(URL);
      },
    },
  };
  assert.deepEqual(await serve(named, 'c'), { picture: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.equal(asked, 'c');
  // a list that does not contain it stays gone, and a missing chat id is read as an empty one
  await assert.rejects(serve({ items: { readAsync: async () => records(BARE.replace(ID, 'f'.repeat(64))) } }, 'c-4'), notHere);
  // a missing chat id is read as the empty id, never as another chat's: the machine holds nothing sent to it
  const unnamed: any = await hostPictureHandler(() => ({ ...w.live, acpHost: named }), machines)(undefined, URL);
  assert.equal(asked, '');
  assert.equal('picture' in unnamed, false);
});

test('a stopped machine whose connect never settles, or whose read hangs, answers within a deadline instead of staying a placeholder', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const never = () => new Promise<never>(() => {});
  // connect() of a stopped Host waits for the tunnel for ever: after the connect deadline the machine is offline
  const stopped = world(t, { state: 'offline' });
  stopped.host.connect = never;
  const first = ask(stopped);
  await new Promise((r) => setImmediate(r));
  mock.timers.tick(8000);
  assert.deepEqual(await first, { offline: 'Studio' });
  assert.deepEqual(stopped.calls, []);
  // online, but one chunk never arrives: a second try may work, so not "offline"
  const slow = world(t);
  slow.host.call = never;
  const second = ask(slow);
  await new Promise((r) => setImmediate(r));
  mock.timers.tick(10000);
  assert.deepEqual(await second, { retry: 'Studio' });
  // the machine went away while the chunk was read: offline
  const lost = world(t);
  lost.host.call = () => {
    lost.host.state = () => 'offline';
    return never();
  };
  const third = ask(lost);
  await new Promise((r) => setImmediate(r));
  mock.timers.tick(10000);
  assert.deepEqual(await third, { offline: 'Studio' });
});
