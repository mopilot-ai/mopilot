// What the phone-composed home keeps sealed between runs: kept and read back, only for its own account, never written over when it cannot be read, a failed write reported while the home goes on, and gone after Forget.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const memPath = '../mobile/src/momoPhone/phoneHome/memory';
const { openPhoneHomeMemory, INVITED_MS } = await import(memPath);

const key = new Uint8Array(32).fill(7);
const crypto = {
  key: async () => key,
  randomBytes: (n: number) => new Uint8Array(n).fill(3),
  // a stand-in for the sealed box: reversible, and bound to the aad it was sealed with
  seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
    Uint8Array.from([...new TextEncoder().encode(`${aad}|`), ...plain]),
  open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
    const text = new TextDecoder().decode(box);
    return text.startsWith(`${aad}|`) ? box.slice(aad.length + 1) : null;
  },
};
const store = (initial: string | null = null) => {
  const s = { value: initial, writes: 0, fail: false, clears: 0 };
  return Object.assign(s, {
    read: async () => s.value,
    write: async (v: string) => {
      if (s.fail) throw new Error('disk');
      s.value = v;
      s.writes++;
    },
    clear: async () => {
      s.value = null;
      s.clears++;
    },
  });
};
const note = { machineId: 'm1', name: 'Mini', homeId: 'home-abcdef12', leaseEpoch: 4 };

test('what is kept is read back by the same account, after a restart', async () => {
  const s = store();
  const a = await openPhoneHomeMemory({ store: s, crypto, user: 'u1' });
  assert.deepEqual([a.seen.read(), a.kept.read(), a.memory.read(), a.outbox.read(), a.sent.read()], [0, [], null, [], []]);
  a.seen.write(9);
  a.kept.write(['m1:h:1']);
  a.memory.write(note);
  a.outbox.write([{ turnId: 't1', chatId: '', text: 'hi', createdAt: 1, delivery: 'not-sent' }]);
  a.sent.write([{ id: 't0', text: 'old', at: 1 }]);
  a.invited.set(true);
  await a.settled();
  const b = await openPhoneHomeMemory({ store: s, crypto, user: 'u1' });
  assert.equal(b.seen.read(), 9);
  assert.deepEqual(b.kept.read(), ['m1:h:1']);
  assert.deepEqual(b.memory.read(), note);
  assert.equal(b.outbox.read()[0].text, 'hi');
  assert.deepEqual(b.sent.read(), [{ id: 't0', text: 'old', at: 1 }]);
  assert.equal(b.invited.read(), true);
  // a read is a copy: changing it keeps nothing
  b.kept.read().push('x');
  assert.deepEqual(b.kept.read(), ['m1:h:1']);
});

test('another account does not read what was kept, and a field that is not what it should be is as if never kept', async () => {
  const s = store();
  const a = await openPhoneHomeMemory({ store: s, crypto, user: 'u1' });
  a.seen.write(5);
  await a.settled();
  assert.equal((await openPhoneHomeMemory({ store: s, crypto, user: 'u2' })).seen.read(), 0);
  const plain = JSON.stringify({ seen: -1, kept: [1, 'ok'], home: { homeId: 5 }, outbox: [null, { turnId: 't', text: 'x' }], sent: 'no' });
  const row = JSON.stringify({
    user: 'u3',
    nonce: '03',
    box: Buffer.from(crypto.seal(key, key, new TextEncoder().encode(plain), 'momo-phone-home:u3')).toString('hex'),
  });
  const c = await openPhoneHomeMemory({ store: store(row), crypto, user: 'u3' });
  assert.deepEqual(
    [c.seen.read(), c.kept.read(), c.memory.read(), c.outbox.read().length, c.sent.read(), c.invited.read()],
    [0, ['ok'], null, 1, [], false],
  );
});

test('something kept that cannot be read is never written over', async () => {
  for (const initial of ['not json', JSON.stringify({ user: 'u1', nonce: '03', box: '00' })]) {
    const s = store(initial);
    const a = await openPhoneHomeMemory({ store: s, crypto, user: 'u1' });
    assert.equal(a.unreadable, true);
    a.seen.write(3);
    await a.settled();
    assert.equal(a.seen.read(), 3);
    assert.equal(s.writes, 0);
    assert.equal(s.value, initial);
  }
  const broken = {
    read: async () => {
      throw new Error('keychain');
    },
    write: async () => undefined,
    clear: async () => undefined,
  };
  assert.equal((await openPhoneHomeMemory({ store: broken, crypto, user: 'u1' })).unreadable, true);
});

test('a write that fails is reported and the home goes on with what it holds', async () => {
  const s = store();
  const failures: unknown[] = [];
  const a = await openPhoneHomeMemory({ store: s, crypto, user: 'u1', report: (e: unknown) => failures.push(e) });
  s.fail = true;
  a.seen.write(2);
  await a.settled();
  assert.equal(a.seen.read(), 2);
  assert.equal(failures.length, 1);
  s.fail = false;
  a.seen.write(3);
  await a.settled();
  assert.equal(s.writes, 1);
  // with no one to tell, a failed write is still not an error
  const quiet = await openPhoneHomeMemory({ store: s, crypto, user: 'u1' });
  s.fail = true;
  quiet.seen.write(4);
  await quiet.settled();
});

test('Forget takes everything away, and a row that could not be read is started afresh', async () => {
  const s = store('not json');
  const a = await openPhoneHomeMemory({ store: s, crypto, user: 'u1' });
  a.seen.write(8);
  await a.forget();
  assert.equal(a.seen.read(), 0);
  assert.equal(s.clears, 1);
  assert.equal(s.value, null);
  a.seen.write(1);
  await a.settled();
  assert.equal(s.writes, 1);
});

test('a row that opens to something that is not a record is as if nothing was kept', async () => {
  const row = (plain: string) =>
    JSON.stringify({
      user: 'u1',
      nonce: '03',
      box: Buffer.from(crypto.seal(key, key, new TextEncoder().encode(plain), 'momo-phone-home:u1')).toString('hex'),
    });
  for (const plain of ['null', '5', '"text"']) {
    const a = await openPhoneHomeMemory({ store: store(row(plain)), crypto, user: 'u1' });
    assert.deepEqual([a.unreadable, a.seen.read(), a.kept.read(), a.invited.read()], [false, 0, [], false]);
  }
});

test('the hint that a Mac allowed the account lasts as long as a grant, is renewed by a Mac at most once an hour, and a no takes it away', async () => {
  let at = 1_000_000;
  const s = store();
  const a = await openPhoneHomeMemory({ store: s, crypto, user: 'u1', now: () => at });
  assert.equal(a.invited.read(), false);
  // a no with nothing kept keeps nothing
  a.invited.set(false);
  await a.settled();
  assert.equal(s.writes, 0);
  a.invited.set(true);
  await a.settled();
  assert.equal(s.writes, 1);
  // said again within the hour: nothing is written; later it is renewed
  at += 60_000;
  a.invited.set(true);
  await a.settled();
  assert.equal(s.writes, 1);
  at += 3_600_000;
  a.invited.set(true);
  await a.settled();
  assert.equal(s.writes, 2);
  // it lapses with the grant
  assert.equal(a.invited.read(), true);
  at += INVITED_MS;
  assert.equal(a.invited.read(), false);
  a.invited.set(true);
  assert.equal(a.invited.read(), true);
  // a Mac that says no takes it away
  a.invited.set(false);
  await a.settled();
  assert.equal(a.invited.read(), false);
  assert.equal((await openPhoneHomeMemory({ store: s, crypto, user: 'u1', now: () => at })).invited.read(), false);
});

test('what a Mac says of the home is learned: the real home id with it, the lease never goes down, a newer note replaces and an older one never does, and nothing known reads as unknown', async () => {
  const s0 = store();
  const a = await openPhoneHomeMemory({ store: s0, crypto, user: 'u1' });
  assert.equal(a.known(), false);
  a.learn({ machineId: 'mac', homeId: 'home-mac-0001', name: 'Studio', leaseEpoch: 4 });
  assert.equal(a.known(), true);
  assert.deepEqual(
    [a.seen.read(), a.memory.read()?.machineId, a.memory.read()?.leaseEpoch, a.memory.read()?.homeId],
    [4, 'mac', 4, 'home-mac-0001'],
  );
  // an older answer changes nothing
  a.learn({ machineId: 'other', homeId: 'home-old-0001', name: 'Old', leaseEpoch: 2 });
  assert.deepEqual([a.seen.read(), a.memory.read()?.homeId], [4, 'home-mac-0001']);
  // the same lease from another home does not replace a note that names its home
  a.learn({ machineId: 'mini', homeId: 'home-mini-0001', name: 'Mini', leaseEpoch: 4 });
  assert.equal(a.memory.read()?.homeId, 'home-mac-0001');
  // a note that does not name its home yet (kept by an earlier build) is made whole at the same lease
  a.memory.write({ machineId: null, homeId: '', leaseEpoch: 4, name: 'Studio', lineage: [] });
  a.learn({ machineId: 'mac', homeId: 'home-mac-0001', name: 'Studio', leaseEpoch: 4 });
  assert.deepEqual([a.memory.read()?.machineId, a.memory.read()?.homeId], ['mac', 'home-mac-0001']);
  // a higher lease replaces it and raises the lease seen; a machine the view does not name stays unnamed
  a.learn({ machineId: null, homeId: 'home-new-0001', name: 'Studio', leaseEpoch: 9 });
  assert.deepEqual([a.seen.read(), a.memory.read()?.machineId, a.memory.read()?.homeId], [9, null, 'home-new-0001']);
  // a note whose machine is not known is kept and read back, never forgotten
  await a.settled();
  const again = await openPhoneHomeMemory({ store: s0, crypto, user: 'u1' });
  assert.deepEqual([again.memory.read()?.machineId, again.memory.read()?.homeId], [null, 'home-new-0001']);
  // a phone that only saw a lease (no home) knows something too
  const b = await openPhoneHomeMemory({ store: store(), crypto, user: 'u1' });
  b.seen.write(3);
  assert.equal(b.known(), true);
});
