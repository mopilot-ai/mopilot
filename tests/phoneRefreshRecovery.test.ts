// Durable refresh operations preserve the account and pairs across response loss, crashes and failed local writes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhoneAuth } from '../shared/remote/phoneAuth.mjs';
import { createPhoneVault } from '../shared/remote/phoneVault.mjs';
import { fromBase64, fromUtf8, toBase64, utf8 } from '../shared/remote/envelope.mjs';
import { prim } from './support/phonePairingFixture.ts';

async function fixture() {
  let value: string | null = null,
    key: string | null = null,
    fail = false;
  const options = {
    prim,
    key: {
      get: async () => key,
      set: async (v: string) => {
        key = v;
      },
    },
    transaction: async (fn: any) => {
      let next = value;
      const result = await fn({
        read: async () => value,
        write: async (v: string) => {
          next = v;
        },
      });
      if (fail) {
        fail = false;
        throw new Error('disk unavailable');
      }
      value = next;
      return result;
    },
  };
  const open = () => createPhoneVault(options);
  const vault = open();
  await vault.setAccount({ user: { id: 'u' }, deviceId: 'phone', refreshToken: 'old' });
  await vault.claimPending({ owner: 'pair-owner', pairId: 'p_test', phase: 'prepared' });
  await vault.markJoining('pair-owner');
  await vault.savePair('pair-owner', { pairId: 'p_test', macId: 'mac' });
  return {
    vault,
    open,
    replaceClaim: (claim: object) => {
      const blob = JSON.parse(value!);
      const aad = utf8('mopilot-phone-vault-v1');
      const plain = JSON.parse(fromUtf8(prim.aeadOpen(fromBase64(key!), fromBase64(blob.nonce), fromBase64(blob.box), aad)!));
      plain.refreshClaim = claim;
      const nonce = prim.randomBytes(24);
      value = JSON.stringify({
        nonce: toBase64(nonce),
        box: toBase64(prim.aeadSeal(fromBase64(key!), nonce, utf8(JSON.stringify(plain)), aad)),
      });
    },
    failWrite: () => {
      fail = true;
    },
  };
}

for (const failure of ['response', 'malformed', 'local-save']) {
  test(`restart retries the same durable operation after ${failure} failure without dropping pairs`, async () => {
    const f = await fixture();
    const calls: Array<[string, string]> = [];
    let committed: string | undefined;
    const refresh = async (token: string, operation: string) => {
      assert.match(operation, /^[A-Za-z0-9_-]{32}$/);
      calls.push([token, operation]);
      committed ??= operation;
      assert.equal(operation, committed, 'retry must recover the original operation');
      if (calls.length === 1) {
        if (failure === 'response') throw new Error('response lost after commit');
        if (failure === 'malformed') return {};
        f.failWrite();
      }
      return { access_token: 'access', refresh_token: 'successor', expires_in: 900 };
    };
    const auth = createPhoneAuth({ vault: f.vault, refresh, now: () => 0 });
    await auth.restore();
    await assert.rejects(auth.token());
    const reopened = createPhoneAuth({ vault: f.open(), refresh, now: () => 0 });
    await reopened.restore();
    assert.equal(await reopened.token(), 'access');
    assert.deepEqual(calls, [calls[0], calls[0]]);
    assert.equal((await f.vault.getAccount()).refreshToken, 'successor');
    assert.equal((await f.vault.pairs()).length, 1);
  });
}

test('crash before send and overlapping vault instances share one operation; stale saves cannot replace newer state', async () => {
  const f = await fixture();
  const operation = await f.vault.claimRefresh('old');
  const next = f.open();
  assert.equal(await next.claimRefresh('old'), operation);
  assert.equal(await f.vault.claimRefresh('old'), operation);
  const account = await next.getAccount();
  await next.completeRefresh(operation, 'old', { ...account, refreshToken: 'new' });
  await assert.rejects(f.vault.completeRefresh(operation, 'old', account), /account changed/);
  assert.notEqual(await next.claimRefresh('new'), operation);
});

test('legacy ambiguous claims and malformed or foreign operation identities fail closed without discarding pairs', async () => {
  for (const claim of [
    { owner: 'old', deviceId: 'phone' },
    { protocol: 1, owner: 'a'.repeat(32), deviceId: 'other' },
    { protocol: 1, owner: 5, deviceId: 'phone' },
    { protocol: 1, owner: '!', deviceId: 'phone' },
  ]) {
    const f = await fixture();
    f.replaceClaim(claim);
    await assert.rejects(f.open().claimRefresh('old'), /refresh interrupted/);
    assert.equal((await f.vault.pairs()).length, 1);
  }
});
