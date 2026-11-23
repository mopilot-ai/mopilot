// The Chrome administrator's blocked sites for MoPilot's agents (#1632, parity with Claude in Chrome's managed
// blockedUrlPatterns): the extension reads chrome.storage.managed (policy.mjs) and sends it with its handshake
// (client.mjs auth), reconnecting when it changes; main keeps the matchers (chromeExtensionTransport.cjs,
// chromeExtension.cjs policyBlock, chrome-extension/src/adminBlocks.mjs) and Chrome's site table refuses those sites in every chat
// (app/browserSiteTables.cjs), beside Codex's blocks. The in-app browser's table is not the Chrome admin's.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { extensionWorld, fakeChromeApi } from './support/chrome-extension-kit.ts';

const require = createRequire(import.meta.url);
const { adminPatterns, adminBlock } = require('../electron/chrome-extension/src/adminBlocks.mjs');
const { ChromeRelay } = require('../electron/capabilities/browser/chromeRelay.cjs');
const { siteTables } = require('../electron/app/browserSiteTables.cjs');
const appRelay = require('../electron/app/chromeRelay.cjs');
const { readPolicy, MAX_PATTERNS }: any = await import('../electron/chrome-extension/src/policy.mjs');
const { startBackground }: any = await import('../electron/chrome-extension/src/background.mjs');

const stops: (() => void)[] = [];
after(() => {
  for (const s of stops) s();
});

test('adminBlock: host and path patterns, * wildcards, letter case, scheme and www ignored; a bare host is every page', () => {
  const p = adminPatterns({
    blockedUrlPatterns: ['bank.example', 'https://www.GitHub.com/myorg/*', '*.corp.test', 'mail.example/inbox', '', 7, '  '],
  });
  assert.deepEqual(
    p.map((x: any) => x.pattern),
    ['bank.example', 'https://www.GitHub.com/myorg/*', '*.corp.test', 'mail.example/inbox'],
  );
  const why = (u: string) => adminBlock(p, u);
  assert.match(why('https://bank.example/login?x=1')!, /blocked for MoPilot's agents by your browser's administrator \(bank\.example\)/);
  assert.ok(why('http://www.bank.example/'));
  assert.equal(why('https://sub.bank.example/'), null, 'a subdomain needs its own pattern');
  assert.ok(why('https://github.com/MyOrg/repo'));
  assert.equal(why('https://github.com/other/repo'), null);
  assert.ok(why('https://a.corp.test/x'));
  assert.ok(why('https://mail.example/inbox'));
  assert.equal(why('https://mail.example/inbox/1'), null, 'a path pattern is exact unless it ends in *');
  // other schemes, unparseable URLs and no patterns block nothing
  assert.equal(why('chrome://settings'), null);
  assert.equal(why('not a url'), null);
  assert.equal(adminBlock([], 'https://bank.example/'), null);
  assert.equal(adminBlock(undefined, 'https://bank.example/'), null);
  // regex characters in a pattern are literal
  assert.equal(adminBlock(adminPatterns({ blockedUrlPatterns: ['a+b.example'] }), 'https://aab.example/'), null);
  // malformed policies keep none
  assert.deepEqual(adminPatterns(null), []);
  assert.deepEqual(adminPatterns('x'), []);
  assert.deepEqual(adminPatterns({ blockedUrlPatterns: 'x' }), []);
  assert.equal(adminPatterns({ blockedUrlPatterns: Array.from({ length: 600 }, (_, i) => `s${i}.test`) }).length, 500);
});

test('extension policy: managed storage read and cleaned; none when unmanaged', async () => {
  const chrome: any = fakeChromeApi();
  chrome.storage.managed = { get: async () => ({ blockedUrlPatterns: [' bank.example ', 3, '', 'x'.repeat(600)] }) };
  const got = await readPolicy(chrome);
  assert.deepEqual(got.blockedUrlPatterns.slice(0, 1), ['bank.example']);
  assert.equal(got.blockedUrlPatterns[1].length, 500);
  chrome.storage.managed = { get: async () => ({ blockedUrlPatterns: Array.from({ length: 600 }, () => 'a') }) };
  assert.equal((await readPolicy(chrome)).blockedUrlPatterns.length, MAX_PATTERNS);
  chrome.storage.managed = { get: async () => ({}) };
  assert.deepEqual(await readPolicy(chrome), { blockedUrlPatterns: [] });
  chrome.storage.managed = {
    get: async () => {
      throw new Error('managed storage is not available');
    },
  };
  assert.deepEqual(await readPolicy(chrome), { blockedUrlPatterns: [] });
});

test('extension and app: the policy rides the handshake, holds after the connection goes, and the Playwright relay has none', async () => {
  const w = await extensionWorld({ paired: false });
  stops.push(w.stop);
  w.client.o.policy = async () => ({ blockedUrlPatterns: ['bank.example'] });
  w.setCode(`mopilot-chrome:1:${w.port}:${w.pairing.get().secret}`);
  w.pairing.markPaired();
  await w.connectExtension();
  assert.match(w.channel.policyBlock('https://bank.example/pay'), /administrator/);
  assert.equal(w.channel.policyBlock('https://ok.example/'), null);
  // the connection goes: the blocks hold until the next one says otherwise
  w.channel.peer.close(1000, 'bye');
  assert.match(w.channel.policyBlock('https://bank.example/pay'), /administrator/);
  // a peer that carried none (an older extension) clears them
  (w.channel as any).adminPatterns = [];
  assert.equal(new ChromeRelay({ openPage: () => undefined }).policyBlock('https://bank.example/'), null);
  // the app passes it on for Chrome's site table
  const r = appRelay.setupChromeRelay({
    registry: { register: () => () => undefined },
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => true,
  });
  assert.equal(r.policyBlock('https://bank.example/'), null);
  r.stop();
});

test('extension background: a managed policy change reconnects; other storage changes do not', async () => {
  const chrome: any = fakeChromeApi();
  const g = { chrome, WebSocket: class {}, crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval };
  const warn = mock.method(console, 'warn', () => undefined);
  const bg = startBackground(g);
  stops.push(() => bg.client.dispose());
  await bg.ready;
  const reset = mock.method(bg.client, 'reset', async () => undefined);
  chrome.storage.onChanged.fire({ pairing: {} }, 'local');
  assert.equal(reset.mock.callCount(), 0);
  chrome.storage.onChanged.fire({ blockedUrlPatterns: {} }, 'managed');
  assert.equal(reset.mock.callCount(), 1);
  // the client reads the policy through managed storage
  chrome.storage.managed = { get: async () => ({ blockedUrlPatterns: ['x.test'] }) };
  assert.deepEqual(await bg.client.o.policy(), { blockedUrlPatterns: ['x.test'] });
  warn.mock.restore();
});

test("Chrome's site table refuses the administrator's sites in every chat; the in-app browser's does not", () => {
  const live: any = {
    sessions: new Map([['c1', { permission: 'default', activeTurn: { id: 't' } }]]),
    controller: { ref: () => ({ kind: 'claude', id: 's' }), adapterOf: () => ({}) },
    codexSiteBlocks: { reason: (url: string) => (url.includes('codex-blocked') ? 'blocked for Codex' : null) },
    chromeRelay: { policyBlock: (url: string) => (url.includes('bank') ? 'blocked by your administrator' : null) },
    computerUse: { broker: { ask: async () => ({ decision: 'deny' }) } },
  };
  const t = siteTables({ live, dir: '/tmp/none', prefs: () => ({}), isFlagEnabled: () => false });
  assert.equal(t.chromeGrants.externalBlock('https://bank.example/'), 'blocked by your administrator');
  assert.equal(t.chromeGrants.externalBlock('https://codex-blocked.example/'), 'blocked for Codex');
  assert.equal(t.chromeGrants.externalBlock('https://ok.example/'), null);
  assert.equal(t.browserGrants.externalBlock('https://bank.example/'), null);
  // no Chrome channel set up: nothing more is blocked
  delete live.chromeRelay;
  assert.equal(t.chromeGrants.externalBlock('https://bank.example/'), null);
});
