// Retired token reads stop relay routing without disabling ordinary authentication-failure fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { admitAll } from './support/relayPeer.ts';
const { UsageRefresh } = createRequire(import.meta.url)('../electron/identity/contract/usageRefresh.cjs');
const { Relay } = createRequire(import.meta.url)('../electron/identity/accounts/relay.cjs');

for (const forced of [false, true]) {
  for (const retired of [false, true]) {
    test(`${retired ? 'retired' : 'current failed'} ${forced ? '401 retry' : 'initial token'} owns only its relay request`, async () => {
      const rows = [{ id: 'a' }, { id: 'b' }];
      const picks: string[] = [];
      const attempts: string[] = [];
      const relay = new Relay(
        {
          usageRefresh: new UsageRefresh(),
          pickFor: (_session: string, tried: Set<string>) => {
            const row = rows.find((r) => !tried.has(r.id));
            if (row) picks.push(row.id);
            return row;
          },
          tokens: async (row: any, force: boolean) => {
            if (row.id === 'a' && (!forced || force)) {
              throw Object.assign(new Error('token read failed'), retired ? { code: 'ACCOUNT_CHANGED' } : {});
            }
            return {};
          },
          noteUsageHeaders: () => {},
        },
        admitAll,
      );
      const result = await relay.withAccounts('chat', async (row: any) => {
        attempts.push(row.id);
        return { status: row.id === 'a' ? 401 : 200, headers: {}, body: Buffer.from('answer') };
      });
      assert.equal(result.status, retired ? 503 : 200);
      assert.deepEqual(picks, retired ? ['a'] : ['a', 'b']);
      assert.deepEqual(attempts, [...(forced ? ['a'] : []), ...(retired ? [] : ['b'])]);
      if (retired) assert.match(result.body.toString(), /login changed.*Retry/);
    });
  }
}

for (const forced of [false, true]) {
  test(`a rejected retired account refresh stops relay ${forced ? '401 recovery' : 'initial routing'}`, async () => {
    const req = createRequire(import.meta.url);
    const { Accounts } = req('../electron/identity/codexAccounts.cjs');
    const { UsageRefresh } = req('../electron/identity/contract/usageRefresh.cjs');
    const { deferred } = await import('./support/async-scenarios.ts');
    const reply = deferred<any>();
    const row = { id: 'a' };
    let picks = 0;
    let attempts = 0;
    const manager = Object.assign(Object.create(Accounts.prototype), {
      usageRefresh: new UsageRefresh(),
      refreshing: new Map(),
      sidecar: () => ({ call: () => reply.promise }),
      pickFor: () => (++picks, row),
      tokens(a: any, force: boolean) {
        return forced && !force ? Promise.resolve({}) : this.refresh(a);
      },
    });
    const work = new Relay(manager, admitAll).withAccounts(
      'chat',
      async () => (++attempts, { status: 401, headers: {}, body: Buffer.from('old') }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    manager.usageRefresh.clear('a');
    reply.reject(new Error('401 from the retired sidecar'));
    const response = await work;
    assert.equal(response.status, 503);
    assert.match(response.body.toString(), /login changed.*Retry/);
    assert.equal(picks, 1);
    assert.equal(attempts, forced ? 1 : 0);
    assert.equal(manager.refreshing.size, 0);
  });
}

for (const forced of [false, true]) {
  test(`a fulfilled token retired before the relay continuation starts no ${forced ? '401 retry' : 'initial request'}`, async () => {
    const usageRefresh = new UsageRefresh();
    let attempts = 0;
    let picks = 0;
    const row = { id: 'a' };
    const relay = new Relay(
      {
        usageRefresh,
        pickFor: () => (++picks, row),
        tokens: async (_row: any, force: boolean) => {
          if (!forced || force) queueMicrotask(() => usageRefresh.clear('a'));
          return { accessToken: 'fake-old' };
        },
      },
      admitAll,
    );
    const r = await relay.withAccounts('chat', async () => (++attempts, { status: 401, body: Buffer.from('old'), headers: {} }));
    assert.equal(r.status, 503);
    assert.equal(picks, 1);
    assert.equal(attempts, forced ? 1 : 0);
  });
}

test('a 401 received after sign-in starts no token refresh for the retired request', async () => {
  const usageRefresh = new UsageRefresh();
  let tokenReads = 0;
  const relay = new Relay(
    {
      usageRefresh,
      pickFor: () => ({ id: 'a' }),
      tokens: async () => (++tokenReads, {}),
    },
    admitAll,
  );
  const r = await relay.withAccounts('chat', async () => {
    usageRefresh.clear('a');
    return { status: 401, headers: {}, body: Buffer.from('old response') };
  });
  assert.equal(r.status, 503);
  assert.equal(tokenReads, 1);
});
