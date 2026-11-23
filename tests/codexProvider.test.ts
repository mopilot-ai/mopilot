// electron/identity/contract/codexProvider.cjs and native/auth-command: a thread's own model provider on
// thread/start (D-72, D-32), its key read by auth.command from the keychain, never from the config.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import edition from '../shared/edition.json' with { type: 'json' };
import { buildAuthCommand } from '../scripts/build-auth-command.mjs';

const require = createRequire(import.meta.url);
const {
  CodexProviders,
  KEYCHAIN_SERVICE,
  authCommandPath,
  providerId,
  providerFragment,
  withProvider,
} = require('../electron/identity/contract/codexProvider.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');

const input = { account: 'mopilot', baseUrl: 'https://api.example.test/v1', name: 'MoPilot', key: 'sk-test-not-a-secret' };

test('auth-command path: Contents/Helpers when packaged, native/auth-command/build in a checkout', () => {
  assert.equal(KEYCHAIN_SERVICE, `${edition.desktop.appId}.codex-provider`);
  assert.equal(authCommandPath({ packaged: true, resourcesPath: '/A.app/Contents/Resources' }), '/A.app/Contents/Helpers/auth-command');
  assert.equal(authCommandPath({ repoRoot: '/repo' }), '/repo/native/auth-command/build/auth-command');
});

test('the fragment names the provider and its auth.command; the key is not in it', () => {
  const f = providerFragment({ id: 'sage_x', name: 'MoPilot', baseUrl: input.baseUrl, command: '/H/auth-command', account: 'mopilot' });
  assert.deepEqual(f, {
    modelProvider: 'sage_x',
    config: {
      model_providers: {
        sage_x: {
          name: 'MoPilot',
          base_url: input.baseUrl,
          wire_api: 'responses',
          auth: { command: '/H/auth-command', args: ['get', KEYCHAIN_SERVICE, 'mopilot'] },
        },
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(f), /sk-test/);
  assert.match(providerId(input.baseUrl), /^sage_[0-9a-f]{10}$/);
  assert.notEqual(providerId(input.baseUrl), providerId('https://other.test/v1'));
  // one id per key: two keys on one endpoint never share a provider (#2213)
  assert.notEqual(providerId(input.baseUrl, 'a'), providerId(input.baseUrl, 'b'));
});

test('withProvider keeps the config a window sends and a provider it chose itself', () => {
  const f = providerFragment({ id: 'sage_x', name: 'N', baseUrl: 'u', command: 'c', account: 'a' });
  const out = withProvider({ cwd: '/w', config: { model: 'm', model_providers: { mine: { name: 'x' } } } }, f);
  assert.equal(out.modelProvider, 'sage_x');
  assert.deepEqual(Object.keys(out.config.model_providers).sort(), ['mine', 'sage_x']);
  assert.equal(out.config.model, 'm');
  const own = { modelProvider: 'openai' };
  assert.equal(withProvider(own, f), own);
  assert.deepEqual(withProvider({ cwd: '/w' }, null), { cwd: '/w' });
});

test('the key is stored once per key, and a failed store means no provider', { skip: process.platform !== 'darwin' }, async () => {
  const calls: string[][] = [];
  const p = new CodexProviders({
    command: '/H/auth-command',
    exists: () => true,
    store: async (s: string, a: string, k: string) => void calls.push([s, a, k]),
  });
  await p.sync(input);
  await p.sync(input);
  assert.deepEqual(calls, [[KEYCHAIN_SERVICE, 'mopilot', input.key]]);
  assert.equal(p.current().modelProvider, providerId(input.baseUrl, input.account));
  await p.sync({ ...input, key: 'sk-test-rotated' });
  assert.equal(calls.length, 2);
  await p.sync(null);
  assert.equal(p.current(), null);
  const bad = new CodexProviders({ command: '/H/auth-command', exists: () => true, store: async () => Promise.reject(new Error('no')) });
  await bad.sync(input);
  assert.equal(bad.current(), null);
  assert.equal(await new CodexProviders({ command: '/missing', exists: () => false }).fragment(input), null);
});

test('the provider fragment names the auth command, and the tools injection leaves the provider alone', () => {
  const f = providerFragment({ id: 'sage_x', name: 'N', baseUrl: 'u', command: 'c', account: 'a' });
  assert.ok(withProvider({ cwd: '/w' }, f).config.model_providers.sage_x.auth.command);
  const inj = new CodexToolInjection({ sessions: new ToolSessions(), command: '/bin/sage-mcp', socketPath: '/s', harnessPid: () => 1 });
  const start = inj.outgoing({ id: 1, method: 'thread/start', params: { cwd: '/w' } });
  assert.equal(start.params.modelProvider, undefined);
  assert.equal(Object.keys(start.params.config.mcp_servers).length, 1);
});

test('forget deletes the account key from the keychain and the once-per-key cache', { skip: process.platform !== 'darwin' }, async () => {
  const stored: string[][] = [];
  const erased: string[][] = [];
  const p = new CodexProviders({
    command: '/H/auth-command',
    exists: () => true,
    store: async (s: string, a: string, k: string) => void stored.push([a, k]),
    erase: async (s: string, a: string) => void erased.push([s, a]),
  });
  await p.sync(input);
  await p.forget('mopilot');
  assert.deepEqual(erased, [[KEYCHAIN_SERVICE, 'mopilot']]);
  // the same key is stored again afterwards
  await p.sync(input);
  assert.equal(stored.length, 2);
  // a failing delete is not an error
  const bad = new CodexProviders({ command: '/H/auth-command', exists: () => true, erase: async () => Promise.reject(new Error('no')) });
  await bad.forget('x');
});

// the real helper, in this machine's keychain under a service of its own
const real = process.platform === 'darwin' && spawnSync('swift', ['--version']).status === 0;
let exe = '';
const service = `ai.mopilot.code.test-${process.pid}`;
const auth = (mode: string, account: string, stdin?: string) =>
  spawnSync(exe, [mode, service, account], { input: stdin, encoding: 'utf8', timeout: 5000 });
before(() => {
  if (real) exe = buildAuthCommand({ out: `${process.env.TMPDIR || '/tmp'}/auth-command-test-${process.pid}`, debug: true, log: () => {} });
});
after(() => {
  if (real) auth('delete', 'acct');
});

test('auth-command stores, prints and deletes a key; fails fast without one', { skip: !real }, () => {
  assert.equal(auth('set', 'acct', 'sk-test-not-a-secret\n').status, 0);
  const t0 = Date.now();
  const got = auth('get', 'acct');
  assert.equal(got.status, 0);
  assert.equal(got.stdout, 'sk-test-not-a-secret\n');
  assert.ok(Date.now() - t0 < 1000, `get took ${Date.now() - t0}ms`);
  assert.equal(auth('delete', 'acct').status, 0);
  const t1 = Date.now();
  const none = auth('get', 'acct');
  assert.equal(none.status, 1);
  assert.equal(none.stdout, '');
  assert.ok(Date.now() - t1 < 1000);
  assert.equal(spawnSync(exe, ['get'], { encoding: 'utf8' }).status, 1);
});

test('an older sync that finishes last does not replace the newer one; a failed sync leaves no provider', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { recentIgnored } = require('../electron/ignored.cjs');
  let release: () => void = () => {};
  const p = new CodexProviders({
    command: '/H/auth-command',
    exists: () => true,
    store: (_s: string, a: string) => (a === 'slow' ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
  });
  // account A's key is still being stored when the user moves to an account without a provider
  const slow = p.sync({ ...input, account: 'slow' });
  await p.sync(null);
  release();
  await slow;
  assert.equal(p.current(), null, "the old account's provider does not come back");
  // and the other way round: the newer provider stays
  const slow2 = p.sync({ ...input, account: 'slow' });
  await p.sync(input);
  release();
  await slow2;
  assert.equal(p.current().config.model_providers[providerId(input.baseUrl, input.account)].auth.args.at(-1), 'mopilot');
  // a sync that throws does not leave the previous account's provider in place
  p.fragment = async () => {
    throw new Error('helper crashed');
  };
  await assert.rejects(p.sync(input), /helper crashed/);
  assert.equal(p.current(), null);
  // a key that can't be stored is recorded
  const bad = new CodexProviders({
    command: '/H/auth-command',
    exists: () => true,
    store: async () => Promise.reject(new Error('keychain locked')),
  });
  await bad.sync(input);
  assert.ok(
    recentIgnored().some((e: any) => e.context === 'store a Codex account key for its provider' && e.message === 'keychain locked'),
  );
});
