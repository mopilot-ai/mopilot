// The review's refresh races on MoMo's Google account: a refresh in flight cannot undo a disconnect, a new sign-in or a dispose (shared/momoGoogle/account.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountError } from '../shared/momoGoogle/account.mjs';
import { READ_SCOPES } from '../shared/momoGoogle/types.mjs';
import { makeAccount, memoryFile, record } from './support/googleAccountKit.ts';

// 2. a refresh in flight cannot undo a disconnect, a new sign-in or a dispose
function slowToken() {
  let release: (answer: { status?: number; body?: unknown }) => void = () => undefined;
  const gate = new Promise<{ status?: number; body?: unknown }>((resolve) => (release = resolve));
  let started: () => void = () => undefined;
  const begun = new Promise<void>((resolve) => (started = resolve));
  const fetch = async (url: string) => {
    // only the token endpoint is slow; a revoke answers at once
    if (url !== cfg.tokenUri) return { ok: true, status: 200, json: async () => ({}) };
    started();
    const a = await gate;
    return { ok: (a.status ?? 200) < 400, status: a.status ?? 200, json: async () => a.body };
  };
  return { fetch, release, begun };
}
const refreshed = { access_token: 'late-token', refresh_token: 'late-refresh', expires_in: 3600, scope: READ_SCOPES.join(' ') };
const expired = () => record({ tokens: { ...record().tokens, expiresAt: 0 } });
const cfg = { clientId: 'c', clientSecret: 's', authUri: 'a', tokenUri: 't', revokeUri: 'r' };

test('a refresh that finishes after a disconnect saves nothing', async () => {
  const slow = slowToken();
  const file = memoryFile(expired());
  const { account } = makeAccount({ config: cfg, fetch: slow.fetch as never, file });
  const pending = account.accessToken();
  await slow.begun;
  await account.disconnect();
  slow.release({ body: refreshed });
  await assert.rejects(pending, (e: AccountError) => e.code === 'not_connected');
  assert.equal(file.value, null, 'the disconnected account is not written back');
});

test('a refresh that finishes after a new sign-in does not overwrite it', async () => {
  const slow = slowToken();
  const file = memoryFile(expired());
  const { account, clock } = makeAccount({ config: cfg, fetch: slow.fetch as never, file });
  const generation = account.generation();
  const pending = account.accessToken();
  await slow.begun;
  clock.t += 1000;
  await account.connect({
    email: 'me@example.com',
    subject: 'sub-me@example.com',
    tokens: { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: clock.t + 3_600_000, scopes: [...READ_SCOPES] },
    client: 'desktop',
    rule: 'read',
    generation,
  });
  slow.release({ body: refreshed });
  await assert.rejects(pending, (e: AccountError) => e.code === 'not_connected');
  assert.equal(file.value?.tokens.refreshToken, 'new-rt');
  assert.equal(file.value?.tokens.accessToken, 'new-at');
});

test('a disposed account (an old reader after a move or reset) refuses, and a refresh on its way saves nothing', async () => {
  const slow = slowToken();
  const file = memoryFile(expired());
  const { account } = makeAccount({ config: cfg, fetch: slow.fetch as never, file });
  const pending = account.accessToken();
  await slow.begun;
  account.dispose();
  slow.release({ body: refreshed });
  await assert.rejects(pending, (e: AccountError) => e.code === 'not_connected');
  assert.equal(file.value?.tokens.accessToken, 'at', 'the record is as it was');
  await assert.rejects(account.accessToken(), (e: AccountError) => e.code === 'not_connected');
});

test('a refusal that arrives after a disconnect does not mark a new state either', async () => {
  const slow = slowToken();
  const file = memoryFile(expired());
  const { account } = makeAccount({ config: cfg, fetch: slow.fetch as never, file });
  const pending = account.accessToken();
  await slow.begun;
  await account.disconnect();
  slow.release({ status: 400, body: { error: 'invalid_grant' } });
  await assert.rejects(pending, (e: AccountError) => e.code === 'not_connected');
  assert.equal(file.value, null);
});
