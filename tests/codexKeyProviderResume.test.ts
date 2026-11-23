// #2213: a Codex thread started on an added API key records that key's provider (sage_<hash>). After a switch to a
// subscription, a resume carried only the active account's provider (none), so Codex refused the thread ("Model
// provider sage_… not found"). Every added key's provider is now defined on each thread open, without naming one, so
// the thread resumes on its own key (the billing lane holds); a key removed since says so in words
// (electron/identity/contract/codexProvider.cjs, electron/harness/codexConnection.cjs). Data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup } from './support/electron-accounts.ts';
import { CodexAdapter } from './support/codex-harness/fixture';

const require = createRequire(import.meta.url);
const { CodexProviders, providerId, withProvider, providerError, REMOVED_KEY } = require('../electron/identity/contract/codexProvider.cjs');

const keyA = { account: 'a', baseUrl: 'https://gw.example.test/v1', name: 'gw.example.test', key: 'sk-a' };
const keyB = { account: 'b', baseUrl: 'https://api.openai.com/v1', name: 'OpenAI', key: 'sk-b' };

function providers(fail: string[] = []) {
  const stored: string[] = [];
  const p = new CodexProviders({
    command: '/h/auth-command',
    exists: () => true,
    store: async (_s: string, account: string) => {
      if (fail.includes(account)) throw new Error('keychain locked');
      stored.push(account);
    },
    erase: async () => {},
  });
  Object.defineProperty(p, 'available', { value: true });
  return { p, stored };
}

function adapterOn(p: any) {
  const sent: any[] = [];
  const server = { listeners: new Set(), send: (m: any) => sent.push(m), threadConfig: null };
  return { a: new CodexAdapter({ server, providers: p }), sent };
}

test('a thread that ran on a key resumes on it after a switch to a subscription', async () => {
  const { p } = providers();
  // the chat started while key A was active
  await p.sync(keyA, [keyA, keyB]);
  // the user switches to a ChatGPT subscription: no active provider, both keys still added
  await p.sync(null, [keyA, keyB]);
  await new Promise((r) => setImmediate(r));
  const { a, sent } = adapterOn(p);
  for (const method of ['thread/resume', 'thread/fork']) {
    a.call(method, { threadId: 't' }).catch(() => {});
    const params = sent.at(-1).params;
    // the thread keeps the provider it recorded, which is now defined
    assert.equal(params.modelProvider, undefined, method);
    const defs = params.config.model_providers;
    assert.equal(defs[providerId(keyA.baseUrl, 'a')].auth.args.at(-1), 'a', method);
    assert.equal(defs[providerId(keyB.baseUrl, 'b')].auth.args.at(-1), 'b', method);
    // a thread started before ids were per key recorded its endpoint's id
    assert.equal(defs[providerId(keyA.baseUrl)].auth.args.at(-1), 'a', method);
    assert.equal(defs[providerId(keyB.baseUrl)].auth.args.at(-1), 'b', method);
  }
});

test('two keys on one endpoint: each thread resumes on its own key; the active key wins the endpoint’s old id', async () => {
  const { p } = providers();
  const keyA2 = { ...keyA, account: 'a2', key: 'sk-a2' };
  // A2 listed first and active: it still wins the shared endpoint id; each key keeps its own id
  await p.sync(keyA2, [keyA2, keyA]);
  const out = withProvider({ threadId: 't' }, p.current(), p.definitions());
  assert.equal(out.modelProvider, providerId(keyA.baseUrl, 'a2'));
  const defs = out.config.model_providers;
  assert.equal(defs[providerId(keyA.baseUrl, 'a')].auth.args.at(-1), 'a');
  assert.equal(defs[providerId(keyA.baseUrl, 'a2')].auth.args.at(-1), 'a2');
  assert.equal(defs[providerId(keyA.baseUrl)].auth.args.at(-1), 'a2');
  // no key active: both still resolve to their own key
  await p.sync(null, [keyA, keyA2]);
  const none = p.definitions();
  assert.equal(none[providerId(keyA.baseUrl, 'a')].auth.args.at(-1), 'a');
  assert.equal(none[providerId(keyA.baseUrl, 'a2')].auth.args.at(-1), 'a2');
  // a provider the window defined itself is kept; nothing to add leaves the params alone
  const own = withProvider({ config: { model_providers: { mine: { name: 'm' } } } }, null, p.definitions());
  assert.ok(own.config.model_providers.mine);
  const bare = { threadId: 't' };
  assert.equal(withProvider(bare, null, {}), bare);
  assert.equal(withProvider(bare, null), bare);
});

test('kept keys: replaced by each sync that lists them, kept when one does not, dropped when removed or unstorable', async () => {
  const { p, stored } = providers(['b']);
  const onlyA = [providerId(keyA.baseUrl), providerId(keyA.baseUrl, 'a')].sort();
  await p.sync(null, [keyA, keyB]);
  assert.deepEqual(Object.keys(p.definitions()).sort(), onlyA);
  assert.deepEqual(stored, ['a']);
  // a sync that does not list the keys (an added key applied: provideKey) leaves them as they are
  await p.sync(keyA);
  assert.deepEqual(Object.keys(p.definitions()).sort(), onlyA);
  await p.forget('a');
  assert.deepEqual(p.definitions(), {});
  await p.sync(null, [keyA]);
  await p.sync(null, []);
  assert.deepEqual(p.definitions(), {});
  // with no providers the connection adds nothing
  const sent: any[] = [];
  new CodexAdapter({ server: { listeners: new Set(), send: (m: any) => sent.push(m), threadConfig: null } })
    .call('thread/resume', { threadId: 't' })
    .catch(() => {});
  assert.equal(sent.at(-1).params.config, undefined);
});

test('an older sync that finishes last never brings back a key removed meanwhile', async () => {
  let release: () => void = () => {};
  const p = new CodexProviders({
    command: '/h/auth-command',
    exists: () => true,
    store: (_s: string, account: string) => (account === 'b' ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
    erase: async () => {},
  });
  Object.defineProperty(p, 'available', { value: true });
  const first = p.sync(null, [keyA, keyB]);
  await new Promise((r) => setImmediate(r));
  // B is removed while its key is still being stored, and the accounts sync again without it
  const forgot = p.forget('b');
  const second = p.sync(null, [keyA]);
  release();
  await Promise.all([first, second, forgot]);
  assert.equal(p.definitions()[providerId(keyB.baseUrl, 'b')], undefined);
  assert.ok(p.definitions()[providerId(keyA.baseUrl, 'a')]);
});

test('a thread whose key was removed is refused in words; other failures and other requests keep theirs', async () => {
  const { p } = providers();
  const { a, sent } = adapterOn(p);
  const refusal = { code: -32600, message: 'failed to load configuration: Model provider `sage_0123456789` not found' };
  const resume = a.call('thread/resume', { threadId: 't' });
  a.onServer({ kind: 'message', msg: { id: sent.at(-1).id, error: refusal } });
  await assert.rejects(resume, (e: Error) => e.message === REMOVED_KEY);
  const turn = a.call('turn/start', { threadId: 't' });
  a.onServer({ kind: 'message', msg: { id: sent.at(-1).id, error: refusal } });
  await assert.rejects(turn, /Model provider/);
  const other = a.call('thread/fork', { threadId: 't' });
  a.onServer({ kind: 'message', msg: { id: sent.at(-1).id, error: { code: 1, message: 'no rollout' } } });
  await assert.rejects(other, /no rollout/);
  assert.equal(providerError('Model provider sage_abc not found').message, REMOVED_KEY);
  assert.equal(providerError('other'), 'other');
});

test('the accounts list every added key for its provider, not the CLI’s own key or a ChatGPT login', (t) => {
  const key = (id: string, extra: object = {}) => ({ id, kind: 'apiKey', status: 'ok', ...extra });
  const { a } = setup(t, {
    defaultAuth: { key: 'sk-cli' },
    state: {
      active: 'k',
      accounts: [key('k'), key('gw', { baseUrl: 'https://gw.example.test/v1' }), { id: 'sub', kind: 'chatgpt', status: 'ok' }],
    },
    homes: { k: 'key:sk-k', gw: 'key:sk-gw' },
  });
  assert.deepEqual(
    a.keyInputs().map((i: any) => i.account),
    ['k', 'gw'],
  );
});
