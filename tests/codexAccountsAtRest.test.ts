// The Codex account pool keeps added accounts' sign-ins encrypted at rest (electron/identity/codexAccounts.cjs with
// identity/accounts/authVault.cjs): plain files an earlier version left are sealed at startup, a sidecar gets the plain
// sign-in only while it runs and what it refreshed is sealed when it exits, and nothing is signed in or saved without
// the OS key. Codex, the relay and the main app-server are faked; data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, codex, flush, chatgptAuth, jwt } from './support/electron-accounts.ts';
import { sealedAuth, sealedAfterSidecar } from './support/sealedAuth.ts';
import { fakeSafe } from './support/computerHistory.ts';

const plain = (home: string) => path.join(home, 'auth.json');

test('plain sign-ins an earlier version left are sealed at startup; the CLI’s own auth.json is left alone', (t) => {
  const { a, userData, codexHome } = setup(t, {
    state: { active: 'b', accounts: [{ id: 'b', kind: 'chatgpt', email: 'b@example.com', chatgptAccountId: 'acct-b', status: 'ok' }] },
    homes: { b: 'b@example.com', k: 'key:sk-k' },
  });
  assert.equal(sealedAuth(path.join(userData, 'accounts', 'b')).tokens.account_id, 'acct-b');
  assert.equal(sealedAuth(path.join(userData, 'accounts', 'k')).OPENAI_API_KEY, 'sk-k');
  assert.ok(fs.existsSync(plain(codexHome)), 'the CLI’s own sign-in is Codex’s file');
  assert.equal(a.get('b').email, 'b@example.com');
});

test('a sidecar reads the sign-in in plain text only while it runs, and what it refreshed is sealed when it exits', async (t) => {
  const { a, userData } = setup(t, {
    state: { active: 'b', accounts: [{ id: 'b', kind: 'chatgpt', email: 'b@example.com', chatgptAccountId: 'acct-b', status: 'ok' }] },
    homes: { b: 'b@example.com' },
  });
  const home = path.join(userData, 'accounts', 'b');
  let seenAtStart: string | null = null;
  codex.handle = (m, _p, h) => {
    if (m === 'initialize') seenAtStart = fs.existsSync(plain(h)) ? fs.readFileSync(plain(h), 'utf8') : null;
    if (m === 'account/read') {
      // Codex refreshes the token and writes it back to its home
      chatgptAuth(h, 'b@example.com', 'acct-b', 5e9, 'pro');
      return { account: { email: 'b@example.com', planType: 'pro' } };
    }
    return {};
  };
  const before = sealedAuth(home);
  const tok = await a.tokens(a.get('b'), true);
  assert.ok(seenAtStart && JSON.parse(seenAtStart).tokens.account_id === 'acct-b', 'the sidecar found its sign-in');
  assert.ok(fs.existsSync(plain(home)), 'in plain text while the sidecar runs');
  assert.equal(tok.exp, 5e9, 'the refreshed token is read while it runs');
  await a.sidecars.get(home).close();
  const after = sealedAuth(home);
  assert.notDeepEqual(after, before);
  assert.equal(JSON.parse(Buffer.from(after.tokens.access_token.split('.')[1], 'base64url').toString()).exp, 5e9);
  // read again from the sealed copy
  assert.equal((await a.tokens(a.get('b'))).exp, 5e9);
});

test('a new browser sign-in is sealed once its sidecar closes; signing in again to an account replaces its sealed copy', async (t) => {
  const { a, userData } = setup(t, {
    state: {
      active: 'default',
      accounts: [{ id: 'b', kind: 'chatgpt', email: 'b@example.com', chatgptAccountId: 'acct-b', status: 'ok' }],
    },
    homes: { b: 'b@example.com' },
  });
  codex.handle = (m) =>
    m === 'account/login/start' ? { loginId: 'L', authUrl: 'u' } : m === 'account/read' ? { account: { email: 'n@example.com' } } : {};
  await a.startLogin();
  const staging = codex.procs.at(-1)!.home;
  chatgptAuth(staging, 'n@example.com', 'acct-n');
  codex.procs.at(-1)!.send({ method: 'account/login/completed', params: { success: true } });
  await flush(12);
  const added = a.state.accounts.find((x: any) => x.chatgptAccountId === 'acct-n');
  assert.equal((await sealedAfterSidecar(a, path.join(userData, 'accounts', added.id))).tokens.account_id, 'acct-n');

  codex.handle = (m) =>
    m === 'account/login/start' ? { loginId: 'L2', authUrl: 'u' } : m === 'account/read' ? { account: { email: 'b@example.com' } } : {};
  await a.startLogin('b');
  const again = codex.procs.at(-1)!.home;
  const auth = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-b', chatgpt_plan_type: 'pro' } };
  fs.writeFileSync(
    plain(again),
    JSON.stringify({
      tokens: { access_token: jwt({ ...auth, exp: 6e9 }), id_token: jwt({ ...auth, email: 'b@example.com' }), account_id: 'acct-b' },
    }),
  );
  codex.procs.at(-1)!.send({ method: 'account/login/completed', params: { success: true } });
  await flush(12);
  const b = await sealedAfterSidecar(a, path.join(userData, 'accounts', 'b'));
  assert.equal(JSON.parse(Buffer.from(b.tokens.access_token.split('.')[1], 'base64url').toString()).exp, 6e9);
  assert.equal(fs.existsSync(again), false, 'the sign-in folder is gone with its plain copy');
});

test('without the OS key no sign-in starts and no key or folder is saved; the user is told', async (t) => {
  const { a, userData, notices } = setup(t, { extra: { safeStorage: fakeSafe(false) } });
  const homes = () => (fs.existsSync(path.join(userData, 'accounts')) ? fs.readdirSync(path.join(userData, 'accounts')) : []);
  const before = homes();
  await assert.rejects(a.startLogin(), /Can’t keep a Codex sign-in safe/);
  assert.equal(codex.procs.length, 0, 'no sidecar was started');
  // a closed local port: the key is not checked, only saved
  await assert.rejects(
    a.addApiKey('sk-new', 'http://127.0.0.1:9/v1'),
    (e: any) => e.code === 'secret_unavailable' && /the API key/.test(e.message),
  );
  assert.deepEqual(notices(), [], 'the Settings call itself gets the error');
  await assert.rejects(a.setMoPilotKey('mpk-1', 'https://gw.example/v1'), (e: any) => e.code === 'secret_unavailable');
  assert.deepEqual(notices(), [{ kind: 'loginFailed', error: 'Codex can’t use MoPilot credits: the system keychain is unavailable.' }]);
  assert.deepEqual(homes(), before, 'no account folder was made');
  assert.equal(a.get('mopilot'), null);
});

test('quitting seals the sign-ins of sidecars that were told to stop but have not exited yet', async (t) => {
  const { a, userData } = setup(t, {
    state: { active: 'b', accounts: [{ id: 'b', kind: 'chatgpt', email: 'b@example.com', chatgptAccountId: 'acct-b', status: 'ok' }] },
    homes: { b: 'b@example.com' },
  });
  const home = path.join(userData, 'accounts', 'b');
  await a.tokens(a.get('b'), true);
  assert.ok(fs.existsSync(plain(home)));
  a.dispose();
  assert.equal(sealedAuth(home).tokens.account_id, 'acct-b', 'sealed before any sidecar exit arrives');
});

test('a plain sign-in left in an added account without the OS key keeps working and is not deleted', (t) => {
  const { a, userData } = setup(t, {
    state: { active: 'b', accounts: [{ id: 'b', kind: 'chatgpt', email: 'b@example.com', chatgptAccountId: 'acct-b', status: 'ok' }] },
    homes: { b: 'b@example.com' },
    extra: { safeStorage: null },
  });
  assert.ok(fs.existsSync(plain(path.join(userData, 'accounts', 'b'))));
  assert.equal(a.vault.read(path.join(userData, 'accounts', 'b')) !== null, true);
});

test('a sign-in the Keychain won’t decrypt says so, not that it expired; one that is gone still reads as expired', async (t) => {
  const { a, userData } = setup(t, {
    state: { active: 'b', accounts: [{ id: 'b', kind: 'chatgpt', email: 'b@example.com', chatgptAccountId: 'acct-b', status: 'ok' }] },
    homes: { b: 'b@example.com' },
  });
  const home = path.join(userData, 'accounts', 'b');
  // sealed under another key: the Keychain hands back nothing usable
  fs.writeFileSync(path.join(home, 'auth.json.enc'), JSON.stringify({ v: 1, enc: 'safe', data: 'b3RoZXI=' }));
  a.vault.cache.clear();
  codex.handle = (m) => (m === 'account/read' ? { account: null } : {});
  await assert.rejects(a.tokens(a.get('b'), true), /expired/);
  assert.match(a.get('b').error, /couldn’t read this sign-in from the Keychain/);
  // no sign-in at all: the usual words
  fs.rmSync(path.join(home, 'auth.json.enc'));
  a.setStatus(a.get('b'), 'ok');
  await assert.rejects(a.tokens(a.get('b'), true), /expired/);
  assert.match(a.get('b').error, /Your sign-in expired/);
});
