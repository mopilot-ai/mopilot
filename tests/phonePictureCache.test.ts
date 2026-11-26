// Attached pictures on the phone (#4820): a thumbnail seen once is kept sealed on the phone for this account and computer, so a chat reopened, a reconnect or a relaunch draws it at once without asking the computer; bounded, thumbnails only, and gone with the account or the computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const cachePath = '../mobile/src/presentation/pictureCache';
const imagePath = '../mobile/src/remote/messageImage';
const leavePath = '../mobile/src/accountLeave';
const hookPath = '../mobile/src/remote/useDiskCaches';
const threadPath = '../mobile/src/presentation/threadCache';
const { createPictureCache, pictureKey, PICTURES_KEPT } = await import(cachePath);
const { readMessageImage, forgetMessageImages, bindPictureDisk, THUMB_SIDE, FULL_SIDE } = await import(imagePath);
const { leaveAccount } = await import(leavePath);
const { useDiskCaches } = await import(hookPath);
const { rememberRows, recentRows } = await import(threadPath);

const URI = `data:image/jpeg;base64,${'QUJD'.repeat(20)}`;
function memoryStore() {
  const table = new Map<string, string>();
  return {
    table,
    store: {
      read: async (k: string) => table.get(k) ?? null,
      write: async (k: string, v: string) => {
        table.delete(k);
        table.set(k, v);
      },
      remove: async (k: string) => void table.delete(k),
      keys: async () => [...table.keys()],
      clear: async () => table.clear(),
    },
  };
}
const crypto = {
  key: async () => new Uint8Array(32),
  randomBytes: (n: number) => new Uint8Array(n).fill(7),
  seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
    new Uint8Array([...new TextEncoder().encode(`${aad}|`), ...plain]),
  open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
    const text = new TextDecoder().decode(box);
    return text.startsWith(`${aad}|`) ? box.slice(aad.length + 1) : null;
  },
};
const over = () => {
  const m = memoryStore();
  return { ...m, cache: createPictureCache({ store: m.store, crypto }) };
};

test('a saved picture opens under its own key only, and what is not a picture is not kept', async () => {
  const { cache, table } = over();
  const key = pictureKey('u', 'p', 'c', 'm', 0, 360);
  await cache.save(key, URI);
  assert.equal(await cache.load(key), URI);
  assert.ok(!JSON.stringify([...table.values()]).includes('QUJD'), 'sealed, not plain');
  // moved to another key (another account's) it does not open
  const other = pictureKey('v', 'p', 'c', 'm', 0, 360);
  table.set(other, table.get(key)!);
  assert.equal(await cache.load(other), null);
  assert.equal(await cache.load(pictureKey('u', 'p', 'c', 'zz', 0, 360)), null, 'nothing under it');
  await cache.save(pictureKey('u', 'p', 'c', 'x', 0, 360), 'data:text/html;base64,AAAA');
  await cache.save(pictureKey('u', 'p', 'c', 'y', 0, 360), 'not a picture');
  assert.equal(table.size, 2);
  table.set(key, 'not json');
  assert.equal(await cache.load(key), null, 'a damaged copy is not a picture');
});

test('the newest PICTURES_KEPT stay; a removed computer, a deleted chat and a sign-out take theirs; a save begun before a removal does not write after it', async () => {
  const { cache, table } = over();
  for (let i = 0; i < PICTURES_KEPT + 5; i++) await cache.save(pictureKey('u', 'p', 'c', `m${i}`, 0, 360), URI);
  assert.equal(table.size, PICTURES_KEPT);
  assert.equal(await cache.load(pictureKey('u', 'p', 'c', 'm0', 0, 360)), null, 'the oldest went');
  assert.equal(await cache.load(pictureKey('u', 'p', 'c', `m${PICTURES_KEPT + 4}`, 0, 360)), URI);
  await cache.prune((k: string) => (JSON.parse(k) as string[])[2] !== 'c');
  assert.equal(table.size, 0, 'a chat the computer no longer lists');
  await cache.save(pictureKey('u', 'p1', 'c', 'm', 0, 360), URI);
  await cache.save(pictureKey('u', 'p2', 'c', 'm', 0, 360), URI);
  await cache.prune((k: string) => (JSON.parse(k) as string[])[1] !== 'p1');
  assert.deepEqual(
    [...table.keys()].map((k) => JSON.parse(k)[1]),
    ['p2'],
  );
  // a save in flight when the account signs out
  let release!: () => void;
  const slow = { ...crypto, key: () => new Promise<Uint8Array>((r) => (release = () => r(new Uint8Array(32)))) };
  const mem = memoryStore();
  const guarded = createPictureCache({ store: mem.store, crypto: slow });
  const pending = guarded.save(pictureKey('u', 'p', 'c', 'm', 0, 360), URI);
  await guarded.clear();
  release();
  await pending;
  assert.equal(mem.table.size, 0);
  await cache.clear();
  assert.equal(table.size, 0);
});

/** A computer that answers `messages.image` with a picture and counts the asks. */
function computer(data = 'QUJDRA==') {
  const asked: any[] = [];
  const request = Object.assign(async (_m: string, p: any) => (asked.push(p), { data }), {});
  return { asked, request };
}

test('a thumbnail seen once draws from the phone after a reconnect or a relaunch, without asking the computer', async () => {
  const { cache } = over();
  bindPictureDisk({ cache, account: 'u', pair: 'p' });
  try {
    const first = computer();
    const uri = await readMessageImage(first.request, 'c1', 'm1', 0, THUMB_SIDE);
    assert.equal(uri, 'data:image/jpeg;base64,QUJDRA==');
    await flush();
    assert.equal(first.asked.length, 1);
    // a reconnect makes a new owner of the same account and computer
    const again = computer();
    assert.equal(await readMessageImage(again.request, 'c1', 'm1', 0, THUMB_SIDE), uri);
    assert.equal(again.asked.length, 0, 'from this phone');
    // a relaunch starts with nothing in memory
    forgetMessageImages();
    const relaunched = computer();
    assert.equal(await readMessageImage(relaunched.request, 'c1', 'm1', 0, THUMB_SIDE), uri);
    assert.equal(relaunched.asked.length, 0);
    // another picture, and the same picture at another side, are asked for
    await readMessageImage(relaunched.request, 'c1', 'm1', 1, THUMB_SIDE);
    await readMessageImage(relaunched.request, 'c1', 'm1', 0, FULL_SIDE);
    assert.equal(relaunched.asked.length, 2);
    // the full-screen size is not kept on the phone
    forgetMessageImages();
    const full = computer();
    await readMessageImage(full.request, 'c1', 'm1', 0, FULL_SIDE);
    assert.equal(full.asked.length, 1);
  } finally {
    bindPictureDisk(null);
    forgetMessageImages();
  }
});

test("another account's or computer's copy is not read, no store keeps nothing, and a store that fails is not in the way", async () => {
  const { cache } = over();
  try {
    bindPictureDisk({ cache, account: 'u', pair: 'p' });
    await readMessageImage(computer().request, 'c1', 'm1', 0, THUMB_SIDE);
    await flush();
    forgetMessageImages();
    for (const binding of [
      { cache, account: 'v', pair: 'p' },
      { cache, account: 'u', pair: 'q' },
    ]) {
      bindPictureDisk(binding);
      const c = computer();
      await readMessageImage(c.request, 'c1', 'm1', 0, THUMB_SIDE);
      assert.equal(c.asked.length, 1, JSON.stringify(binding));
      forgetMessageImages();
    }
    bindPictureDisk(null);
    const none = computer();
    await readMessageImage(none.request, 'c1', 'm1', 0, THUMB_SIDE);
    assert.equal(none.asked.length, 1);
    forgetMessageImages();
    const broken = { load: async () => Promise.reject(new Error('disk')), save: async () => Promise.reject(new Error('disk')) };
    bindPictureDisk({ cache: broken as any, account: 'u', pair: 'p' });
    const c = computer();
    assert.equal(await readMessageImage(c.request, 'c1', 'm1', 0, THUMB_SIDE), 'data:image/jpeg;base64,QUJDRA==');
    await flush();
  } finally {
    bindPictureDisk(null);
    forgetMessageImages();
  }
});

test('signing out takes the pictures with it, in memory and on the phone', async () => {
  const { cache, table } = over();
  bindPictureDisk({ cache, account: 'u', pair: 'p' });
  try {
    await readMessageImage(computer().request, 'c1', 'm1', 0, THUMB_SIDE);
    await flush();
    assert.equal(table.size, 1);
    await leaveAccount({ runtime: { signOut: async () => undefined }, pictureCache: cache });
    assert.equal(table.size, 0);
    const c = computer();
    await readMessageImage(c.request, 'c1', 'm1', 0, THUMB_SIDE);
    assert.equal(c.asked.length, 1, 'nothing left in memory either');
  } finally {
    bindPictureDisk(null);
    forgetMessageImages();
  }
});

test('the disk copies follow the account and computer in use, and a chat the computer no longer lists loses its pictures and rows', async () => {
  const pictures = over();
  const rows = { prune: async () => undefined };
  const kept: string[] = [];
  const rowCache = {
    prune: async (keep: (k: string) => boolean) => void kept.push(...['a', 'b', 'c'].filter((c) => keep(JSON.stringify(['u', 'p', c])))),
  };
  await pictures.cache.save(pictureKey('u', 'p', 'a', 'm', 0, 360), URI);
  await pictures.cache.save(pictureKey('u', 'p', 'gone', 'm', 0, 360), URI);
  await pictures.cache.save(pictureKey('other', 'p', 'a', 'm', 0, 360), URI);
  rememberRows(JSON.stringify(['u', 'p', 'gone']), [{ key: 'k', role: 'user', text: 'x' }]);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const Probe = (props: any) => (useDiskCaches(props), null);
  const draw = (props: any) => act(async () => root.render(createElement(Probe, props)));
  try {
    // signed in, but the computer's list is not whole yet: another account's pictures go, nothing else
    await draw({ rowCache: rows, pictureCache: pictures.cache, chats: [{ id: 'a' }], whole: false, account: 'u', pair: 'p' });
    await flush();
    assert.deepEqual([...pictures.table.keys()].map((k) => JSON.parse(k)[0]).sort(), ['u', 'u']);
    // the whole list is read: a chat it no longer has goes, in memory and on the phone
    await draw({ rowCache, pictureCache: pictures.cache, chats: [{ id: 'a' }], whole: true, account: 'u', pair: 'p' });
    await flush();
    assert.deepEqual(
      [...pictures.table.keys()].map((k) => JSON.parse(k)[2]),
      ['a'],
    );
    // binding the account kept this account's three chats (another account's rows went), then the whole list kept the one it still has
    assert.deepEqual(kept, ['a', 'b', 'c', 'a']);
    assert.deepEqual(recentRows(JSON.stringify(['u', 'p', 'gone'])), []);
    // signed out: the disk copy is unbound, and nothing is read from it
    await draw({ rowCache: null, pictureCache: null, chats: null, whole: false, account: undefined, pair: null });
    const c = computer();
    await readMessageImage(c.request, 'a', 'm', 0, THUMB_SIDE);
    assert.equal(c.asked.length, 1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    forgetMessageImages();
  }
});

test('past the memory bound a picture read from the phone makes room, and it still draws', async () => {
  const { cache } = over();
  bindPictureDisk({ cache, account: 'u', pair: 'p' });
  try {
    const c = computer();
    for (let i = 0; i < 52; i++) await readMessageImage(c.request, 'c1', `m${i}`, 0, THUMB_SIDE);
    await flush();
    forgetMessageImages();
    const again = computer();
    for (let i = 0; i < 52; i++) assert.ok(await readMessageImage(again.request, 'c1', `m${i}`, 0, THUMB_SIDE));
    assert.equal(again.asked.length, 0, 'all 52 came from the phone, more than memory holds');
  } finally {
    bindPictureDisk(null);
    forgetMessageImages();
  }
});

test("removing a computer takes its pictures and keeps another computer's; signing out takes every one", async () => {
  const appPath = '../mobile/src/MobileApp';
  const { MobileApp } = await import(appPath);
  const { scripted } = await import('./support/phone/m3');
  const { click, openComputer } = await import('./support/phone/component-kit');
  const paired = { generation: 1, user: { id: 'u', name: 'Dana' }, pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }], error: null };
  for (const how of ['signOut', 'unpair']) {
    const { cache, table } = over();
    await cache.save(pictureKey('u', 'p', 'c', 'm', 0, 360), URI);
    await cache.save(pictureKey('u', 'q', 'c', 'm', 0, 360), URI);
    const s = scripted(() => undefined, { ...paired, phase: 'offline', selectedPair: null });
    s.runtime.start = async () => {};
    s.runtime.signOut = async () => {};
    s.runtime.unpair = async () => {};
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, pictures: Promise.resolve(cache) })));
    await flush();
    await click('Open menu');
    await click('Settings');
    if (how === 'signOut') {
      await click('Sign out');
      await click('Confirm sign out');
      await flush();
      assert.equal(table.size, 0, 'every picture goes with the account');
    } else {
      await openComputer();
      await click('Remove computer');
      await click('Remove');
      await flush();
      assert.deepEqual(
        [...table.keys()].map((k) => JSON.parse(k)[1]),
        ['q'],
        'only the removed computer’s pictures go',
      );
    }
    await act(async () => root.unmount());
    host.remove();
  }
});
