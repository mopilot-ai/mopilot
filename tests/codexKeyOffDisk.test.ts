// An added Codex API key never reaches disk in plain text (#2201): it goes to Codex through each thread's own model
// provider (auth.command reads it from the keychain), on thread/start, resume and fork alike, instead of an app-server
// login that Codex saves to the CLI's own ~/.codex/auth.json (electron/identity/accounts/providers.cjs applyKey,
// electron/harness/codexConnection.cjs call). Codex and the main app-server are faked; data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup } from './support/electron-accounts.ts';
import { CodexAdapter } from './support/codex-harness/fixture';

const key = (id: string, extra: object = {}) => ({ id, kind: 'apiKey', status: 'ok', ...extra });
const cliAuth = () => path.join(process.env.CODEX_HOME!, 'auth.json');
/** The main app-server: records the requests it is sent. */
function mainServer(a: any) {
  const sent: any[] = [];
  a.mainRequest = async (method: string, params: any) => {
    sent.push({ method, params });
    // Codex saves an API-key login to $CODEX_HOME/auth.json
    if (method === 'account/login/start' && params.type === 'apiKey')
      fs.writeFileSync(cliAuth(), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: params.apiKey }));
    return {};
  };
  return sent;
}

test('an added key without an endpoint of its own gets OpenAI as its provider; the CLI’s own key gets none', (t) => {
  const { a } = setup(t, {
    defaultAuth: { key: 'sk-cli' },
    state: { active: 'k', accounts: [key('k'), key('gw', { baseUrl: 'https://gw.example.test/v1' })] },
    homes: { k: 'key:sk-k', gw: 'key:sk-gw' },
  });
  assert.deepEqual(a.providerInput(), { account: 'k', baseUrl: 'https://api.openai.com/v1', name: 'OpenAI', key: 'sk-k' });
  assert.equal(a.providerInput(a.get('gw')).name, 'gw.example.test');
  // the CLI's own key: Codex reads it from its own auth.json
  assert.equal(a.providerInput(a.get('default')), null);
});

test('switching to an added key through its provider sends no login and never writes the CLI’s auth.json', async (t) => {
  const asked: any[] = [];
  const { a } = setup(t, {
    defaultAuth: { key: 'sk-cli' },
    state: { active: 'default', accounts: [key('k')] },
    homes: { k: 'key:sk-k' },
    extra: { provideKey: async (input: any) => (asked.push(input), true) },
  });
  const sent = mainServer(a);
  const before = fs.readFileSync(cliAuth(), 'utf8');
  const at = fs.statSync(cliAuth()).mtimeMs;
  await a.switchTo('k');
  assert.equal(a.state.active, 'k');
  assert.deepEqual(asked, [{ account: 'k', baseUrl: 'https://api.openai.com/v1', name: 'OpenAI', key: 'sk-k' }]);
  assert.deepEqual(
    sent.filter((m) => m.method === 'account/login/start'),
    [],
    'the key is not given to the app-server',
  );
  assert.equal(fs.readFileSync(cliAuth(), 'utf8'), before);
  assert.equal(fs.statSync(cliAuth()).mtimeMs, at, 'the file was never rewritten');
});

test('without the provider route an added key logs the app-server in and the CLI’s file is put back; the CLI’s own key never asks', async (t) => {
  const asked: any[] = [];
  const { a } = setup(t, {
    defaultAuth: { key: 'sk-cli' },
    state: { active: 'default', accounts: [key('k')] },
    homes: { k: 'key:sk-k' },
    extra: { provideKey: async (input: any) => (asked.push(input?.account), false) },
  });
  const sent = mainServer(a);
  const before = fs.readFileSync(cliAuth(), 'utf8');
  await a.switchTo('k');
  assert.deepEqual(
    sent.filter((m) => m.method === 'account/login/start').map((m) => m.params),
    [{ type: 'apiKey', apiKey: 'sk-k' }],
  );
  assert.equal(fs.readFileSync(cliAuth(), 'utf8'), before, 'the CLI’s own sign-in is restored');
  // the CLI's own key: logged in as before, with no provider asked for
  asked.length = 0;
  await a.switchTo('default');
  assert.deepEqual(asked, []);
});

test('the active key’s provider goes with thread/start, resume and fork; a provider the request names wins', () => {
  const sent: any[] = [];
  const fragment = {
    modelProvider: 'sage_x',
    config: { model_providers: { sage_x: { name: 'OpenAI', auth: { command: '/h/auth-command' } } } },
  };
  let current: any = fragment;
  const server = { listeners: new Set(), send: (m: any) => sent.push(m), threadConfig: null };
  const a = new CodexAdapter({ server, provider: () => current });
  for (const method of ['thread/start', 'thread/resume', 'thread/fork', 'turn/start'])
    a.call(method, { threadId: 't', cwd: '/tmp' }).catch(() => {});
  const byMethod = Object.fromEntries(sent.map((m) => [m.method, m.params]));
  for (const m of ['thread/start', 'thread/resume', 'thread/fork']) {
    assert.equal(byMethod[m].modelProvider, 'sage_x', m);
    assert.equal(byMethod[m].config.model_providers.sage_x.auth.command, '/h/auth-command', m);
  }
  assert.equal(byMethod['turn/start'].modelProvider, undefined);
  a.call('thread/fork', { threadId: 't', modelProvider: 'mine' }).catch(() => {});
  assert.equal(sent.at(-1).params.modelProvider, 'mine');
  // a ChatGPT account: no provider, the thread keeps its own
  current = null;
  a.call('thread/resume', { threadId: 't' }).catch(() => {});
  assert.equal(sent.at(-1).params.modelProvider, undefined);
});

test('a thread opened while the key is still being stored waits for its provider; with nothing pending it goes at once', async () => {
  const { CodexProviders } = createRequire(import.meta.url)('../electron/identity/contract/codexProvider.cjs');
  let release!: () => void;
  const providers = new CodexProviders({
    command: '/h/auth-command',
    exists: () => true,
    store: () => new Promise<void>((resolve) => (release = resolve)),
  });
  Object.defineProperty(providers, 'available', { value: true });
  const sent: any[] = [];
  const server = { listeners: new Set(), send: (m: any) => sent.push(m), threadConfig: null };
  const a = new CodexAdapter({ server, providers });
  assert.equal(providers.pending(), null);
  const syncing = providers.sync({ account: 'k', baseUrl: 'https://api.openai.com/v1', name: 'OpenAI', key: 'sk-k' });
  assert.ok(providers.pending(), 'a sync in flight');
  a.call('thread/resume', { threadId: 't' }).catch(() => {});
  a.call('turn/start', { threadId: 't' }).catch(() => {});
  await flushAll();
  assert.deepEqual(
    sent.map((m) => m.method),
    ['turn/start'],
    'the resume waits for the provider; other requests do not',
  );
  release();
  await syncing;
  await flushAll();
  const resume = sent.find((m) => m.method === 'thread/resume');
  assert.match(resume.params.modelProvider, /^sage_/);
  assert.equal(providers.pending(), null, 'cleared once settled');
  // nothing pending: sent in the same tick
  a.call('thread/fork', { threadId: 't' }).catch(() => {});
  assert.equal(sent.at(-1).method, 'thread/fork');
  assert.match(sent.at(-1).params.modelProvider, /^sage_/);
});

test('pending follows the newest sync and settles even when storing the key fails', async () => {
  const { CodexProviders } = createRequire(import.meta.url)('../electron/identity/contract/codexProvider.cjs');
  const gates: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const providers = new CodexProviders({
    command: '/h/auth-command',
    exists: () => true,
    store: () => new Promise<void>((resolve, reject) => gates.push({ resolve, reject })),
  });
  Object.defineProperty(providers, 'available', { value: true });
  const input = (key: string) => ({ account: 'k', baseUrl: 'https://api.openai.com/v1', name: 'OpenAI', key });
  const first = providers.sync(input('sk-1'));
  const firstPending = providers.pending();
  const second = providers.sync(input('sk-2'));
  assert.notEqual(providers.pending(), firstPending, 'the newest sync is the one waited for');
  await flushAll();
  gates[0].resolve();
  await first;
  await flushAll();
  assert.ok(providers.pending(), 'an older sync settling does not clear the newer one');
  gates[1].reject(new Error('keychain refused'));
  await second;
  await flushAll();
  assert.equal(providers.pending(), null);
  assert.equal(providers.current(), null, 'no provider when the key could not be stored');
});

test('the adapter reads the provider and a pending key from the providers it is given', () => {
  const providers = {
    current: () => ({ modelProvider: 'sage_y', config: { model_providers: { sage_y: {} } } }),
    pending: () => null,
    definitions: () => ({}),
  };
  const sent: any[] = [];
  const a = new CodexAdapter({ server: { listeners: new Set(), send: (m: any) => sent.push(m), threadConfig: null }, providers });
  a.call('thread/start', { cwd: '/tmp' }).catch(() => {});
  assert.equal(sent.at(-1).params.modelProvider, 'sage_y');
  const none = new CodexAdapter({ server: { listeners: new Set(), send: (m: any) => sent.push(m), threadConfig: null } });
  assert.equal(none.provider(), null);
  assert.equal(none.providerPending(), null);
});

const flushAll = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
