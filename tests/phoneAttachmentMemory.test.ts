// A chat's attachments survive its screen being rebuilt for a new connection, an upload cut off by the drop carries on by itself (as does a chunk the connection lost), and an attach while the Mac is away shows a failed tile once the waits are over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted, fakeMedia, chunkReply } from './support/phone/m3';

import { fakeDraft } from './support/phone/drafts';
const hookPath = '../mobile/src/remote/useAttachments';
const memoryPath = '../mobile/src/remote/attachmentMemory';
const clientPath = '../mobile/src/remote/client';
const threadPath = '../mobile/src/screens/Thread';
const { useAttachments, uploadRetry } = await import(hookPath);
const uploadPath = '../mobile/src/remote/upload';
const { CHUNK, connectionLost, computerAway } = await import(uploadPath);
const { INTERRUPTED } = await import(memoryPath);
const { ownedRequest } = await import(clientPath);
const { Thread } = await import(threadPath);

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
/** A screen that holds attachments under `key`, as a chat does; `api()` is what the screen sees now. */
async function screen(runtime: any, key?: string) {
  let api: any;
  const Probe = () => {
    api = useAttachments(ownedRequest(runtime), key);
    return null;
  };
  const v = await mount(createElement(Probe));
  return { api: () => api, done: v.done };
}
const file = (name: string) => ({ name, mime: 'image/jpeg', base64: 'QUJD' });

test('attachments come back after the screen is rebuilt, with what the Mac confirmed, and later picks do not reuse a key', async () => {
  const { runtime } = scripted(() => undefined);
  const first = await screen(runtime, 'u:p:c1');
  await act(async () => first.api().add(file('a.jpg')));
  await flush();
  assert.equal(first.api().items[0].state, 'done');
  await first.done();

  const again = await screen(runtime, 'u:p:c1');
  assert.deepEqual(
    again.api().items.map((i: any) => [i.file.name, i.state, i.id]),
    [['a.jpg', 'done', '0123456789abcdef']],
  );
  await act(async () => again.api().add(file('b.jpg')));
  await flush();
  const keys = again.api().items.map((i: any) => i.key);
  assert.equal(new Set(keys).size, 2, 'the new file has a key of its own');
  await again.done();

  // another chat has its own
  const other = await screen(runtime, 'u:p:c2');
  assert.deepEqual(other.api().items, []);
  await other.done();
});

test('a removal or a sent message forgets them, and a screen with no key keeps nothing', async () => {
  const { runtime } = scripted(() => undefined);
  const a = await screen(runtime, 'forget');
  await act(async () => a.api().add(file('a.jpg')));
  await flush();
  await act(async () => a.api().add(file('b.jpg')));
  await flush();
  await act(async () => a.api().remove(a.api().items[0].key));
  await a.done();
  const b = await screen(runtime, 'forget');
  assert.deepEqual(
    b.api().items.map((i: any) => i.file.name),
    ['b.jpg'],
  );
  await act(async () => b.api().clear());
  await b.done();
  const c = await screen(runtime, 'forget');
  assert.deepEqual(c.api().items, [], 'a sent message left nothing behind');
  await c.done();

  const loose = await screen(runtime);
  await act(async () => loose.api().add(file('a.jpg')));
  await flush();
  await loose.done();
  const next = await screen(runtime);
  assert.deepEqual(next.api().items, []);
  await next.done();
});

test('an upload cut off by the rebuild for a new connection carries on by itself in the new screen: it never shows failed, and no Retry is needed (#5692 background 20 s)', async () => {
  const { runtime, calls } = scripted((m, p) => (m === 'chat.attach' ? new Promise(() => {}) : undefined));
  const cut = await screen(runtime, 'cut');
  await act(async () => cut.api().add(file('a.jpg')));
  assert.equal(cut.api().items[0].state, 'sending');
  await cut.done();

  const { runtime: back, calls: backCalls } = scripted((m, p) => (m === 'chat.attach' ? chunkReply(p) : undefined));
  const again = await screen(back, 'cut');
  assert.notEqual(again.api().items[0].state, 'failed', 'the new screen does not show it failed');
  await flush();
  assert.deepEqual(
    again.api().items.map((i: any) => [i.state, i.error]),
    [['done', null]],
  );
  assert.equal(calls.filter((c) => c[0] === 'chat.attach').length, 1);
  assert.equal(backCalls.filter((c) => c[0] === 'chat.attach').length, 1, 'sent again on the new connection');
  // a failed upload that was not cut off by a rebuild (the Mac refused it) stays failed with Retry
  const { runtime: refusing } = scripted((m) => {
    if (m === 'chat.attach') throw new Error('That file type is not allowed.');
    return undefined;
  });
  const refused = await screen(refusing, 'refused');
  await act(async () => refused.api().add(file('b.exe')));
  await flush();
  await refused.done();
  const later = await screen(refusing, 'refused');
  assert.deepEqual(
    later.api().items.map((i: any) => i.state),
    ['failed'],
  );
  await later.done();
  // INTERRUPTED stays the word a cut-off upload is kept under
  assert.match(INTERRUPTED, /connection dropped/);
});

test('a chunk the connection lost is sent again by itself after a wait, from the part the Mac confirmed, on the newest connection; only when the waits run out is Retry shown', async () => {
  const waits = uploadRetry.waits;
  uploadRetry.waits = [5, 5];
  try {
    let lose = 1;
    const { runtime, calls } = scripted((m, p) => {
      if (m !== 'chat.attach') return undefined;
      // the second chunk goes as the socket is replaced
      if (p.index === 1 && lose-- > 0) throw new Error('relay disconnected');
      return chunkReply(p);
    });
    const s = await screen(runtime, 'lost');
    const big = { name: 'v.mp4', mime: 'video/mp4', base64: 'A'.repeat(CHUNK * 2 + 4) };
    await act(async () => s.api().add(big));
    await flush();
    assert.equal(s.api().items[0].state, 'sending', 'waiting to send it again, not failed');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    await flush();
    assert.equal(s.api().items[0].state, 'done');
    const attaches = calls.filter((c) => c[0] === 'chat.attach').map((c) => c[1]);
    assert.deepEqual(
      attaches.map((c) => c.index),
      [0, 1, 1, 2],
      'from the part the Mac confirmed',
    );
    assert.equal(new Set(attaches.map((c) => c.stream)).size, 1, 'the same stream: a lost connection is not a forgotten stream');
    await s.done();

    // a connection that stays away: after the waits, Retry
    const { runtime: away } = scripted((m) => {
      if (m === 'chat.attach') throw new Error('relay acknowledgement timed out');
      return undefined;
    });
    const gone = await screen(away, 'away');
    await act(async () => gone.api().add(file('c.jpg')));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    await flush();
    assert.equal(gone.api().items[0].state, 'failed');
    await gone.done();

    // a Cancel during a wait cancels it
    uploadRetry.waits = [10_000];
    const held = await screen(away, 'held');
    await act(async () => held.api().add(file('d.jpg')));
    await flush();
    assert.equal(held.api().items[0].state, 'sending');
    await act(async () => held.api().cancel(held.api().items[0].key));
    await flush();
    assert.equal(held.api().items[0].state, 'cancelled');
    await held.done();
  } finally {
    uploadRetry.waits = waits;
  }
});

test('what counts as a lost connection: a request lost in flight or made on a connection since replaced; a computer that is away is its own case; a refusal is neither', () => {
  const said = (message: string, cause?: unknown) => new Error(message, cause ? { cause } : undefined);
  assert.equal(connectionLost(said('relay disconnected')), true);
  assert.equal(connectionLost(said('The connected computer changed. Try again.')), true);
  assert.equal(connectionLost(said('Couldn’t reach it', said('wrapped', said('Request timed out')))), true);
  assert.equal(connectionLost(said('Your computer is offline or asleep. Wake it and try again.', said('Computer is offline'))), false);
  assert.equal(computerAway(said('Your computer is offline or asleep. Wake it and try again.', said('Computer is offline'))), true);
  assert.equal(computerAway(said('relay disconnected')), false);
  assert.equal(connectionLost(said('That file type is not allowed.')), false);
  assert.equal(connectionLost('relay disconnected'), false, 'not an error at all');
});

test('a fresh pick while the computer is away fails at once and says so; an upload carrying on after a rebuild waits for the computer to be back', async () => {
  const waits = uploadRetry.waits;
  uploadRetry.waits = [5, 5];
  try {
    let away = true;
    const { runtime } = scripted((m, p) => {
      if (m !== 'chat.attach') return undefined;
      if (away) throw new Error('Computer is offline');
      return chunkReply(p);
    });
    const fresh = await screen(runtime, 'fresh-away');
    await act(async () => fresh.api().add(file('e.jpg')));
    await flush();
    assert.deepEqual(
      fresh.api().items.map((i: any) => [i.state, i.error]),
      [['failed', 'Your computer is offline or asleep. Wake it and try again.']],
      'at once, with no waits',
    );
    await fresh.done();

    // cut off by a rebuild, and the computer is not back for the first try of the new screen
    const { runtime: cutting } = scripted((m) => (m === 'chat.attach' ? new Promise(() => {}) : undefined));
    const cut = await screen(cutting, 'cut-away');
    await act(async () => cut.api().add(file('f.jpg')));
    await cut.done();
    const again = await screen(runtime, 'cut-away');
    await flush();
    assert.equal(again.api().items[0].state, 'sending', 'waiting for the computer, not failed');
    away = false;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    await flush();
    assert.equal(again.api().items[0].state, 'done');
    await again.done();
  } finally {
    uploadRetry.waits = waits;
  }
});

const follow = { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] };

test('in a chat, a photo attached while the Mac is away shows a failed tile with Retry and Remove, and it is still there after the screen is rebuilt', async () => {
  const { runtime } = scripted((m) => {
    if (m === 'chat.follow') return follow;
    if (m === 'chat.attach') throw new Error('Your computer is offline or asleep.');
    return undefined;
  });
  const chat = () =>
    createElement(Thread, {
      runtime,
      chatId: 'c',
      historyKey: 'u:p:c',
      back: () => {},
      drafts: fakeDraft(''),
      media: fakeMedia().media,
    });
  const v = await mount(chat());
  await click('Add to session');
  await click('Photos');
  assert.ok(document.querySelector('[aria-label="photo.jpg, failed: Your computer is offline or asleep."]'));
  assert.ok(document.querySelector('button[aria-label="Retry upload of photo.jpg"]'));
  assert.ok(document.querySelector('button[aria-label="Remove photo.jpg"]'));
  await v.done();

  // the connection changed: the chat is built again, and the tile is still there
  const rebuilt = await mount(chat());
  assert.ok(document.querySelector('[aria-label^="photo.jpg, failed"]'));
  await click('Remove photo.jpg');
  assert.equal(document.querySelector('[aria-label^="photo.jpg"]'), null);
  await rebuilt.done();
});

test('a rebuilt screen carries a cut-off upload on along the same stream from the part the Mac confirmed: nothing already sent goes again', async () => {
  // the first screen: part 0 confirmed, part 1 on the wire when the connection is replaced
  const { runtime, calls } = scripted((m, p) => (m !== 'chat.attach' ? undefined : p.index === 1 ? new Promise(() => {}) : chunkReply(p)));
  const cut = await screen(runtime, 'stream');
  const big = { name: 'v.mp4', mime: 'video/mp4', base64: 'A'.repeat(CHUNK * 2 + 4) };
  await act(async () => cut.api().add(big));
  await flush();
  await cut.done();
  const first = calls.filter((c) => c[0] === 'chat.attach').map((c) => c[1]);
  assert.deepEqual(
    first.map((c) => c.index),
    [0, 1],
  );

  const { runtime: back, calls: backCalls } = scripted((m, p) => (m === 'chat.attach' ? chunkReply(p) : undefined));
  const again = await screen(back, 'stream');
  await flush();
  assert.equal(again.api().items[0].state, 'done');
  const resent = backCalls.filter((c) => c[0] === 'chat.attach').map((c) => c[1]);
  assert.deepEqual(
    resent.map((c) => c.index),
    [1, 2],
    'from the first part the Mac had not confirmed',
  );
  assert.deepEqual(
    resent.map((c) => c.stream),
    [first[0].stream, first[0].stream],
    'on the same stream',
  );
  // a sent message forgets where the stream stood
  await act(async () => again.api().clear());
  await again.done();
  const after = await screen(back, 'stream');
  assert.deepEqual(after.api().items, []);
  await after.done();
});

test('a screen whose request now names another computer sends it none of the file: the upload fails, saying the computer changed', async () => {
  const waits = uploadRetry.waits;
  uploadRetry.waits = [20];
  try {
    const { runtime, calls } = scripted((m, p) => {
      if (m !== 'chat.attach') return undefined;
      if (p.index === 1) throw new Error('relay disconnected');
      return chunkReply(p);
    });
    const { runtime: other, calls: otherCalls } = scripted((m, p) => (m === 'chat.attach' ? chunkReply(p) : undefined), {
      selectedPair: 'q',
      generation: 1,
      phase: 'online',
    });
    let which = runtime;
    let api: any;
    let rerender: () => Promise<void> = async () => {};
    const Probe = () => {
      api = useAttachments(ownedRequest(which), 'switch');
      return null;
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    rerender = () => act(async () => root.render(createElement(Probe)));
    await rerender();
    await act(async () => api.add({ name: 'v.mp4', mime: 'video/mp4', base64: 'A'.repeat(CHUNK * 2 + 4) }));
    await flush();
    assert.equal(api.items[0].state, 'sending', 'waiting to send the lost part again');
    which = other;
    await rerender();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    await flush();
    assert.deepEqual([api.items[0].state, api.items[0].error], ['failed', 'The connected computer changed. Try again.']);
    assert.equal(otherCalls.filter((c) => c[0] === 'chat.attach').length, 0, 'the other computer got none of it');
    assert.equal(calls.filter((c) => c[0] === 'chat.attach').length, 2);
    await act(async () => root.unmount());
    host.remove();
  } finally {
    uploadRetry.waits = waits;
  }
});

test('a request names the computer it is bound to', () => {
  const { runtime } = scripted(() => undefined, { selectedPair: 'p7', generation: 3, phase: 'online' });
  assert.equal(ownedRequest(runtime).pair, 'p7');
});
