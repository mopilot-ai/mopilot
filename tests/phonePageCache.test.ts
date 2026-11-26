// The sealed older rows of a chat (mobile/src/remote/pageCache.ts, #5379): bounded by bytes, rows, chats and age; bound to the account, computer and chat they were saved under; a removal beats a save in flight; and what cannot be opened is no cache, never an empty chat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  PAGE_BYTES,
  PAGE_CHATS,
  PAGE_MAX_AGE_MS,
  PAGE_MAX_AGE_NO_EPOCH_MS,
  PAGE_ROW_BYTES,
  boundPages,
  createPageCache,
  withPages,
} from '../mobile/src/remote/pageCache.ts';

function world() {
  const rows = new Map<string, string>();
  const order: string[] = [];
  const touch = (k: string) => (order.includes(k) && order.splice(order.indexOf(k), 1), order.push(k));
  const gate: { hold?: Promise<void> } = {};
  const clock = { now: 1_000_000 };
  const keychain = { fails: false };
  const store = {
    read: async (k: string) => rows.get(k) ?? null,
    write: async (k: string, v: string) => (gate.hold && (await gate.hold), rows.set(k, v), touch(k), undefined),
    remove: async (k: string) => (rows.delete(k), order.includes(k) && order.splice(order.indexOf(k), 1), undefined),
    keys: async () => [...order],
    clear: async () => (rows.clear(), (order.length = 0), undefined),
  };
  // the "box" is the plain text with its aad in front, so a copy opened under another key fails as a real tag would
  const crypto = {
    key: async () => {
      if (keychain.fails) throw new Error('keychain did not answer');
      return new Uint8Array(32);
    },
    randomBytes: (n: number) => new Uint8Array(n).fill(3),
    seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
      new TextEncoder().encode(`${aad}\u0000${new TextDecoder().decode(plain)}`),
    open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
      const text = new TextDecoder().decode(box);
      return text.startsWith(`${aad}\u0000`) ? new TextEncoder().encode(text.slice(aad.length + 1)) : null;
    },
  };
  return { rows, gate, clock, keychain, order, cache: createPageCache({ store, crypto, now: () => clock.now }) };
}
const id = (n: number) => `r${String(n).padStart(5, '0')}`;
const some = (from: number, n: number, text = 'hello') =>
  Array.from({ length: n }, (_, i) => ({ id: id(from + i), role: 'user', text: `${text} ${from + i}` }));
const K = JSON.stringify(['acct', 'mac1', 'chat1']);

test('saved rows come back as they were, with whether the chat goes back further', async () => {
  const { cache } = world();
  assert.equal(await cache.load(K), null);
  assert.equal(await cache.save(K, { rows: some(0, 5), more: true }), true);
  assert.deepEqual(await cache.load(K), { rows: some(0, 5), more: true, at: 1_000_000 });
  await cache.save(K, { rows: some(3, 5), more: false });
  assert.deepEqual(await cache.load(K), { rows: some(3, 5), more: false, at: 1_000_000 }, 'a later save replaces it');
});

test('a chat with nothing to keep keeps nothing, and an old save of it goes', async () => {
  const { cache, rows } = world();
  await cache.save(K, { rows: some(0, 3), more: true });
  assert.equal(rows.size, 1);
  assert.equal(await cache.save(K, { rows: [], more: true }), false);
  assert.equal(rows.size, 0);
  assert.equal(await cache.save(K, { rows: [{ role: 'user', text: 'no id' }], more: true }), false, 'nothing to ask the page before from');
});

test('what is kept is the newest contiguous run: under the byte bound, none over the row bound, starting at a row with an id', () => {
  assert.deepEqual(boundPages(some(0, 3)), some(0, 3));
  // the newest rows that fit PAGE_BYTES
  const big = some(0, 400, 'x'.repeat(1500));
  const kept = boundPages(big);
  assert.ok(kept.length > 100 && kept.length < 400);
  assert.deepEqual(kept, big.slice(-kept.length), 'the newest rows, none from the middle');
  assert.ok(JSON.stringify(kept).length <= PAGE_BYTES + kept.length);
  // a row over the bound ends the run: rows older than it are not kept (no hole), and it is not cut
  const huge = { id: 'huge', role: 'step', text: 'y'.repeat(PAGE_ROW_BYTES + 1) };
  assert.deepEqual(boundPages([...some(0, 2), huge, ...some(10, 2)]), some(10, 2));
  // a run that starts with a row that names nothing starts at the first row that does
  assert.deepEqual(boundPages([{ role: 'step', text: 'no id' }, ...some(5, 2)]), some(5, 2));
  assert.deepEqual(boundPages([{ role: 'step', text: 'no id' }]), []);
  assert.deepEqual(boundPages([]), []);
});

test('a saved copy opens only under the key it was saved under: another account, computer or chat sees nothing', async () => {
  const { cache, rows } = world();
  await cache.save(K, { rows: some(0, 3), more: true });
  const other = JSON.stringify(['acct', 'mac2', 'chat1']);
  rows.set(other, rows.get(K)!);
  assert.equal(await cache.load(other), null, 'moved to another computer');
  rows.set(JSON.stringify(['acct2', 'mac1', 'chat1']), rows.get(K)!);
  assert.equal(await cache.load(JSON.stringify(['acct2', 'mac1', 'chat1'])), null, 'moved to another account');
  assert.notEqual(await cache.load(K), null, 'the original still opens');
});

test('two computers keep their own copy of a chat with the same id', async () => {
  const { cache } = world();
  const a = JSON.stringify(['acct', 'mac1', 'same']);
  const b = JSON.stringify(['acct', 'mac2', 'same']);
  await cache.save(a, { rows: some(0, 2, 'one'), more: true });
  await cache.save(b, { rows: some(0, 2, 'two'), more: false });
  assert.equal((await cache.load(a))!.rows[0].text, 'one 0');
  assert.equal((await cache.load(b))!.rows[0].text, 'two 0');
  await cache.prune((key) => (JSON.parse(key) as string[])[1] !== 'mac1');
  assert.equal(await cache.load(a), null, 'the unpaired computer goes');
  assert.notEqual(await cache.load(b), null, 'the other stays');
});

test('a copy is used for as long as it was last known to be right: a day short of its limit it opens, past it it is gone, and gone from the disk', async () => {
  const { cache, rows, clock } = world();
  await cache.save(K, { rows: some(0, 3), more: true, epoch: 'e1' });
  clock.now += PAGE_MAX_AGE_MS - 1;
  assert.notEqual(await cache.load(K), null, "with the Mac's epoch: a day short of the 14");
  clock.now += 2;
  assert.equal(await cache.load(K), null, 'older than the limit');
  assert.equal(rows.size, 0, 'removed from the disk, not only from sight');
  // no epoch to vouch for it: a much shorter life
  clock.now = 1_000_000;
  await cache.save(K, { rows: some(0, 3), more: true });
  clock.now += PAGE_MAX_AGE_NO_EPOCH_MS - 1;
  assert.notEqual(await cache.load(K), null);
  clock.now += 2;
  assert.equal(await cache.load(K), null, 'a copy with no epoch is used for less time');
  assert.equal(rows.size, 0);
  // saved again with the time it was last verified, not the time of the save
  clock.now = 1_000_000 + PAGE_MAX_AGE_NO_EPOCH_MS;
  await cache.save(K, { rows: some(0, 3), more: true, at: 1_000_000 });
  assert.equal((await cache.load(K))!.at, 1_000_000, 'saving does not make old rows new');
  clock.now += 10;
  assert.equal(await cache.load(K), null, 'and it ages from that time');
});

test('what cannot be used is no cache: a key that does not answer, a damaged or foreign body', async () => {
  const { cache, rows, clock, keychain } = world();
  await cache.save(K, { rows: some(0, 3), more: true });
  keychain.fails = true;
  assert.equal(await cache.load(K), null, 'the keychain did not answer: no cache');
  await assert.rejects(cache.save(K, { rows: some(0, 3), more: true }), /keychain/, 'and nothing is written from it');
  keychain.fails = false;
  assert.notEqual(await cache.load(K), null, 'the saved copy was not touched by either');
  const seal = (body: unknown) =>
    JSON.stringify({ nonce: '00', box: Buffer.from(`chat-pages:${K}\u0000${JSON.stringify(body)}`).toString('hex') });
  const now = clock.now;
  const bad: unknown[] = [
    null,
    { v: 2, rows: some(0, 1), more: true, at: now },
    { v: 1, rows: 'x', more: true, at: now },
    { v: 1, rows: some(0, 1), more: 'yes', at: now },
    { v: 1, rows: some(0, 1), more: true },
    { v: 1, rows: [], more: true, at: now },
    { v: 1, rows: [null], more: true, at: now },
    { v: 1, rows: [{ role: 'user', text: 'no id' }], more: true, at: now },
  ];
  for (const body of bad) {
    rows.set(K, seal(body));
    assert.equal(await cache.load(K), null, JSON.stringify(body));
  }
  rows.set(K, 'not json');
  assert.equal(await cache.load(K), null, 'a damaged copy');
});

test('the oldest chats go past the bound', async () => {
  const { cache, order } = world();
  for (let i = 0; i < PAGE_CHATS + 3; i++) await cache.save(`c${i}`, { rows: some(0, 2), more: true });
  assert.equal(order.length, PAGE_CHATS);
  assert.equal(await cache.load('c0'), null);
  assert.equal(await cache.load('c2'), null);
  assert.notEqual(await cache.load('c3'), null);
  assert.notEqual(await cache.load(`c${PAGE_CHATS + 2}`), null);
});

test('a removal, a prune or a clear beats a save that was on its way, and removes what was kept', async () => {
  const { cache, gate, rows } = world();
  let release!: () => void;
  gate.hold = new Promise((resolve) => (release = resolve));
  const slow = cache.save(K, { rows: some(0, 3), more: true });
  await cache.remove(K);
  release();
  assert.equal(await slow, false, 'the chat was gone from the computer while it was written');
  assert.equal(rows.size, 0);
  gate.hold = undefined;
  await cache.save('a', { rows: some(0, 2), more: true });
  await cache.save('b', { rows: some(0, 2), more: true });
  await cache.prune((key) => key === 'a');
  assert.equal(rows.size, 1);
  gate.hold = new Promise((resolve) => (release = resolve));
  const later = cache.save('b', { rows: some(0, 2), more: true });
  await cache.clear();
  release();
  assert.equal(await later, false, 'signed out while it was written');
  assert.equal(rows.size, 0);
});

test('writes to one chat go one after another, and saving the same chat twice keeps the later one', async () => {
  const { cache } = world();
  await Promise.all([cache.save(K, { rows: some(0, 2, 'first'), more: true }), cache.save(K, { rows: some(0, 2, 'second'), more: true })]);
  assert.equal((await cache.load(K))!.rows[0].text, 'second 0');
});

test('the rows and the pages go together: one remove, prune or clear reaches both', async () => {
  const calls: string[] = [];
  const rows: any = {
    remove: async (k: string) => void calls.push(`rows.remove ${k}`),
    prune: async () => void calls.push('rows.prune'),
    clear: async () => void calls.push('rows.clear'),
  };
  const pages: any = {
    remove: async (k: string) => void calls.push(`pages.remove ${k}`),
    prune: async () => void calls.push('pages.prune'),
    clear: async () => void calls.push('pages.clear'),
  };
  const both = withPages(rows, pages);
  assert.equal(both.pages, pages);
  await both.remove('k');
  await both.prune(() => true);
  await both.clear();
  assert.deepEqual(calls.sort(), ['pages.clear', 'pages.prune', 'pages.remove k', 'rows.clear', 'rows.prune', 'rows.remove k']);
});

// the real XChaCha20-Poly1305 the Mac uses (sodium-native); the phone seals with the same construction through react-native-libsodium
const { createSodiumPrimitives } = createRequire(import.meta.url)('../electron/platform/sodiumPrimitives.cjs');

test('what reaches the store is ciphertext: no message text, no row id, and a changed byte or another key does not open', async () => {
  const sodium = createSodiumPrimitives();
  const secret = sodium.randomBytes(32);
  const kept = new Map<string, string>();
  const order: string[] = [];
  const store = {
    read: async (k: string) => kept.get(k) ?? null,
    write: async (k: string, v: string) => (kept.set(k, v), order.push(k), undefined),
    remove: async (k: string) => (kept.delete(k), undefined),
    keys: async () => order,
    clear: async () => (kept.clear(), undefined),
  };
  const crypto = {
    key: async () => secret,
    randomBytes: sodium.randomBytes,
    seal: (k: Uint8Array, n: Uint8Array, plain: Uint8Array, aad: string) => sodium.aeadSeal(k, n, plain, new TextEncoder().encode(aad)),
    open: (k: Uint8Array, n: Uint8Array, box: Uint8Array, aad: string) => sodium.aeadOpen(k, n, box, new TextEncoder().encode(aad)),
  };
  const cache = createPageCache({ store, crypto });
  const text = 'the launch code is hunter2 and the plan is private';
  await cache.save(K, { rows: [{ id: 'row-visible-id-1', role: 'user', text }, ...some(5, 3)], more: true });
  const stored = kept.get(K)!;
  assert.ok(stored.length > 100);
  for (const plain of [text, 'hunter2', 'row-visible-id-1', 'role', 'user', 'text']) {
    assert.equal(stored.includes(plain), false, `${plain} is not in the file`);
  }
  assert.deepEqual((await cache.load(K))!.rows[0].text, text, 'it opens with the key');
  // one changed byte of the box fails the tag
  const parsed = JSON.parse(stored) as { nonce: string; box: string };
  const flipped = `${parsed.box.slice(0, 10)}${parsed.box[10] === '0' ? '1' : '0'}${parsed.box.slice(11)}`;
  kept.set(K, JSON.stringify({ ...parsed, box: flipped }));
  assert.equal(await cache.load(K), null, 'a changed byte');
  // another phone's key (a backup restored elsewhere has none of this phone's keychain)
  kept.set(K, stored);
  const elsewhere = createPageCache({ store, crypto: { ...crypto, key: async () => sodium.randomBytes(32) } });
  assert.equal(await elsewhere.load(K), null, 'the key of another device');
});

test('rows left out for the bounds say the chat goes back further, also when the copy was of a whole chat', async () => {
  const { cache } = world();
  await cache.save(K, { rows: some(0, 400, 'x'.repeat(1500)), more: false });
  const trimmed = (await cache.load(K))!;
  assert.ok(trimmed.rows.length < 400);
  assert.equal(trimmed.more, true, 'the rows above the kept ones were left out: the top of the copy is not the start of the chat');
  await cache.save(K, {
    rows: [...some(0, 2), { id: 'huge', role: 'step', text: 'y'.repeat(PAGE_ROW_BYTES + 1) }, ...some(10, 2)],
    more: false,
  });
  assert.equal((await cache.load(K))!.more, true, 'a row over the bound ended the run');
  await cache.save(K, { rows: [{ role: 'step', text: 'no id' }, ...some(5, 2)], more: false });
  assert.equal((await cache.load(K))!.more, true, 'a leading row that names nothing was left out');
  await cache.save(K, { rows: some(0, 3), more: false });
  assert.equal((await cache.load(K))!.more, false, 'nothing left out: the copy starts where the chat does');
});

test('a save after a removal that the screen did not see is refused, so leaving a chat after sign-out writes nothing', async () => {
  const { cache, rows } = world();
  const opened = cache.generation(K);
  await cache.clear();
  assert.equal(await cache.save(K, { rows: some(0, 3), more: true }, opened), false, 'the generation it saw is gone');
  assert.equal(rows.size, 0);
  assert.equal(await cache.save(K, { rows: some(0, 3), more: true }, cache.generation(K)), true, 'one taken after is fine');
});

test('a chat list read again prunes nothing for the open chat, and the open chat still saves; the chat removed, or pruned away, does not', async () => {
  const { cache, rows } = world();
  await cache.save(K, { rows: some(0, 2), more: true });
  const opened = cache.generation(K);
  // the list is read again, and every chat in it is kept: nothing is removed
  await cache.prune(() => true);
  await cache.prune((key) => key !== 'some-other-chat');
  assert.equal(cache.generation(K), opened, 'nothing was removed for this chat');
  assert.equal(await cache.save(K, { rows: some(0, 3), more: true }, opened), true, 'prune (nothing removed), then save: saved');
  assert.equal((await cache.load(K))!.rows.length, 3);
  // another chat removed, or pruned away, does not stop this one
  await cache.save('other', { rows: some(0, 2), more: true });
  await cache.remove('other');
  await cache.save('third', { rows: some(0, 2), more: true });
  await cache.prune((key) => key !== 'third');
  assert.equal(await cache.save(K, { rows: some(0, 4), more: true }, opened), true);
  // this chat pruned away (the computer no longer lists it) or removed: a save that began before is refused
  await cache.prune((key) => key !== K);
  assert.equal(rows.has(K), false);
  assert.equal(await cache.save(K, { rows: some(0, 4), more: true }, opened), false, 'pruned away');
  const again = cache.generation(K);
  await cache.save(K, { rows: some(0, 4), more: true }, again);
  await cache.remove(K);
  assert.equal(await cache.save(K, { rows: some(0, 4), more: true }, again), false, 'removed');
});
