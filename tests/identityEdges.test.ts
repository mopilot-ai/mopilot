// electron/identity/**: the account drivers, registry, Claude switching policy and Codex provider
// helper on their less common inputs (missing fields, no accounts, failing helpers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';

const require = createRequire(import.meta.url);
const { CodexDriver, codexInstance } = require('../electron/identity/drivers/codex.cjs');
const { AcpDriver } = require('../electron/identity/drivers/acp.cjs');
const { ClaudeDriver, claudeInstances } = require('../electron/identity/drivers/claude.cjs');
const { Registry, providerFor, PROVIDERS } = require('../electron/identity/contract/registry.cjs');
const { decideClaudeSwitch, planName, claudeInstance, LIMIT_HOLD_MS } = require('../electron/identity/contract/switch.cjs');
const { CodexProviders, withProvider, KEYCHAIN_SERVICE } = require('../electron/identity/contract/codexProvider.cjs');

test('codexInstance: no kind is ChatGPT; the default API key is the CLI login', () => {
  assert.equal(codexInstance({ id: 'x' }, null).billing, 'subscription');
  const k = codexInstance({ id: 'default', kind: 'apiKey' }, 'default');
  assert.deepEqual([k.kind, k.billing, k.active], ['cliLogin', 'apiKey', true]);
});

function codexAccounts(list: any[], activeId: string | null, extra: any = {}) {
  return {
    state: { accounts: list },
    pins: new Map(extra.pins ?? []),
    active: () => list.find((a) => a.id === activeId) ?? null,
    get: (id: string) => list.find((a) => a.id === id) ?? null,
    limited: () => false,
    refreshUsage: extra.refreshUsage ?? (async () => {}),
  };
}

test('CodexDriver without an active account; chat instance falls back to the active one or null', () => {
  const d = new CodexDriver(codexAccounts([{ id: 'a' }], null));
  assert.equal(d.instances()[0].active, false);
  assert.equal(d.chatInstance(null), null);
  const pinnedOnly = new CodexDriver(codexAccounts([{ id: 'a' }], null, { pins: [['t', { id: 'a' }]] }));
  assert.deepEqual([pinnedOnly.chatInstance('t').account, pinnedOnly.chatInstance('t').active], ['a', false]);
  const d2 = new CodexDriver(codexAccounts([{ id: 'a' }, { id: 'b' }], 'a', { pins: [['t1', { id: 'gone' }]] }));
  assert.equal(d2.chatInstance('t1').account, 'a');
  assert.equal(d2.chatInstance('').account, 'a');
});

test('CodexDriver.usage: only ChatGPT logins; a failed refresh still returns the last limits', async () => {
  const list = [
    { id: 'g', limits: { five: 1 } },
    { id: 'k', kind: 'apiKey' },
    { id: 'n', kind: 'chatgpt' },
  ];
  const refreshed: any[] = [];
  const d = new CodexDriver(
    codexAccounts(list, 'g', {
      refreshUsage: async (ids: string[], ms: number) => {
        refreshed.push([ids, ms]);
        throw new Error('offline');
      },
    }),
  );
  assert.deepEqual(await d.usage('g'), { five: 1 });
  assert.deepEqual(refreshed, [[['g'], 5 * 60_000]]);
  assert.equal(await d.usage('k'), null);
  assert.equal(await d.usage('missing'), null);
  assert.equal(await d.usage('n'), null);
});

test('AcpDriver labels a harness by its id when it has no label', () => {
  const d = new AcpDriver({ list: () => [{ id: 'goose', state: 'ready' }] });
  assert.equal(d.instances()[0].provider.label, 'goose');
});

test('Claude instances with no view or key; driver without an account module', () => {
  assert.deepEqual(claudeInstances(null, null, false), []);
  const [i] = claudeInstances({ active: 'default', accounts: [{ id: 'default', loggedIn: false }] }, undefined, false);
  assert.deepEqual([i.label, i.status, i.active], [null, 'signedOut', true]);
  const d = new ClaudeDriver({ accounts: () => null, keyInfo: () => null, gatewaySet: () => false });
  assert.deepEqual(d.instances(), []);
  assert.deepEqual(d.poolPolicy, { pool: 'single', autoSwitch: true });
  const d2 = new ClaudeDriver({ accounts: () => ({ state: {} }), keyInfo: () => null, gatewaySet: () => false });
  assert.equal(d2.poolPolicy.autoSwitch, true);
});

test('providerFor: an endpoint that is not a URL, and an unknown fallback', () => {
  assert.deepEqual(providerFor('not a url', 'openai'), {
    id: 'custom:not a url',
    label: 'not a url',
    wires: ['responses'],
    baseUrl: 'not a url',
    firstParty: false,
  });
  assert.deepEqual(providerFor('https://gw.example/v1', 'nobody').wires, []);
  assert.equal(providerFor(null, 'nobody'), undefined);
  assert.equal(providerFor('https://api.openai.com/v1', 'openai'), PROVIDERS.openai);
});

test('Registry: an unknown harness has no driver or instances; an unknown id is null', () => {
  const r = new Registry();
  assert.equal(r.driver('codex'), null);
  assert.deepEqual(r.instances('codex'), []);
  assert.equal(r.get('codex:x'), null);
});

test('planName: organization type when there is no subscription; nothing is null', () => {
  assert.equal(planName({ organizationType: 'claude_team' }), 'Team');
  assert.equal(planName(null), null);
  assert.equal(planName({ subscriptionType: 'claude_' }), null);
});

test('claudeInstance: a Console login is pay-per-use; a missing auth method is a subscription', () => {
  assert.equal(claudeInstance({ id: 'a', authMethod: 'console' }, new Map(), 0).billing, 'apiKey');
  assert.equal(claudeInstance({ id: 'a', loggedIn: true }, new Map(), 0).billing, 'subscription');
});

test('decideClaudeSwitch: with no logins listed the default stands alone', () => {
  assert.equal(decideClaudeSwitch({ account: 'default', view: null, marks: new Map(), now: 1 }).action, 'none');
  assert.equal(decideClaudeSwitch({ account: 'default', view: { accounts: [] }, marks: new Map(), now: 1 }).action, 'none');
});

test('decideClaudeSwitch: an existing later hold is kept; the active login, then the one with most left, wins', () => {
  const now = 1000;
  const view = {
    active: 'c',
    accounts: [
      { id: 'a', loggedIn: true, email: 'a@x' },
      { id: 'b', loggedIn: true, email: 'b@x' },
      { id: 'c', loggedIn: true },
      { id: 'd', loggedIn: true, email: 'd@x' },
    ],
  };
  const marks = new Map<string, any>([
    ['a', { limitedUntil: now + 10 * LIMIT_HOLD_MS }],
    ['b', { left: 10 }],
    ['d', { left: 90 }],
  ]);
  const r = decideClaudeSwitch({ account: 'a', view, marks, now });
  assert.equal(r.to, 'c', 'the active login first');
  assert.equal(r.note, 'Usage limit reached on a@x. Continued on another account');
  const r2 = decideClaudeSwitch({ account: 'a', view: { ...view, active: 'zzz' }, marks, now });
  assert.equal(r2.to, 'c', 'unmarked counts as 100% left');
  const r3 = decideClaudeSwitch({ account: 'a', view: { accounts: view.accounts.filter((x) => x.id !== 'c') }, marks, now });
  assert.equal(r3.to, 'd');
  assert.equal(r3.note, 'Usage limit reached on a@x. Continued on d@x');
});

test('decideClaudeSwitch: an account no longer listed still moves on; expired names the login', () => {
  const view = { accounts: [{ id: 'b', loggedIn: true }] };
  const r = decideClaudeSwitch({ account: 'gone', reason: 'expired', view, marks: new Map(), now: 5 });
  assert.equal(r.action, 'switch');
  assert.equal(r.note, 'The account needs to sign in again. Continued on another account');
});

test('withProvider: non-object config and providers are replaced; no params is {}', () => {
  const frag = { modelProvider: 'p', config: { model_providers: { p: { name: 'P' } } } };
  assert.deepEqual(withProvider(null, null), {});
  assert.deepEqual(withProvider({ config: 'x' }, frag), { modelProvider: 'p', config: { model_providers: { p: { name: 'P' } } } });
  assert.deepEqual(withProvider({ config: { model_providers: [1] } }, frag).config.model_providers, { p: { name: 'P' } });
});

function onDarwin(t: any) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', orig));
}

test('CodexProviders: the default helper calls run auth-command with the key on stdin; a failure is null', async (t) => {
  onDarwin(t);
  const calls: any[] = [];
  let fail = false;
  t.mock.method(childProcess, 'execFile', (cmd: string, args: string[], opts: any, cb: any) => {
    const stdin = Object.assign(new EventEmitter(), {
      end: (input: string) => {
        calls.push([cmd, args, opts.timeout, input]);
        stdin.emit('error', new Error('EPIPE'));
        setImmediate(() => cb(fail ? new Error('denied') : null));
      },
    });
    return { stdin };
  });
  const p = new CodexProviders({ command: '/h/auth-command', exists: () => true });
  const f = await p.fragment({ account: 'acc', baseUrl: 'https://gw/v1', key: 'sk-1' });
  assert.equal(f.config.model_providers[f.modelProvider].name, 'MoPilot');
  assert.deepEqual(calls[0], ['/h/auth-command', ['set', KEYCHAIN_SERVICE, 'acc'], 3000, 'sk-1']);
  await p.forget('acc');
  assert.deepEqual(calls[1], ['/h/auth-command', ['delete', KEYCHAIN_SERVICE, 'acc'], 3000, '']);
  fail = true;
  assert.equal(await p.fragment({ account: 'acc2', baseUrl: 'https://gw/v1', key: 'sk-2' }), null);
  await p.forget('acc2'); // erase failing is ignored
});

test('CodexProviders: the default exists check looks at the file system', (t) => {
  onDarwin(t);
  assert.equal(new CodexProviders({ command: '/definitely/not/here/auth-command' }).available, false);
});

test('ClaudeDriver.usage rejects with the reason instead of an empty text; CodexDriver records its failed refresh', async () => {
  const { recentIgnored } = require('../electron/ignored.cjs');
  const d = new ClaudeDriver({
    accounts: () => null,
    keyInfo: () => ({ set: false }),
    gatewaySet: () => false,
    readUsage: async () => {
      throw new Error('claude timed out');
    },
  });
  await assert.rejects(d.usage('default'), /claude timed out/);
  const c = new CodexDriver(
    codexAccounts([{ id: 'g', limits: { five: 2 } }], 'g', {
      refreshUsage: async () => {
        throw new Error('usage offline');
      },
    }),
  );
  assert.deepEqual(await c.usage('g'), { five: 2 });
  assert.ok(
    recentIgnored().some((e: any) => e.context === 'read Codex account usage for the identity view' && e.message === 'usage offline'),
  );
  // providerFor: a value that is not a URL is compared as the host
  assert.equal(providerFor('not a url', 'openai').id, 'custom:not a url');
});
