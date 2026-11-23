// Sidecar sign-in owns startup and installation until it commits, is cancelled or is replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, codex, flush, chatgptAuth, sub } from './support/electron-accounts.ts';
import { sealedAuth } from './support/sealedAuth.ts';
import { deferred } from './support/async-scenarios.ts';

test('cancelling while the start RPC waits prevents a late browser open and removes staging', async (t) => {
  const { a, opened, userData } = setup(t);
  const reply = deferred();
  codex.handle = (method) => (method === 'account/login/start' ? reply.promise : {});
  const starting = a.startLogin();
  await flush();
  const proc = codex.procs[0];
  await a.cancelLogin();
  reply.resolve({ loginId: 'old', authUrl: 'https://old.test' });
  await starting;
  assert.deepEqual(opened, []);
  assert.equal(a.login, null);
  assert.equal(proc.killed, true);
  assert.deepEqual(fs.readdirSync(path.join(userData, 'accounts')), []);
});

test('a superseded start reply cannot replace the newer login', async (t) => {
  const { a, opened } = setup(t);
  const reply = deferred();
  let count = 0;
  codex.handle = (method) =>
    method === 'account/login/start' ? (++count === 1 ? reply.promise : { loginId: 'new', authUrl: 'https://new.test' }) : {};
  const first = a.startLogin();
  await flush();
  await a.startLogin();
  const latest = a.login;
  reply.resolve({ loginId: 'old', authUrl: 'https://old.test' });
  await first;
  assert.equal(a.login, latest);
  assert.deepEqual(opened, ['https://new.test']);
});

test('cancellation while account/read waits prevents installation and a signed-in notice', async (t) => {
  const { a, notices } = setup(t);
  const reply = deferred();
  codex.handle = (method) =>
    method === 'account/login/start' ? { loginId: 'login', authUrl: 'https://login.test' } : method === 'account/read' ? reply.promise : {};
  await a.startLogin();
  const proc = codex.procs[0];
  chatgptAuth(proc.home, 'new@example.test', 'new-account');
  proc.send({ method: 'account/login/completed', params: { success: true } });
  await flush();
  await a.cancelLogin();
  reply.resolve({ account: { email: 'new@example.test' } });
  await flush(15);
  assert.equal(
    a.state.accounts.some((account: any) => account.chatgptAccountId === 'new-account'),
    false,
  );
  assert.equal(
    notices().some((notice: any) => notice.kind === 'signedIn'),
    false,
  );
  assert.equal(fs.existsSync(proc.home), false);
});

test('a completion delivered in the start RPC turn is not dropped', async (t) => {
  const { a } = setup(t);
  codex.handle = (method, _params, home) => {
    if (method === 'account/login/start') {
      chatgptAuth(home, 'early@example.test', 'early-account');
      codex.procs.find((proc) => proc.home === home)!.send({ method: 'account/login/completed', params: { success: true } });
      return { loginId: 'early', authUrl: 'https://early.test' };
    }
    return {};
  };
  await a.startLogin();
  await flush(15);
  assert.equal(
    a.state.accounts.some((account: any) => account.chatgptAccountId === 'early-account'),
    true,
  );
  assert.equal(a.login, null);
});

test('the newest start wins while a previous cancellation is still cleaning up', async (t) => {
  const { a, opened } = setup(t);
  await a.startLogin();
  const cancelled = deferred();
  codex.handle = (method) =>
    method === 'account/login/cancel'
      ? cancelled.promise
      : method === 'account/login/start'
        ? { loginId: 'latest', authUrl: 'https://latest.test' }
        : {};
  const superseded = a.startLogin();
  await flush();
  await a.startLogin();
  const latest = a.login;
  cancelled.resolve({});
  await superseded;
  assert.equal(a.login, latest);
  assert.deepEqual(opened, ['https://auth.example.com/start', 'https://latest.test']);
  assert.equal(codex.procs.length, 2);
});

test('cancelling a pending browser open settles startup without waiting for that browser', async (t) => {
  const browser = deferred();
  const { a } = setup(t, { extra: { openExternal: () => browser.promise } });
  const starting = a.startLogin();
  await flush();
  await a.cancelLogin();
  assert.equal((await starting).login, null);
  browser.resolve(undefined);
});

test('a browser-open failure and a setup failure both clean their staged login', async (t) => {
  const { a, userData } = setup(t, {
    extra: {
      openExternal: async () => {
        throw new Error('no browser');
      },
    },
  });
  await assert.rejects(a.startLogin(), /no browser/);
  assert.equal(a.login, null);
  a.findBin = () => {
    throw new Error('no binary');
  };
  await assert.rejects(a.startLogin(), /no binary/);
  assert.deepEqual(fs.readdirSync(path.join(userData, 'accounts')), []);
});

test('dispose retires a start RPC that has not returned yet', async (t) => {
  const { a, opened } = setup(t);
  const reply = deferred();
  codex.handle = (method) => (method === 'account/login/start' ? reply.promise : {});
  const starting = a.startLogin();
  await flush();
  a.dispose();
  reply.resolve({ loginId: 'late', authUrl: 'https://late.test' });
  await starting;
  assert.equal(a.login, null);
  assert.deepEqual(opened, []);
});

test('removing the re-verification target cancels its pending account read', async (t) => {
  const { a, notices } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  const reply = deferred();
  codex.handle = (method, _params, home) =>
    method === 'account/login/start'
      ? { loginId: 'login', authUrl: 'https://login.test' }
      : method === 'account/read' && home.includes('.signin-')
        ? reply.promise
        : {};
  await a.startLogin('b');
  const proc = codex.procs[0];
  chatgptAuth(proc.home, 'b@example.com', 'acct-b');
  proc.send({ method: 'account/login/completed', params: { success: true } });
  await flush();
  await a.remove('b');
  reply.resolve({});
  await flush(12);
  assert.equal(a.get('b'), null);
  assert.equal(
    notices().some((notice: any) => notice.kind === 'signedIn'),
    false,
  );
});

test('duplicate completions and late notifications cannot finish a retired login', async (t) => {
  const { a, notices } = setup(t);
  const reply = deferred();
  codex.handle = (method) =>
    method === 'account/login/start' ? { loginId: 'login', authUrl: 'https://login.test' } : method === 'account/read' ? reply.promise : {};
  await a.startLogin();
  const login = a.login;
  const proc = codex.procs[0];
  chatgptAuth(proc.home, 'duplicate@example.test', 'duplicate');
  proc.send({ method: 'account/login/completed', params: { success: true } });
  proc.send({ method: 'account/login/completed', params: { success: true } });
  await flush();
  assert.equal(proc.written.filter((message) => message.method === 'account/read').length, 1);
  await a.cancelLogin();
  proc.send({ method: 'account/login/completed', params: { success: true } });
  await a.finishLogin(login, { success: true });
  reply.resolve({});
  await flush();
  assert.equal(
    notices().some((notice: any) => notice.kind === 'signedIn'),
    false,
  );
});

for (const removing of [false, true]) {
  test(`${removing ? 'removing the matching account' : 'cancelling'} while the sidecar closes prevents installation`, async (t) => {
    const { a, notices } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
    codex.handle = (method) => (method === 'account/login/start' ? { loginId: 'login', authUrl: 'https://login.test' } : {});
    await a.startLogin();
    const login = a.login;
    const closed = deferred();
    const close = login.sc.close.bind(login.sc);
    let closing = false;
    t.mock.method(login.sc, 'close', async () => {
      closing = true;
      await closed.promise;
      return close();
    });
    chatgptAuth(login.staging, 'b@example.com', 'acct-b');
    codex.procs[0].send({ method: 'account/login/completed', params: { success: true } });
    await flush();
    assert.equal(closing, true);
    const mutation = removing ? a.remove('b') : a.cancelLogin();
    if (removing) await mutation;
    closed.resolve(undefined);
    await mutation;
    await flush(15);
    assert.equal(
      notices().some((notice: any) => notice.kind === 'signedIn'),
      false,
    );
    assert.equal(fs.existsSync(login.staging), false);
    if (removing) assert.equal(a.get('b'), null);
  });
}

test('a newer login survives an older committed login waiting to apply', async (t) => {
  const { a, notices } = setup(t);
  const applied = deferred();
  t.mock.method(a, 'apply', () => applied.promise);
  await a.startLogin();
  const old = a.login;
  chatgptAuth(old.staging, 'committed@example.test', 'committed');
  codex.procs[0].send({ method: 'account/login/completed', params: { success: true } });
  await flush();
  assert.equal(a.login, null);
  await a.startLogin();
  const latest = a.login;
  applied.resolve(undefined);
  await flush(15);
  assert.equal(a.login, latest);
  assert.equal(
    notices().some((notice: any) => notice.kind === 'signedIn'),
    false,
  );
  assert.ok(a.state.accounts.some((account: any) => account.chatgptAccountId === 'committed'));
});

for (const same of [false, true]) {
  test(`removing an account preserves ${same ? 'a fresh login for the same identity' : 'a different login'} installed during cleanup`, async (t) => {
    const forgotten = deferred();
    const { a } = setup(t, { extra: { forgetProvider: () => forgotten.promise } });
    const removing = a.remove('default');
    assert.equal(a.remove('default'), removing, 'duplicate removal shares its transaction');
    await flush();
    codex.handle = (method) =>
      method === 'account/login/start'
        ? { loginId: 'new', authUrl: 'https://new.test' }
        : method === 'account/read'
          ? { account: { email: same ? 'a@example.com' : 'new@example.test' } }
          : {};
    await a.startLogin();
    const login = a.login;
    chatgptAuth(login.staging, same ? 'a@example.com' : 'new@example.test', same ? 'acct-default' : 'concurrent');
    codex.procs.find((proc) => proc.home === login.staging)!.send({ method: 'account/login/completed', params: { success: true } });
    await flush(15);
    const installed = a.state.accounts.find((account: any) => account.id !== 'default');
    assert.ok(installed);
    forgotten.resolve(undefined);
    await removing;
    assert.equal(a.get(installed.id), installed);
    assert.equal(a.state.active, installed.id);
    assert.equal(a.applied, installed.id);
  });
}

for (const replace of [false, true]) {
  test(`an API key ${replace ? 'replacement' : 'duplicate add'} survives removal of the previous record`, async (t) => {
    const logout = deferred();
    const { a, userData } = setup(t, { state: { accounts: [{ id: 'key', kind: 'apiKey', status: 'ok' }] }, homes: { key: 'key:old' } });
    t.mock.method(globalThis, 'fetch', async () => ({ status: 200 }) as any);
    codex.handle = (method, _params, home) => (method === 'account/logout' && home.endsWith('/key') ? logout.promise : {});
    const removing = a.remove('key');
    await flush();
    await a.addApiKey(replace ? 'new' : 'old', '', replace ? 'key' : null);
    const installed = a.state.accounts.find((account: any) => account.kind === 'apiKey' && account.id !== 'key');
    logout.resolve({});
    await removing;
    assert.ok(installed);
    assert.equal(a.get(installed.id), installed);
    assert.equal(sealedAuth(path.join(userData, 'accounts', installed.id)).OPENAI_API_KEY, replace ? 'new' : 'old');
  });
}

test('a new MoPilot gateway key waits for removal of its stable record before saving', async (t) => {
  const { a, userData } = setup(t);
  await a.setMoPilotKey('old', 'https://gateway.test/v1');
  const logout = deferred();
  codex.handle = (method, _params, home) => (method === 'account/logout' && home.endsWith('/mopilot') ? logout.promise : {});
  const removing = a.remove('mopilot');
  await flush();
  const replacing = a.setMoPilotKey('new', 'https://gateway.test/v1');
  logout.resolve({});
  await Promise.all([removing, replacing]);
  assert.ok(a.get('mopilot'));
  assert.equal(sealedAuth(path.join(userData, 'accounts', 'mopilot')).OPENAI_API_KEY, 'new');
});

test('removing two accounts concurrently still logs the last account out of the main server', async (t) => {
  const { a, sent } = setup(t, {
    defaultAuth: 'none',
    state: { accounts: [sub('b'), sub('c')], active: 'b' },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  await Promise.all([a.remove('b'), a.remove('c')]);
  assert.equal(a.state.accounts.length, 0);
  assert.ok(sent.some((message) => message.method === 'account/logout'));
  assert.equal(a.applied, null);
});

test('a queued target removal immediately cancels re-verification before it can install a new record', async (t) => {
  const forgotten = deferred();
  const { a } = setup(t, {
    state: { accounts: [sub('b')] },
    homes: { b: 'b@example.com' },
    extra: { forgetProvider: (id: string) => (id === 'default' ? forgotten.promise : Promise.resolve()) },
  });
  const first = a.remove('default');
  await flush();
  await a.startLogin('b');
  const login = a.login;
  chatgptAuth(login.staging, 'b@example.com', 'acct-b');
  const second = a.remove('b');
  codex.procs.find((proc) => proc.home === login.staging)!.send({ method: 'account/login/completed', params: { success: true } });
  await flush(15);
  forgotten.resolve(undefined);
  await Promise.all([first, second]);
  assert.equal(
    a.state.accounts.some((account: any) => account.chatgptAccountId === 'acct-b'),
    false,
  );
});

test('a failed login cancellation rejects removal and leaves the removal queue usable', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  await a.startLogin('b');
  const staging = a.login.staging;
  const original = fs.rmSync;
  const removal = t.mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
    if (args[0] === staging) throw new Error('staging cleanup failed');
    return original(...args);
  });
  await assert.rejects(a.remove('b'), /staging cleanup failed/);
  assert.ok(a.get('b'));
  assert.equal(a.login, null);
  removal.mock.restore();
  await a.remove('b');
  assert.equal(a.get('b'), null);
});

test('re-verification is refused while its target removal is queued', async (t) => {
  const forgotten = deferred();
  const { a } = setup(t, {
    state: { accounts: [sub('b')] },
    homes: { b: 'b@example.com' },
    extra: { forgetProvider: (id: string) => (id === 'default' ? forgotten.promise : Promise.resolve()) },
  });
  const first = a.remove('default');
  await flush();
  const second = a.remove('b');
  try {
    await assert.rejects(a.startLogin('b'), /being removed/);
    assert.equal(a.login, null);
  } finally {
    forgotten.resolve(undefined);
    await Promise.all([first, second]);
  }
});

test('a re-verification target removed while prior cancellation waits cannot be revived', async (t) => {
  const { a, opened } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  await a.startLogin();
  const cancelled = deferred();
  codex.handle = (method) => (method === 'account/login/cancel' ? cancelled.promise : {});
  const starting = a.startLogin('b');
  const rejected = assert.rejects(starting, /removed/);
  await a.remove('b');
  cancelled.resolve({});
  await rejected;
  assert.equal(a.login, null);
  assert.equal(codex.procs.filter((proc) => proc.home.includes('.signin-')).length, 1);
  assert.equal(opened.length, 1);
});

test('a re-verification of an account already removed (an expired toast clicked late) is refused, never added anew', async (t) => {
  const { a, opened } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  // the window's "Sign in again" says the same line when it already knows (src/store/accounts.ts signInAgain)
  const { ACCOUNT_REMOVED } = await import('../src/store/liveAction.ts');
  await assert.rejects(a.startLogin('gone'), (e: Error) => e.message === ACCOUNT_REMOVED);
  assert.equal(a.login, null);
  assert.equal(codex.procs.filter((proc) => proc.home.includes('.signin-')).length, 0);
  assert.equal(opened.length, 0);
  assert.deepEqual(
    a.state.accounts.map((x: any) => x.id),
    ['default', 'b'],
  );
});
