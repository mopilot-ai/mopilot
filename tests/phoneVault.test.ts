// Encrypted phone state persists atomically and refuses stale pairing owners or missing keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhoneVault } from '../shared/remote/phoneVault.mjs';
import { prim } from './support/phonePairingFixture.ts';

function fixture() {
  let row: string | null = null,
    key: string | null = null,
    queue = Promise.resolve();
  const storage = {
    key: {
      get: async () => key,
      set: async (v: string) => {
        key = v;
      },
    },
    transaction: async (fn: any) => {
      const result = queue.then(async () => {
        let next = row;
        const value = await fn({
          read: async () => row,
          write: async (v: string) => {
            next = v;
          },
        });
        row = next;
        return value;
      });
      queue = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
  return {
    vault: createPhoneVault({ prim, ...storage }),
    /** The same stored state opened by a new run of the app (a new vault object). */
    reopen: () => createPhoneVault({ prim, ...storage }),
    raw: () => row,
    loseKey: () => {
      key = null;
    },
  };
}

test('encrypted state owns pending claims and pair commits', async () => {
  const f = fixture(),
    v = f.vault;
  await v.setAccount({ user: { id: 'one' }, deviceId: 'phone_1234' });
  const identity = await v.getIdentity();
  assert.deepEqual(await v.getIdentity(), identity);
  assert.ok(!f.raw()?.includes(identity.phoneId));
  const pending = { owner: 'a', pairId: 'p_test', relay: 'wss://example.com', phase: 'prepared' };
  assert.deepEqual(await Promise.all([v.claimPending(pending), v.claimPending({ ...pending, owner: 'b' })]), [true, false]);
  await assert.rejects(v.markJoining('b'), /stale/);
  await assert.rejects(v.clearRefused('a'), /stale/, 'nothing was refused before the join');
  await assert.rejects(v.clearRefused('b'), /stale/);
  await v.markJoining('a');
  await assert.rejects(v.clearPrepared('a'), /stale/);
  const pair = { pairId: 'p_test', macId: 'mac', tx: {}, rx: {} };
  await v.savePair('a', pair);
  assert.equal(await v.getPending(), null);
  assert.deepEqual(await v.getPair('p_test'), pair);
  const list = await v.pairs();
  list[0].macId = 'changed';
  assert.equal((await v.getPair('p_test')).macId, 'mac');
  await v.setAccount({ user: { id: 'two' }, deviceId: 'phone_5678' });
  assert.deepEqual(await v.pairs(), []);
  f.loseKey();
  await assert.rejects(v.getPending(), /key unavailable/);
});

test('refresh claim is exclusive, survives interruption and commits only its owner', async () => {
  const { vault } = fixture();
  const account = { user: { id: 'one' }, deviceId: 'phone_1234', refreshToken: 'old' };
  await vault.setAccount(account);
  assert.deepEqual(await vault.getAccount(), account);
  await vault.setAccount({ ...account });
  const claim = await vault.claimRefresh('old');
  assert.equal(await vault.claimRefresh('old'), claim);
  await assert.rejects(vault.completeRefresh('other', 'old', { ...account, refreshToken: 'new' }), /account changed/);
  await vault.completeRefresh(claim, 'old', { ...account, refreshToken: 'new' });
  await assert.rejects(vault.claimRefresh('old'), /account changed/);
  assert.ok(await vault.claimRefresh('new'));
  await vault.setAccount(null);
  await vault.setAccount(account);
  assert.ok(await vault.claimRefresh('old'));
});

test('install id is stable, prepared claim clears conditionally, and pair edits are atomic', async () => {
  const { vault } = fixture();
  const id = await vault.getInstallId();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(await vault.getInstallId(), id);
  assert.equal(await vault.getPair('missing'), null);
  assert.equal(await vault.getPair('__proto__'), null);
  await assert.rejects(
    vault.updatePair('__proto__', () => {}),
    /unknown pair/,
  );
  await assert.rejects(vault.getIdentity(), /account required/);
  await assert.rejects(
    vault.updatePair('missing', () => {}),
    /unknown pair/,
  );
  const pending = { owner: 'a', pairId: 'p_test', relay: 'wss://example.com', phase: 'prepared' };
  await vault.claimPending(pending);
  await vault.clearPrepared('a');
  assert.equal(await vault.getPending(), null);
  await vault.claimPending(pending);
  await vault.markJoining('a');
  await assert.rejects(vault.savePair('b', { pairId: 'p_test' }), /stale/);
  await vault.savePair('a', { pairId: 'p_test', n: 1 });
  assert.equal(await vault.updatePair('p_test', (pair: any) => ({ pair: { ...pair, n: 2 }, value: 'ok' })), 'ok');
  assert.equal((await vault.getPair('p_test')).n, 2);
});

test('vault rejects invalid key and tampered or malformed encrypted state', async () => {
  const run = (key: string, row: string) =>
    createPhoneVault({
      prim,
      key: { get: async () => key, set: async () => {} },
      transaction: async (fn: any) => fn({ read: async () => row, write: async () => {} }),
    });
  const { toBase64, utf8 } = await import('../shared/remote/envelope.mjs');
  const key = prim.randomBytes(32),
    nonce = prim.randomBytes(24);
  await assert.rejects(run(toBase64(Uint8Array.of(1)), '{}').getPending(), /invalid phone vault key/);
  await assert.rejects(
    run(toBase64(key), JSON.stringify({ nonce: toBase64(Uint8Array.of(1)), box: '' })).getPending(),
    /invalid phone vault/,
  );
  await assert.rejects(
    run(toBase64(key), JSON.stringify({ nonce: toBase64(nonce), box: toBase64(new Uint8Array(16)) })).getPending(),
    /invalid phone vault/,
  );
  const box = prim.aeadSeal(key, nonce, utf8('{}'), utf8('mopilot-phone-vault-v1'));
  await assert.rejects(
    run(toBase64(key), JSON.stringify({ nonce: toBase64(nonce), box: toBase64(box) })).getPending(),
    /invalid phone vault/,
  );
  await assert.rejects(run(toBase64(key), '{').getPending(), /invalid phone vault/);
  const invalid = prim.aeadSeal(key, nonce, utf8('{'), utf8('mopilot-phone-vault-v1'));
  await assert.rejects(
    run(toBase64(key), JSON.stringify({ nonce: toBase64(nonce), box: toBase64(invalid) })).getPending(),
    /invalid phone vault/,
  );
});

test('cleanup retires the QR permanently and takeover makes old completion stale', async () => {
  const { vault } = fixture();
  assert.equal(await vault.claimCleanup('old', 'p_retired'), null);
  const pending = { owner: 'old', pairId: 'p_retired', relay: 'wss://example.com', phase: 'prepared' };
  await vault.claimPending(pending);
  await assert.rejects(vault.claimCleanup('other', 'p_retired'), /stale/);
  await assert.rejects(vault.claimCleanup('old', 'p_other'), /stale/);
  const first = await vault.claimCleanup('old', 'p_retired');
  await assert.rejects(vault.markJoining('old'), /stale/);
  const second = await vault.claimCleanup('old', 'p_retired');
  await assert.rejects(vault.finishCleanup(first.cleanupClaim), /stale/);
  await vault.finishCleanup(second.cleanupClaim);
  await assert.rejects(vault.claimPending(pending), /retired/);
  await vault.setAccount({ user: { id: 'new' }, deviceId: 'phone_1234' });
  await assert.rejects(vault.claimPending(pending), /retired/);
});

test('retirement cap refuses cleanup without discarding existing claims', async () => {
  const { toBase64, utf8 } = await import('../shared/remote/envelope.mjs');
  const key = prim.randomBytes(32),
    nonce = prim.randomBytes(24);
  const state = {
    identity: null,
    account: null,
    pairs: {},
    pending: { owner: 'a', pairId: 'p_next', relay: 'wss://example.com', phase: 'joining' },
    retiredPairs: Array.from({ length: 1024 }, (_, i) => `p_${i}`),
  };
  const box = prim.aeadSeal(key, nonce, utf8(JSON.stringify(state)), utf8('mopilot-phone-vault-v1'));
  const vault = createPhoneVault({
    prim,
    key: { get: async () => toBase64(key), set: async () => {} },
    transaction: async (fn: any) =>
      fn({
        read: async () => JSON.stringify({ nonce: toBase64(nonce), box: toBase64(box) }),
        write: async () => {
          throw new Error('unexpected write');
        },
      }),
  });
  await assert.rejects(vault.claimCleanup('a', 'p_next'), /storage full/);
});

test('removePair forgets one pair and its ratchet state for good, and says whether it was there', async () => {
  const { vault } = fixture();
  await vault.setAccount({ user: { id: 'u' }, deviceId: 'd', refreshToken: 'r' });
  for (const id of ['p_one', 'p_two']) {
    await vault.claimPending({ owner: id, pairId: id, relay: 'wss://example.com', phase: 'prepared' });
    await vault.markJoining(id);
    await vault.savePair(id, { pairId: id, tx: { ctr: 5, chain: 'k' } });
  }
  assert.equal(await vault.removePair('p_one'), true);
  assert.equal(await vault.getPair('p_one'), null);
  assert.deepEqual(
    (await vault.pairs()).map((p: any) => p.pairId),
    ['p_two'],
  );
  assert.equal(await vault.removePair('p_one'), false);
  assert.equal(await vault.removePair('__proto__'), false);
  assert.equal((await vault.getPair('p_two')).tx.ctr, 5);
});

test('the waiting messages are kept sealed with the vault, leave with their computer, and are not another account’s', async () => {
  const { vault, raw } = fixture();
  await vault.setAccount({ user: { id: 'u' }, deviceId: 'd', refreshToken: 'r' });
  assert.equal(await vault.getOutbox(), null, 'none to begin with');
  for (const id of ['p_one', 'p_two']) {
    await vault.claimPending({ owner: id, pairId: id, relay: 'wss://example.com', phase: 'prepared' });
    await vault.markJoining(id);
    await vault.savePair(id, { pairId: id, tx: { ctr: 1, chain: 'k' } });
  }
  const items = [
    { id: 'send-0001', pairId: 'p_one', text: 'secret words' },
    { id: 'send-0002', pairId: 'p_two', text: 'other' },
  ];
  await vault.setOutbox({ user: 'u', items });
  assert.deepEqual(await vault.getOutbox(), { user: 'u', items });
  assert.doesNotMatch(String(raw()), /secret words/, 'sealed, never plain');
  // removing one computer takes what was typed for it
  await vault.removePair('p_one');
  assert.deepEqual((await vault.getOutbox()).items, [items[1]]);
  await vault.setOutbox(null);
  assert.equal(await vault.getOutbox(), null);
  assert.equal(await vault.removePair('p_two'), true, 'removing a computer with no queue is fine');
  // another account does not inherit them
  await vault.setOutbox({ user: 'u', items });
  await vault.setAccount({ user: { id: 'u' }, deviceId: 'd', refreshToken: 'r2' });
  assert.equal((await vault.getOutbox()).items.length, 2, 'the same account keeps them across a token change');
  await vault.setAccount({ user: { id: 'other' }, deviceId: 'd2', refreshToken: 'r3' });
  assert.equal(await vault.getOutbox(), null);
});

test('the computer used last is kept with the vault, goes when the computer or the account does', async () => {
  const { vault } = fixture();
  await vault.setAccount({ user: { id: 'u' }, deviceId: 'd', refreshToken: 'r' });
  assert.equal(await vault.getLastPair(), null);
  await vault.claimPending({ owner: 'p_one', pairId: 'p_one', relay: 'wss://example.com', phase: 'prepared' });
  await vault.markJoining('p_one');
  await vault.savePair('p_one', { pairId: 'p_one', tx: { ctr: 1, chain: 'k' } });
  await vault.setLastPair('p_one');
  assert.equal(await vault.getLastPair(), 'p_one');
  await vault.setLastPair(undefined);
  assert.equal(await vault.getLastPair(), null);
  await vault.setLastPair('p_one');
  await vault.removePair('p_other');
  assert.equal(await vault.getLastPair(), 'p_one', 'another computer leaving changes nothing');
  await vault.removePair('p_one');
  assert.equal(await vault.getLastPair(), null);
  await vault.setLastPair('p_x');
  await vault.setAccount({ user: { id: 'other' }, deviceId: 'd2', refreshToken: 'r2' });
  assert.equal(await vault.getLastPair(), null, 'another account has not chosen one');
});

test('a refresh claim left by an earlier run of the app does not block the next refresh', async () => {
  // the app was killed (an update, the system, a crash) between the claim and the answer: its claim must not strand the account
  const f = fixture();
  const account = { user: { id: 'one' }, deviceId: 'phone_1234', refreshToken: 'old' };
  await f.vault.setAccount(account);
  await f.vault.claimRefresh('old');
  const next = f.reopen();
  const claim = await next.claimRefresh('old');
  assert.ok(claim);
  await next.completeRefresh(claim, 'old', { ...account, refreshToken: 'new' });
  assert.equal((await next.getAccount()).refreshToken, 'new');
});

test('an interrupted operation retains its identity across repeated claims and vault instances', async () => {
  const f = fixture();
  await f.vault.setAccount({ user: { id: 'one' }, deviceId: 'phone_1234', refreshToken: 'old' });
  const operation = await f.vault.claimRefresh('old');
  assert.equal(await f.vault.claimRefresh('old'), operation);
  assert.equal(await f.reopen().claimRefresh('old'), operation);
});
