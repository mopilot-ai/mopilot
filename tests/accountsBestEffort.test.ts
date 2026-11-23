// The Codex account pool (electron/identity/codexAccounts.cjs), part three: the best-effort steps whose failure must
// not stop the operation around them (a sign-out, cancelling a sign-in, applying a login, reading usage)
// and must not escape as an unhandled rejection. Codex, the relay and the main app-server are faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, codex, flush, chatgptAuth, sub, Accounts } from './support/electron-accounts.ts';
import { fakeSafe } from './support/computerHistory.ts';
import { sealedAuth } from './support/sealedAuth.ts';

const { recentIgnored, clearIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');

const staging = () => codex.procs.at(-1)!.home;

test("a sidecar's stdin failing after its process exited is ignored", async (t) => {
  const { a } = setup(t);
  const sc = a.sidecar(a.active());
  const proc = codex.procs.at(-1)!;
  assert.equal(typeof proc.stdinHandlers.error, 'function');
  proc.stdinHandlers.error(new Error('EPIPE'));
  assert.equal(sc.proc, proc, 'the exit handler, not the stdin error, ends the sidecar');
  await sc.close();
});

test('a token refresh answered on a connection that has closed is dropped', async (t) => {
  const { a, server } = setup(t, { defaultAuth: 'none' });
  const send = server.send;
  let refused = 0;
  server.send = (m: any) => {
    if (m.id === 'r1' && !m.method) {
      refused++;
      throw new Error('connection closed');
    }
    return send(m);
  };
  assert.equal(a.onMainMessage({ id: 'r1', method: 'account/chatgptAuthTokens/refresh', params: {} }), true);
  await flush();
  assert.equal(refused, 1, 'the error reply was attempted');
});

test('cancelling a sign-in still closes it when Codex cannot cancel it', async (t) => {
  const { a } = setup(t);
  await a.startLogin();
  const dir = staging();
  const proc = codex.procs.at(-1)!;
  codex.handle = (m) => (m === 'account/login/cancel' ? { __error: { message: 'no such login' } } : {});
  const v = await a.cancelLogin();
  assert.equal(v.login, null);
  assert.ok(proc.written.some((m: any) => m.method === 'account/login/cancel'));
  assert.equal(proc.killed, true);
  assert.ok(!fs.existsSync(dir));
});

test('a new login is saved and announced even when it cannot be applied or its usage saved', async (t) => {
  let failSaves = false;
  const { a, notices } = setup(t, {
    state: { accounts: [sub('b')] },
    homes: { b: 'b@example.com' },
    extra: {
      broadcast: (e: any) => {
        if (failSaves && e.type === 'changed') throw new Error('window gone');
      },
    },
    reply: (m: any) => (m.method === 'account/login/start' ? { error: { message: 'app-server busy' } } : { result: {} }),
  });
  a.get('default').status = 'expired';
  const shown: any[] = [];
  a.notice = (n: any) => {
    shown.push(n);
    // from the announcement on, broadcasting the state fails: the usage read that follows rejects
    if (n.kind === 'signedIn') failSaves = true;
  };
  codex.handle = (m) =>
    m === 'account/login/start'
      ? { loginId: 'L1', authUrl: 'https://auth.example.com/go' }
      : m === 'account/read'
        ? { account: { email: 'n@example.com', planType: 'pro' } }
        : m === 'account/rateLimits/read'
          ? { rateLimits: { primary: { usedPercent: 1 } } }
          : {};
  await a.startLogin();
  chatgptAuth(staging(), 'n@example.com', 'acct-n');
  codex.procs.at(-1)!.send({ method: 'account/login/completed', params: { success: true } });
  await flush(30);
  const added = a.state.accounts.find((x: any) => x.chatgptAccountId === 'acct-n');
  assert.ok(added, 'the account is saved');
  assert.equal(a.state.active, added.id, 'and active, in place of the expired login');
  assert.notEqual(a.applied, added.id, 'applying it failed');
  assert.deepEqual(
    shown.find((n) => n.kind === 'signedIn'),
    { kind: 'signedIn', email: 'n@example.com', added: true, mismatch: null },
  );
  assert.equal(notices().length, 0);
});

test('removing the active login keeps going when the next one cannot be applied', async (t) => {
  const { a, userData } = setup(t, {
    state: { active: 'b', accounts: [sub('b'), sub('c')] },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  a.applyNow = async () => {
    throw new Error('app-server down');
  };
  await a.remove('b');
  assert.ok(!a.get('b'));
  assert.ok(!fs.existsSync(path.join(userData, 'accounts', 'b')));
  assert.notEqual(a.state.active, 'b');
});

test('removing an account whose sign-out fails, or the last account when the app-server cannot log out, still removes it', async (t) => {
  const { a, userData } = setup(t, {
    defaultAuth: 'none',
    state: { active: 'c', accounts: [sub('b'), sub('c')] },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  codex.handle = (m) => (m === 'account/logout' ? { __error: { message: 'revoke failed' } } : {});
  await a.remove('b');
  assert.ok(codex.procs.some((p) => p.written.some((m: any) => m.method === 'account/logout')));
  assert.ok(!fs.existsSync(path.join(userData, 'accounts', 'b')));
  a.mainRequest = async (m: string) => {
    if (m === 'account/logout') throw new Error('app-server gone');
    return {};
  };
  a.mainMode = 'external';
  await a.remove('c');
  assert.deepEqual([a.state.accounts.length, a.mainMode, a.applied], [0, 'managed', null]);
});

test('MoPilot sign-out with nothing left still signs out when the app-server cannot log out', async (t) => {
  const { a, notices, userData } = setup(t, {
    defaultAuth: 'none',
    state: { active: 'mopilot', accounts: [{ id: 'mopilot', kind: 'apiKey', mopilot: true, status: 'ok' }] },
    homes: { mopilot: 'key:mpk' },
  });
  const asked: string[] = [];
  a.mainRequest = async (m: string) => {
    asked.push(m);
    throw new Error('app-server gone');
  };
  await a.setMoPilotKey(null);
  assert.deepEqual(asked, ['account/logout']);
  assert.equal(a.get('mopilot'), null);
  assert.ok(!fs.existsSync(path.join(userData, 'accounts', 'mopilot')));
  assert.equal(a.mainMode, 'managed');
  assert.deepEqual(notices().at(-1), { kind: 'mopilotSignedOut' });
});

test('a new MoPilot key for the account in use is saved even when logging it in fails', async (t) => {
  const { a, userData } = setup(t, {
    defaultAuth: 'none',
    state: { active: 'mopilot', accounts: [{ id: 'mopilot', kind: 'apiKey', mopilot: true, status: 'ok', baseUrl: 'u' }] },
    homes: { mopilot: 'key:mpk-1' },
  });
  a.mainRequest = async () => {
    throw new Error('gateway down');
  };
  await a.setMoPilotKey('mpk-2', 'u');
  assert.equal(sealedAuth(path.join(userData, 'accounts', 'mopilot')).OPENAI_API_KEY, 'mpk-2');
  assert.equal(a.applied, null, 'the next reconnect logs in with the new key');
});

test('an unreadable accounts file is kept aside and recorded; the pool starts again from the CLI login', (t) => {
  const { userData, server } = setup(t);
  fs.writeFileSync(path.join(userData, 'accounts.json'), '{ "accounts": [ torn');
  clearIgnored();
  const b = new Accounts({
    userData,
    server,
    findBin: () => 'codex',
    safeStorage: fakeSafe(),
    broadcast: () => {},
    openExternal: () => {},
  });
  t.after(() => b.dispose());
  assert.deepEqual(
    b.state.accounts.map((x: any) => x.id),
    ['default'],
  );
  assert.equal(fs.readFileSync(path.join(userData, 'accounts.json.unreadable'), 'utf8'), '{ "accounts": [ torn');
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['read the Codex accounts'],
  );
});
