// Identity layer: provider profiles, instances and the two account drivers (data is made up).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/computerHistory.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-identity-'));
const codexHome = path.join(tmp, 'codex');
const claudeHome = path.join(tmp, 'claude');
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(claudeHome, { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CLAUDE_CONFIG_DIR = claudeHome;
process.env.SAGE_NO_RELAY = '1';

const req = createRequire(import.meta.url);
const { Registry, providerFor, instance, PROVIDERS } = req('../electron/identity/contract/registry.cjs');
const { CodexDriver, codexInstance } = req('../electron/identity/drivers/codex.cjs');
const { ClaudeDriver, claudeInstances } = req('../electron/identity/drivers/claude.cjs');
const { loginBilling, claudeBilling, rejectedCredential } = req('../electron/identity/contract/claudeBilling.cjs');
const { AcpDriver } = req('../electron/identity/drivers/acp.cjs');
const { Accounts } = req('../electron/identity/codexAccounts.cjs');
const { ClaudeAccounts } = req('../electron/harness/claude/accounts.cjs');

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
function chatgptAuth(home: string, email: string, accountId: string) {
  fs.mkdirSync(home, { recursive: true });
  const auth = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' } };
  fs.writeFileSync(
    path.join(home, 'auth.json'),
    JSON.stringify({ tokens: { access_token: jwt({ ...auth, exp: 4e9 }), id_token: jwt({ ...auth, email }), account_id: accountId } }),
  );
}
const fakeServer = () => ({ intercepts: new Set(), listeners: new Set(), send() {} });

test('a custom endpoint is its own provider; the first-party host is not', () => {
  assert.equal(providerFor(null, 'openai').id, 'openai');
  assert.equal(providerFor('https://api.openai.com/v1', 'openai').id, 'openai');
  const gw = providerFor('https://gw.example.test/v1', 'anthropic');
  assert.equal(gw.id, 'custom:gw.example.test');
  assert.deepEqual(gw.wires, ['anthropic']);
  assert.equal(gw.firstParty, false);
});

test('instances reject unknown billing types and kinds', () => {
  const base = { harness: 'codex', account: 'a', provider: PROVIDERS.openai, kind: 'cliLogin', billing: 'subscription' };
  assert.equal(instance(base).id, 'codex:a');
  assert.throws(() => instance({ ...base, billing: 'free' }));
  assert.throws(() => instance({ ...base, kind: 'other' }));
});

test('Codex records map to subscription, API key and credits instances', () => {
  assert.deepEqual(
    [
      { id: 'default', kind: 'chatgpt', email: 'a@example.com', status: 'ok' },
      { id: 'b', kind: 'chatgpt', email: 'b@example.com', status: 'expired' },
      { id: 'k', kind: 'apiKey', baseUrl: 'https://gw.example.test/v1', status: 'ok' },
      { id: 'mopilot', kind: 'apiKey', mopilot: true, status: 'ok' },
    ]
      .map((a) => codexInstance(a, 'b'))
      .map((i: any) => [i.account, i.kind, i.billing, i.provider.id, i.status, i.active]),
    [
      ['default', 'cliLogin', 'subscription', 'openai', 'ok', false],
      ['b', 'harnessAuth', 'subscription', 'openai', 'expired', true],
      ['k', 'sageKey', 'apiKey', 'custom:gw.example.test', 'ok', false],
      ['mopilot', 'sageKey', 'credits', 'mopilot', 'ok', false],
    ],
  );
});

test('the Codex driver reads the account pool as it is', () => {
  chatgptAuth(codexHome, 'a@example.com', 'acct-a');
  const userData = path.join(tmp, 'ud-codex');
  fs.mkdirSync(userData, { recursive: true });
  chatgptAuth(path.join(userData, 'accounts', 'b'), 'b@example.com', 'acct-b');
  fs.writeFileSync(
    path.join(userData, 'accounts.json'),
    JSON.stringify({
      active: 'b',
      pool: 'single',
      autoSwitch: false,
      accounts: [
        {
          id: 'b',
          kind: 'chatgpt',
          email: 'b@example.com',
          chatgptAccountId: 'acct-b',
          status: 'ok',
          limits: { used: 30, reached: false, at: Date.now() },
        },
      ],
      chatPins: { t1: 'default' },
    }),
  );
  const accounts = new Accounts({
    userData,
    server: fakeServer(),
    findBin: () => 'codex',
    clientInfo: {},
    safeStorage: fakeSafe(),
    broadcast: () => {},
    openExternal: () => {},
  });
  try {
    const d = new CodexDriver(accounts);
    assert.deepEqual(
      d.instances().map((i: any) => [i.account, i.billing, i.active]),
      [
        ['default', 'subscription', false],
        ['b', 'subscription', true],
      ],
    );
    assert.equal(d.failover, 'continue'); // no relay
    assert.equal(d.perChat, false);
    assert.deepEqual(d.poolPolicy, { pool: 'single', autoSwitch: false });
    assert.equal(d.chatInstance('t1').account, 'default');
    assert.equal(d.chatInstance('t2').account, 'b');
    accounts.relay = {};
    assert.equal(d.failover, 'replay');
    assert.equal(d.perChat, true);
  } finally {
    accounts.relay = null;
    accounts.dispose();
  }
});

test('Claude: a Console login is pay-per-use, claude.ai a subscription', () => {
  assert.equal(loginBilling('claude.ai'), 'subscription');
  assert.equal(loginBilling('console_api_key'), 'apiKey');
  assert.equal(loginBilling(null), 'subscription');
});

test('Claude instances: logins, then the keys, and the selected key is the active one', () => {
  const view = {
    active: 'x',
    accounts: [
      { id: 'default', email: 'a@example.com', loggedIn: true, authMethod: 'claude.ai' },
      { id: 'x', email: 'x@example.com', loggedIn: false },
    ],
  };
  const sub = claudeInstances(view, { set: true, mode: 'subscription', baseUrl: null }, true);
  assert.deepEqual(
    sub.map((i: any) => [i.account, i.kind, i.billing, i.provider.id, i.status, i.active]),
    [
      ['default', 'cliLogin', 'subscription', 'anthropic', 'ok', false],
      ['x', 'harnessAuth', 'subscription', 'anthropic', 'signedOut', true],
      ['apiKey', 'sageKey', 'apiKey', 'anthropic', 'ok', false],
      ['mopilot', 'sageKey', 'credits', 'mopilot', 'ok', false],
    ],
  );
  const onKey = claudeInstances(view, { set: true, mode: 'apiKey', baseUrl: 'https://gw.example.test' }, false);
  assert.deepEqual(
    onKey.filter((i: any) => i.active).map((i: any) => [i.account, i.provider.id]),
    [['apiKey', 'custom:gw.example.test']],
  );
});

test('the Claude driver wraps the account module; the registry lists both harnesses', async () => {
  const accts = new ClaudeAccounts({
    userData: path.join(tmp, 'ud-claude'),
    broadcast: () => {},
    run: async () => JSON.stringify({ loggedIn: true, email: 'c@example.com', authMethod: 'claude.ai' }),
  });
  await accts.refresh('claude');
  const d = new ClaudeDriver({
    accounts: () => accts,
    keyInfo: () => ({ set: false, mode: 'subscription', baseUrl: null }),
    gatewaySet: () => false,
    readUsage: async (a: string) => `usage of ${a}`,
  });
  assert.equal(d.failover, 'restartResume');
  assert.equal(d.perChat, true);
  assert.deepEqual(d.poolPolicy, { pool: 'single', autoSwitch: true });
  assert.equal(await d.usage('default'), 'usage of default');
  assert.deepEqual(
    d.instances().map((i: any) => [i.id, i.billing, i.active]),
    [['claude:default', 'subscription', true]],
  );

  const r = new Registry();
  r.register(d);
  r.register({
    harness: 'codex',
    failover: 'none',
    perChat: false,
    poolPolicy: { pool: 'single', autoSwitch: false },
    instances: () => [codexInstance({ id: 'k', kind: 'apiKey', baseUrl: null, status: 'ok' }, 'k')],
  });
  assert.equal(r.get('codex:k').billing, 'apiKey');
  assert.deepEqual(
    r.instances('claude').map((i: any) => i.id),
    ['claude:default'],
  );
  assert.deepEqual(
    r.providers().map((p: any) => p.id),
    ['anthropic', 'openai'],
  );
  assert.equal(r.instances()[0].provider.id, 'anthropic');
  assert.equal(r.driver('claude').failover, 'restartResume');
});

test('Claude billing: MoPilot credits and third-party endpoints are not the subscription', () => {
  assert.deepEqual(claudeBilling('subscription', null, 'claude.ai'), {
    mode: 'subscription',
    provider: 'anthropic',
    label: 'Subscription',
  });
  assert.equal(claudeBilling('subscription', null, 'console_api_key').mode, 'apiKey');
  // the shell's cloud variables (D-35) win over any key mode and read as an API-key route
  assert.deepEqual(claudeBilling('mopilot', null, 'claude.ai', true), {
    mode: 'apiKey',
    provider: 'cloud',
    label: 'API key · your cloud account',
  });
  assert.deepEqual(claudeBilling('mopilot', null, 'oauth_token'), { mode: 'mopilot', provider: 'mopilot', label: 'MoPilot credits' });
  assert.deepEqual(claudeBilling('apiKey', 'https://gw.example.test/v1', 'oauth_token'), {
    mode: 'apiKey',
    provider: 'custom:gw.example.test',
    label: 'API key · gw.example.test',
  });
  assert.equal(claudeBilling('apiKey', null, null).label, 'API key');
});

test('a refused credential names its own fix, never the CLI sign-in; the CLI login itself has none', () => {
  assert.equal(rejectedCredential('apiKey', null), 'Anthropic rejected this API key. Check it and try again.');
  assert.equal(rejectedCredential('apiKey', 'https://api.anthropic.com'), 'Anthropic rejected this API key. Check it and try again.');
  assert.equal(
    rejectedCredential('apiKey', 'https://openrouter.ai/api'),
    'openrouter.ai rejected this API key. Check the key and its endpoint, then try again.',
  );
  assert.match(String(rejectedCredential('mopilot', null)), /^MoPilot refused this device's credits key\. Sign out of MoPilot/);
  // the shell's cloud account wins over any key mode, as in claudeBilling
  for (const mode of ['subscription', 'apiKey', 'mopilot'] as const)
    assert.match(String(rejectedCredential(mode, null, true)), /^Your cloud provider refused/);
  assert.equal(rejectedCredential('subscription', null), null);
  for (const mode of ['apiKey', 'mopilot'] as const)
    assert.doesNotMatch(String(rejectedCredential(mode, null)), /auth login|sign in to claude/i);
});

test('the ACP driver: one instance per harness found, no failover and no per-chat accounts', () => {
  const list = [
    { id: 'gemini', label: 'Gemini CLI', state: 'admitted', authMethods: [] },
    { id: 'goose', label: 'Goose', state: 'signin', authMethods: [{ id: 'login', name: 'Log in' }] },
    { id: 'kimi', label: 'Kimi', state: 'missing', authMethods: [] },
  ];
  const d = new AcpDriver({ list: () => list });
  const reg = new Registry();
  reg.register(d);
  assert.deepEqual(
    reg.instances('acp').map((i: any) => [i.id, i.kind, i.billing, i.status, i.active, i.provider.label]),
    [
      ['acp:gemini', 'cliLogin', 'harness', 'ok', true, 'Gemini CLI'],
      ['acp:goose', 'cliLogin', 'harness', 'signedOut', true, 'Goose'],
    ],
  );
  assert.deepEqual(d.lane, { failover: 'none', perChat: false, usage: 'none' });
  assert.deepEqual([d.failover, d.perChat, d.poolPolicy], ['none', false, { pool: 'single', autoSwitch: false }]);
  assert.deepEqual(d.authMethods('goose'), [{ id: 'login', name: 'Log in' }]);
  assert.deepEqual(d.authMethods('nope'), []);
});
