// Refresh rotation is coalesced and a sign-out retires in-flight token responses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhoneAuth } from '../shared/remote/phoneAuth.mjs';
import { deferred } from './support/phonePairingFixture.ts';

test('coalesces refresh and saves the rotation before returning', async () => {
  let account: any = { refreshToken: 'old', user: { id: 'a' }, deviceId: 'device' },
    calls = 0;
  const gate = deferred();
  const vault = {
    getAccount: async () => account,
    setAccount: async (v: any) => {
      account = v;
    },
    claimRefresh: async () => 'owner',
    completeRefresh: async (_owner: string, expected: string, v: any) => {
      assert.equal(account.refreshToken, expected);
      account = v;
      return true;
    },
  };
  const auth = createPhoneAuth({
    vault,
    refresh: async () => {
      calls++;
      return gate.promise;
    },
    now: () => 100,
  });
  await auth.restore();
  assert.equal(auth.expiresAt(), 0);
  const first = auth.token(),
    second = auth.token();
  gate.resolve({ access_token: 'access', refresh_token: 'new', expires_in: 120 });
  assert.deepEqual(await Promise.all([first, second]), ['access', 'access']);
  assert.equal(calls, 1);
  assert.equal(account.refreshToken, 'new');
  assert.equal(auth.expiresAt(), 120100);
  assert.equal(await auth.token(), 'access');
});

test('sign-out prevents a late refresh from restoring an account', async () => {
  let account: any = { refreshToken: 'old' };
  const gate = deferred();
  const auth = createPhoneAuth({
    vault: {
      getAccount: async () => account,
      setAccount: async (v: any) => {
        account = v;
      },
      claimRefresh: async () => 'owner',
      completeRefresh: async () => {
        throw new Error('unexpected');
      },
    },
    refresh: () => gate.promise,
  });
  await auth.restore();
  const pending = auth.token();
  await auth.signOut();
  gate.resolve({ access_token: 'a', refresh_token: 'b', expires_in: 120 });
  await assert.rejects(pending, /account changed/);
  assert.equal(account, null);
});

test('account install and invalid refresh responses fail visibly', async () => {
  let account: any = null;
  const auth = createPhoneAuth({
    vault: {
      getAccount: async () => account,
      setAccount: async (v: any) => {
        account = v;
      },
      claimRefresh: async () => 'owner',
      completeRefresh: async () => {},
    },
    refresh: async () => ({}),
  });
  await assert.rejects(auth.token(), /sign in required/);
  await auth.install({ user: { id: 'one' }, deviceId: 'phone', refreshToken: 'old' });
  await assert.rejects(auth.token(), /invalid token response/);
  await auth.signOut();
  assert.equal(account, null);
});

test('cached access is retired when the stored account changes', async () => {
  let stored: any = { deviceId: 'one', refreshToken: 'old', accessToken: 'access', expiresAt: 200000 };
  const auth = createPhoneAuth({ vault: { getAccount: async () => stored }, refresh: async () => {}, now: () => 0 });
  await auth.restore();
  stored = { ...stored, deviceId: 'two' };
  await assert.rejects(auth.token(), /account changed/);
});

test('a late claim and a late committed rotation cannot return a retired token', async () => {
  for (const stage of ['claim', 'commit']) {
    const gate = deferred();
    let account: any = { refreshToken: 'old', deviceId: 'one' };
    const vault = {
      getAccount: async () => account,
      setAccount: async (v: any) => {
        account = v;
      },
      claimRefresh: async () => (stage === 'claim' ? gate.promise : 'claim'),
      completeRefresh: async () => {
        if (stage === 'commit') await gate.promise;
      },
    };
    const auth = createPhoneAuth({ vault, refresh: async () => ({ access_token: 'a', refresh_token: 'b', expires_in: 100 }) });
    await auth.restore();
    const pending = auth.token();
    await Promise.resolve();
    await Promise.resolve();
    await auth.signOut();
    gate.resolve('claim');
    await assert.rejects(pending, /account changed/);
  }
});

test('superseded restore and install cannot publish older account', async () => {
  const read = deferred(),
    write = deferred();
  let calls = 0;
  const auth = createPhoneAuth({
    vault: {
      getAccount: () => read.promise,
      setAccount: async () => {
        if (++calls === 1) await write.promise;
      },
    },
    refresh: async () => {},
  });
  const restore = auth.restore();
  const install = auth.install({ refreshToken: 'one' });
  read.resolve({ refreshToken: 'old' });
  await assert.rejects(restore, /account changed/);
  await Promise.resolve();
  const signOut = auth.signOut();
  write.resolve(null);
  await assert.rejects(install, /account changed/);
  await signOut;
});

test('queued install and refresh response stop at ownership changes', async () => {
  const write = deferred(),
    requested = deferred(),
    response = deferred();
  let n = 0;
  const vault = {
    getAccount: async () => ({ deviceId: 'one', refreshToken: 'old' }),
    setAccount: async () => {
      if (++n === 1) await write.promise;
    },
    claimRefresh: async () => 'claim',
    completeRefresh: async () => {},
  };
  const auth = createPhoneAuth({
    vault,
    refresh: async () => {
      requested.resolve(null);
      return response.promise;
    },
  });
  const first = auth.install({ refreshToken: 'one' });
  await Promise.resolve();
  const queued = auth.install({ refreshToken: 'two' });
  const out = auth.signOut();
  write.resolve(null);
  await assert.rejects(first, /account changed/);
  await assert.rejects(queued, /account changed/);
  await out;
  await auth.restore();
  const token = auth.token();
  await requested.promise;
  await auth.signOut();
  response.resolve({ access_token: 'a', refresh_token: 'b', expires_in: 100 });
  await assert.rejects(token, /account changed/);
});

test('an access token without an expiry is refreshed before use', async () => {
  let account: any = { user: { id: 'u' }, deviceId: 'phone', refreshToken: 'old', accessToken: 'stale' };
  const auth = createPhoneAuth({
    vault: {
      getAccount: async () => account,
      claimRefresh: async () => 'claim',
      completeRefresh: async (_claim: string, _old: string, next: any) => {
        account = next;
      },
    },
    refresh: async () => ({ access_token: 'new', refresh_token: 'rotated', expires_in: 900 }),
    now: () => 0,
  });
  await auth.restore();
  assert.equal(await auth.token(), 'new');
});

test('sign-out wipes, then ends the session at the account service with the refresh token it held', async () => {
  let account: any = { refreshToken: 'held', user: { id: 'a' }, deviceId: 'device' };
  const order: string[] = [];
  const auth = createPhoneAuth({
    vault: {
      getAccount: async () => account,
      setAccount: async (v: any) => {
        order.push(`wipe:${v}`);
        account = v;
      },
    },
    refresh: async () => ({}),
    revoke: async (token: string) => void order.push(`revoke:${token}`),
  });
  await auth.restore();
  assert.deepEqual(await auth.signOut(), { revoked: true });
  assert.deepEqual(order, ['wipe:null', 'revoke:held']);
  // nothing signed in, nothing to revoke
  assert.deepEqual(await auth.signOut(), { revoked: false });
  assert.deepEqual(order, ['wipe:null', 'revoke:held', 'wipe:null']);
});

test('sign-out finishes when the account service cannot be reached, and without the account restored in memory', async () => {
  let account: any = { refreshToken: 'held' };
  const revoked: string[] = [];
  const setAccount = async (v: any) => void (account = v);
  const failing = createPhoneAuth({
    vault: { getAccount: async () => account, setAccount },
    refresh: async () => ({}),
    revoke: async (t: string) => {
      revoked.push(t);
      throw new Error('offline');
    },
  });
  // never restored: the account is read from the vault; the failure is reported, not hidden
  assert.deepEqual(await failing.signOut(), { revoked: false });
  assert.deepEqual(revoked, ['held']);
  assert.equal(account, null);
  // a vault that cannot be read, and an auth with no revoke at all, still sign out
  account = { refreshToken: 'again' };
  const noRevoke = createPhoneAuth({
    vault: {
      getAccount: async () => {
        throw new Error('locked');
      },
      setAccount,
    },
    refresh: async () => ({}),
  });
  assert.deepEqual(await noRevoke.signOut(), { revoked: false });
  assert.equal(account, null);
  const quiet = createPhoneAuth({ vault: { getAccount: async () => ({ refreshToken: 'x' }), setAccount }, refresh: async () => ({}) });
  assert.deepEqual(await quiet.signOut(), { revoked: false });
  // a service that answers with a refusal is not a revocation
  const refused = createPhoneAuth({
    vault: { getAccount: async () => ({ refreshToken: 'x' }), setAccount },
    refresh: async () => ({}),
    revoke: async () => false,
  });
  assert.deepEqual(await refused.signOut(), { revoked: false });
});

const relayFixture = (o: { relayToken?: (access: string) => Promise<any>; clock?: { t: number } } = {}) => {
  let account: any = { refreshToken: 'rt', user: { id: 'a' }, deviceId: 'device', accessToken: 'access-1', expiresAt: 10_000_000 };
  const clock = o.clock ?? { t: 1000 };
  const asked: string[] = [];
  const auth = createPhoneAuth({
    vault: {
      getAccount: async () => account,
      setAccount: async (v: any) => {
        account = v;
      },
      claimRefresh: async () => 'owner',
      completeRefresh: async (_o: string, _e: string, v: any) => ((account = v), true),
    },
    refresh: async () => ({ access_token: 'access-2', refresh_token: 'rt2', expires_in: 900 }),
    relayToken: o.relayToken ?? (async (access: string) => (asked.push(access), { token: `relay-${asked.length}`, expires_in: 600 })),
    now: () => clock.t,
  });
  return { auth, asked, clock };
};

test('the relay token is made from the access token, kept until a minute before it ends, and made again on demand', async () => {
  const { auth, asked, clock } = relayFixture();
  await assert.rejects(auth.relayToken(), /sign in required/);
  await auth.restore();
  assert.equal(auth.relayExpiresAt(), 0);
  assert.equal(await auth.relayToken(), 'relay-1');
  assert.equal(auth.relayExpiresAt(), 601_000);
  assert.deepEqual(asked, ['access-1'], 'the access token goes to the account service, never to the relay');
  assert.equal(await auth.relayToken(), 'relay-1', 'still good');
  assert.equal(await auth.relayToken(true), 'relay-2', 'forced');
  clock.t = 1000 + 600_000 - 59_000;
  assert.equal(await auth.relayToken(), 'relay-3', 'within a minute of its end');
});

test('one relay token request at a time, and its answer is checked', async () => {
  const gate = deferred();
  let calls = 0;
  const first = relayFixture({ relayToken: () => (calls++, gate.promise) });
  await first.auth.restore();
  const both = Promise.all([first.auth.relayToken(), first.auth.relayToken()]);
  gate.resolve({ token: 'one', expires_in: 600 });
  assert.deepEqual(await both, ['one', 'one']);
  assert.equal(calls, 1);

  for (const bad of [
    null,
    {},
    { token: '', expires_in: 600 },
    { token: 't', expires_in: 0 },
    { token: 't', expires_in: 1.5 },
    { token: 't', expires_in: 1e308 },
  ]) {
    const { auth } = relayFixture({ relayToken: async () => bad });
    await auth.restore();
    await assert.rejects(auth.relayToken(), /invalid relay token response/);
  }
  const bare = createPhoneAuth({
    vault: { getAccount: async () => ({ refreshToken: 'r', accessToken: 'a', expiresAt: 9e9 }), setAccount: async () => undefined },
    refresh: async () => ({}),
  });
  await bare.restore();
  await assert.rejects(bare.relayToken(), /no relay token source/);
});

test('a relay token never outlives its sign-in: sign-out, a new sign-in and a restore drop it, and a late answer is thrown away', async () => {
  const gate = deferred();
  const entered = deferred();
  const { auth } = relayFixture({ relayToken: () => (entered.resolve(undefined), gate.promise) });
  await auth.restore();
  const late = auth.relayToken();
  await entered.promise;
  await auth.signOut();
  gate.resolve({ token: 'late', expires_in: 600 });
  await assert.rejects(late, /account changed/);
  assert.equal(auth.relayExpiresAt(), 0);
  await assert.rejects(auth.relayToken(), /sign in required/);

  const again = relayFixture();
  await again.auth.restore();
  assert.equal(await again.auth.relayToken(), 'relay-1');
  await again.auth.install({ refreshToken: 'r2', user: { id: 'b' }, deviceId: 'd2', accessToken: 'access-9', expiresAt: 10_000_000 });
  assert.equal(again.auth.relayExpiresAt(), 0, 'another account starts without the old one’s token');
  assert.equal(await again.auth.relayToken(), 'relay-2');
  assert.deepEqual(again.asked, ['access-1', 'access-9']);
  await again.auth.restore();
  assert.equal(again.auth.relayExpiresAt(), 0);
});

test('a failed request is not remembered: the next one asks again', async () => {
  let calls = 0;
  const { auth } = relayFixture({
    relayToken: async () => {
      if (calls++ === 0) throw new Error('Account service returned HTTP 503');
      return { token: 'ok', expires_in: 600 };
    },
  });
  await auth.restore();
  await assert.rejects(auth.relayToken(), /HTTP 503/);
  assert.equal(await auth.relayToken(), 'ok');
});

test('a relay token made while a restore still reads the vault is not kept for the account the restore finds', async () => {
  const accountA = { refreshToken: 'ra', user: { id: 'a' }, deviceId: 'device-a', accessToken: 'access-a', expiresAt: 10_000_000 };
  const accountB = { ...accountA, refreshToken: 'rb', user: { id: 'b' }, deviceId: 'device-b', accessToken: 'access-b' };
  let stored: any = accountA;
  let nextRead: Promise<void> = Promise.resolve();
  let mintGate: Promise<void> = Promise.resolve();
  const asked: string[] = [];
  const auth = createPhoneAuth({
    vault: {
      // only the next read waits: the restore's, while the relay token request goes on
      getAccount: async () => {
        const wait = nextRead;
        nextRead = Promise.resolve();
        await wait;
        return stored;
      },
      setAccount: async () => undefined,
      claimRefresh: async () => 'owner',
      completeRefresh: async () => true,
    },
    refresh: async () => ({}),
    relayToken: async (access: string) => (asked.push(access), await mintGate, { token: `relay-for-${access}`, expires_in: 900 }),
    now: () => 1000,
  });
  await auth.restore();
  const restoreFinds = async (account: any, answerFirst: boolean) => {
    const reading = deferred();
    const minting = deferred();
    nextRead = reading.promise;
    mintGate = minting.promise;
    const restoring = auth.restore();
    const request = auth.relayToken();
    await Promise.resolve();
    if (answerFirst) {
      minting.resolve(undefined);
      assert.match(await request, /relay-for-/);
      stored = account;
      reading.resolve(undefined);
      await restoring;
    } else {
      stored = account;
      reading.resolve(undefined);
      await restoring;
      minting.resolve(undefined);
      await assert.rejects(request, /account changed/);
    }
  };

  // the restore ends first and finds another account: the late answer is for the old one and is refused
  await restoreFinds(accountB, false);
  assert.equal(auth.relayExpiresAt(), 0);
  // the request answers first: the restore, ending later, drops what it made
  await restoreFinds(accountA, true);
  assert.equal(auth.relayExpiresAt(), 0);
  mintGate = Promise.resolve();
  assert.equal(await auth.relayToken(), 'relay-for-access-a');
  assert.deepEqual(asked, ['access-a', 'access-b', 'access-a']);
});
