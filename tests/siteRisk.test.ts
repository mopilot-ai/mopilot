// Site risk classes for the in-app browser (electron/capabilities/browser/siteRisk.cjs, IAB-03): the
// offline classifier and its data file, the sensitive-action classifier, the optional remote check,
// and how OriginGrants (origins.cjs) applies them to site approval and per-action confirmation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const risk = require('../electron/capabilities/browser/siteRisk.cjs');
const {
  SiteRisk,
  classify,
  categoryOf,
  isPrivateHost,
  isLoopbackHost,
  riskNote,
  sensitiveAction,
  sensitiveByName,
  needsIntent,
  typesText,
  typesKeys,
  submitsKeys,
  kindOfName,
  hostHashes,
  remoteLookup,
  compile,
  CATEGORIES,
  VERBS,
} = risk;
const DATA = require('../electron/capabilities/browser/siteRisk.json');
const { OriginGrants, riskView } = require('../electron/capabilities/browser/origins.cjs');

const level = (url: string) => classify(url).level;
const category = (url: string) => classify(url).category;

// ---------------------------------------------------------------- the data file

test('the data file: every category it names is a known high-risk one, and its patterns compile', () => {
  const known = new Set(Object.keys(CATEGORIES));
  for (const c of Object.values(DATA.domains)) assert.ok(known.has(c as string), String(c));
  for (const p of DATA.pages) assert.ok(known.has(p.category) && p.path.startsWith('/'), p.host);
  for (const k of DATA.keywords) {
    assert.ok(known.has(k.category));
    new RegExp(k.host);
    if (k.path) new RegExp(k.path);
  }
  for (const s of DATA.blockedSchemes) assert.match(s, /^[a-z-]+:$/);
  // a custom data file: unknown categories and the blocked-only ones never become high-risk entries
  const lists = compile({
    domains: { 'ok.test': 'banking', 'bad.test': 'nonsense', 'meta.test': 'cloud_metadata' },
    pages: [{ host: 'p.test', path: '/x', category: 'nope' }],
    keywords: [
      { host: 'zzz', category: 'nope' },
      { host: '^vault\\.', category: 'password_manager' },
    ],
  });
  assert.deepEqual([...lists.domains.keys()], ['ok.test']);
  assert.deepEqual(
    [lists.pages.length, lists.keywords.length, lists.blockedHosts.size, lists.blockedSchemes.size, lists.privateSuffixes.length],
    [0, 1, 0, 0, 0],
  );
  assert.equal(categoryOf('vault.example.org', '/', lists), 'password_manager');
  assert.equal(categoryOf('bad.test', '/', lists), null);
  const empty = compile({});
  assert.deepEqual([empty.domains.size, empty.pages.length, empty.keywords.length], [0, 0, 0]);
});

// ---------------------------------------------------------------- classify

test('classify: blocked - cloud metadata endpoints (any spelling of the address), local files and browser internals', () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://2852039166/',
    'http://0xa9fea9fe/',
    'http://[::ffff:169.254.169.254]/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://METADATA.goog./',
    'http://[fd00:ec2::254]/',
    'http://100.100.100.200/',
    'http://169.254.170.2/v2/credentials',
  ]) {
    assert.deepEqual([level(url), category(url)], ['blocked', 'cloud_metadata'], url);
  }
  assert.deepEqual([level('file:///etc/passwd'), category('file:///etc/passwd')], ['blocked', 'file']);
  for (const url of [
    'chrome://settings',
    'chrome-extension://abc/page.html',
    'devtools://devtools/bundled/inspector.html',
    'view-source:https://a.test/',
    'chrome-untrusted://x/',
  ])
    assert.deepEqual([level(url), category(url)], ['blocked', 'browser_internal'], url);
  const r = classify('http://169.254.169.254/');
  assert.equal(r.label, 'Cloud metadata endpoint');
  assert.match(r.explanation, /never open it/);
  assert.equal(r.financial, false);
});

test('classify: normal - ordinary sites, loopback servers, about:blank, other schemes and unparsable text', () => {
  for (const url of [
    'https://example.com/',
    'https://news.test/a',
    'http://localhost:3000/',
    'http://app.localhost/',
    'http://127.0.0.1:8080/',
    'http://[::1]:5173/',
    'about:blank',
    'data:text/html,hi',
    'not a url',
    '',
  ])
    assert.equal(level(url), 'normal', url);
  assert.deepEqual(classify('not a url'), {
    level: 'normal',
    category: null,
    label: '',
    explanation: '',
    financial: false,
    credentials: false,
    host: '',
  });
  assert.equal(classify('https://Example.COM./x').host, 'example.com');
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('localhost.example.com'), false);
});

test('classify: the private network is high risk - RFC 1918, link-local, CGNAT, unique-local IPv6 and non-public names', () => {
  for (const url of [
    'http://10.0.0.1/',
    'http://172.16.4.2/',
    'http://172.31.255.1/',
    'http://192.168.1.1/admin',
    'http://169.254.10.10/',
    'http://100.64.0.1/',
    'http://0.0.0.0:8000/',
    'http://[fd12:3456::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://router/',
    'http://nas.local/',
    'http://wiki.corp/',
    'http://printer.home.arpa/',
    'http://[::ffff:c0a8:0101]/',
  ]) {
    assert.deepEqual([level(url), category(url)], ['high', 'private_network'], url);
  }
  for (const url of [
    'http://172.15.0.1/',
    'http://172.32.0.1/',
    'http://192.169.1.1/',
    'http://100.128.0.1/',
    'http://8.8.8.8/',
    'http://[2001:db8::1]/',
    'http://[fe00::1]/',
  ])
    assert.equal(level(url), 'normal', url);
  assert.equal(isPrivateHost('intranet'), true);
  assert.match(classify('http://10.0.0.1/').explanation, /service on your network/);
});

test('classify: high-risk sites from the curated list, page paths and keyword heuristics, with the financial warning', () => {
  const cases: [string, string][] = [
    ['https://www.chase.com/', 'banking'],
    ['https://secure.bankofamerica.com/login', 'banking'],
    ['https://www.fidelity.com/', 'brokerage'],
    ['https://www.coinbase.com/', 'crypto'],
    ['https://www.paypal.com/myaccount', 'payments'],
    ['https://dashboard.stripe.com/payments', 'payments'],
    ['https://login.gov/', 'government_id'],
    ['https://vault.bitwarden.com/', 'password_manager'],
    ['https://appleid.apple.com/account/manage', 'account_security'],
    ['https://myaccount.google.com/security', 'account_security'],
    ['https://github.com/settings/security', 'account_security'],
    // keywords
    ['https://www.firstcountybank.com/', 'banking'],
    ['https://onlinebanking.example.org/', 'banking'],
    ['https://www.lakesidecreditunion.org/', 'banking'],
    ['https://acme-securities.com/', 'brokerage'],
    ['https://accounts.example.com/security/2fa', 'account_security'],
    ['https://www.dmv.ca.gov/portal/login', 'government_id'],
    ['https://example.gc.ca/en/sign-in', 'government_id'],
  ];
  for (const [url, c] of cases) assert.deepEqual([level(url), category(url)], ['high', c], url);
  // not every page of a site, and not every look-alike
  for (const url of [
    'https://myaccount.google.com/',
    'https://github.com/settings/profile',
    'https://www.bankrate.com/',
    'https://accounts.example.com/profile',
    'https://www.ca.gov/',
    'https://notchase.com/',
  ])
    assert.equal(level(url), 'normal', url);
  const bank = classify('https://www.chase.com/');
  assert.equal(bank.financial, true);
  assert.equal(bank.label, 'Banking site');
  assert.match(bank.explanation, /won't pay, transfer or trade/);
  const pw = classify('https://1password.com/');
  assert.equal(pw.financial, false);
  assert.match(pw.explanation, /saved passwords/);
});

test('classify: a user name or password in the address carries the credentials warning', () => {
  const r = classify('https://user:secret@example.com/');
  assert.deepEqual([r.level, r.credentials, r.label], ['normal', true, 'Sign-in details in the address']);
  assert.match(r.explanation, /Asks every time/);
  assert.equal(classify('https://user@example.com/').credentials, true);
  // a risky site keeps its own class and label, with the warning flag
  const both = classify('https://a:b@www.chase.com/');
  assert.deepEqual([both.level, both.category, both.credentials], ['high', 'banking', true]);
});

test('riskNote: what the model is told about a site', () => {
  assert.equal(riskNote(null), '');
  assert.equal(riskNote(classify('https://example.com/')), '');
  assert.equal(riskNote(classify('file:///x')), "Local file: agents can't open or use it.");
  assert.match(riskNote(classify('https://www.chase.com/')), /^Banking site: high risk\..*Never transfer funds/);
  assert.doesNotMatch(riskNote(classify('https://1password.com/')), /transfer/);
  assert.equal(riskNote(classify('https://u:p@example.com/')), 'Sign-in details in the address.');
});

// ---------------------------------------------------------------- sensitive actions

const button = (name: string, o: any = {}) => ({
  tag: 'button',
  type: '',
  role: 'button',
  name,
  button: true,
  submits: false,
  editable: false,
  secret: false,
  payment: false,
  form: null,
  ...o,
});

test('kindOfName and sensitiveByName: deletes, transfers, purchases, messages and password changes by what a button says', () => {
  const kinds: [string, string | null][] = [
    ['Delete repository', 'delete'],
    ['Remove', 'delete'],
    ['Close my account', 'delete'],
    ['Cancel subscription', 'delete'],
    ['Transfer $500', 'transfer'],
    ['Sell shares', 'transfer'],
    ['Place order', 'purchase'],
    ['Buy now', 'purchase'],
    ['Pay', 'purchase'],
    ['Send', 'send_message'],
    ['Post reply', 'send_message'],
    ['Change password', 'password_change'],
    ['Resend', null],
    ['Search', null],
    ['', null],
  ];
  for (const [name, kind] of kinds) assert.equal(kindOfName(name), kind, name);
  assert.equal(kindOfName(undefined), null);
  assert.deepEqual(sensitiveByName('  Delete\n file '), { kind: 'delete', verb: VERBS.delete, detail: 'Delete file' });
  // a purchase-class name that only subscribes, donates or books says so; one that pays keeps the purchase wording
  for (const [name, verb] of [
    ['Subscribe', 'subscribe or start a plan'],
    ['Start free trial', 'subscribe or start a plan'],
    ['Upgrade now', 'subscribe or start a plan'],
    ['Donate', 'donate'],
    ['Book now', 'book or reserve'],
    ['Reserve a table', 'book or reserve'],
    ['Subscribe and pay', VERBS.purchase],
    ['Place order', VERBS.purchase],
  ] as const)
    assert.equal(sensitiveByName(name)!.verb, verb, name);
  assert.equal(sensitiveByName('Next'), null);
  assert.equal(sensitiveByName(''), null);
});

test('keys: which sequences type text and which submit', () => {
  assert.equal(typesKeys('a'), true);
  assert.equal(typesKeys('shift+A'), true);
  assert.equal(typesKeys('alt+e'), true);
  assert.equal(typesKeys('space'), true);
  assert.equal(typesKeys('+'), true);
  assert.equal(typesKeys('ctrl+a'), false);
  assert.equal(typesKeys('cmd+v Enter'), false);
  assert.equal(typesKeys('Tab Backspace ArrowLeft'), false);
  assert.equal(typesKeys(''), false);
  assert.equal(typesKeys(undefined), false);
  assert.equal(submitsKeys('Enter'), true);
  assert.equal(submitsKeys('ctrl+Return'), true);
  assert.equal(submitsKeys('Tab'), false);
  assert.equal(submitsKeys(undefined), false);
  assert.equal(submitsKeys('+'), false);
  assert.equal(needsIntent(null), false);
  assert.equal(needsIntent({ kind: 'click' }), true);
  assert.equal(needsIntent({ kind: 'type' }), true);
  assert.equal(needsIntent({ kind: 'fill' }), true);
  assert.equal(needsIntent({ kind: 'key', keys: 'Enter' }), true);
  assert.equal(needsIntent({ kind: 'key', keys: 'x' }), true);
  assert.equal(needsIntent({ kind: 'key', keys: 'Tab' }), false);
  assert.equal(needsIntent({ kind: 'drag' }), false);
  assert.equal(typesText({ kind: 'type' }), true);
  assert.equal(typesText({ kind: 'fill' }), true);
  assert.equal(typesText({ kind: 'key', keys: 'a' }), true);
  assert.equal(typesText({ kind: 'key', keys: 'Enter' }), false);
  assert.equal(typesText({ kind: 'click' }), false);
});

test('sensitiveAction: clicks on sensitive buttons and form submits, Enter in a form, payment entry and accepted dialogs', () => {
  const click = { kind: 'click' };
  assert.deepEqual(sensitiveAction(button('Delete branch'), click), { kind: 'delete', verb: 'delete something', detail: 'Delete branch' });
  // a submit button named plainly: what its form holds decides
  assert.equal(
    sensitiveAction(
      button('Continue', { submits: true, form: { secrets: 0, newPassword: false, payment: true, submit: 'Continue' } }),
      click,
    ).kind,
    'payment',
  );
  assert.equal(
    sensitiveAction(button('Save', { submits: true, form: { secrets: 0, newPassword: true, payment: false, submit: 'Save' } }), click).kind,
    'password_change',
  );
  assert.equal(
    sensitiveAction(button('Save', { submits: true, form: { secrets: 2, newPassword: false, payment: false, submit: 'Save' } }), click)
      .kind,
    'password_change',
  );
  assert.equal(
    sensitiveAction(button('Go', { submits: true, form: { secrets: 1, newPassword: false, payment: false, submit: 'Go' } }), click),
    null,
    'signing in is not sensitive',
  );
  assert.equal(sensitiveAction(button('Go', { submits: true, form: null }), click), null);
  assert.equal(
    sensitiveAction(button('', { submits: true, form: { secrets: 0, newPassword: false, payment: true, submit: '' } }), click).detail,
    '',
  );
  assert.equal(sensitiveAction(button('Next'), click), null);
  // not a button: a text field click is nothing
  assert.equal(sensitiveAction({ ...button('Delete'), button: false }, click), null);
  // Enter in a field submits its form, or a chat composer's Send
  const field = {
    tag: 'textarea',
    role: 'textbox',
    name: 'Message',
    button: false,
    submits: false,
    editable: true,
    secret: false,
    payment: false,
    form: { secrets: 0, newPassword: false, payment: false, submit: 'Send' },
  };
  assert.deepEqual(sensitiveAction(field, { kind: 'key', keys: 'Enter' }), {
    kind: 'send_message',
    verb: 'send a message',
    detail: 'Send',
  });
  assert.equal(sensitiveAction({ ...field, form: { ...field.form, submit: '' } }, { kind: 'key', keys: 'Enter' }), null);
  assert.equal(sensitiveAction({ ...field, form: null }, { kind: 'key', keys: 'Enter' }), null);
  assert.equal(sensitiveAction({ ...field, editable: false }, { kind: 'key', keys: 'Enter' }), null);
  assert.equal(sensitiveAction(field, { kind: 'key', keys: 'Tab' }), null);
  // typing card details
  const card = { ...field, tag: 'input', name: 'Card number', payment: true, form: null };
  assert.deepEqual(sensitiveAction(card, { kind: 'type' }), {
    kind: 'payment_entry',
    verb: 'enter payment details',
    detail: 'Card number',
  });
  assert.equal(sensitiveAction({ ...card, name: '' }, { kind: 'fill' }).detail, '');
  assert.equal(sensitiveAction(card, { kind: 'key', keys: 'Tab' }), null);
  assert.equal(sensitiveAction(field, { kind: 'type' }), null);
  // dialogs: accepting a "delete?" confirm is sensitive, dismissing never
  assert.deepEqual(sensitiveAction(null, { kind: 'dialog', accept: true, message: 'Delete 3 files permanently?' }), {
    kind: 'delete',
    verb: 'delete something',
    detail: 'Delete 3 files permanently?',
  });
  assert.equal(sensitiveAction(null, { kind: 'dialog', accept: false, message: 'Delete?' }), null);
  assert.equal(sensitiveAction(null, { kind: 'dialog', accept: true }), null);
  // nothing known about the element
  assert.equal(sensitiveAction(null, click), null);
  assert.equal(sensitiveAction({ frame: true }, click), null);
});

// ---------------------------------------------------------------- the remote check

test('hostHashes: the host and each parent domain with two labels or more', () => {
  const h = hostHashes('a.b.example.com');
  assert.equal(h.length, 3);
  assert.ok(h.every((x: string) => /^[0-9a-f]{64}$/.test(x)));
  assert.deepEqual(hostHashes('example.com'), hostHashes('x.example.com').slice(1));
  assert.deepEqual(hostHashes('router'), []);
});

test('remoteLookup: sends hash prefixes only and matches full hashes locally', async () => {
  const sent: any[] = [];
  const hashes = hostHashes('shop.evil.test');
  let body: any = { matches: [{ hash: hashes[1], category: 'crypto' }] };
  let ok = true;
  const fetch = async (url: string, init: any) => {
    sent.push([url, JSON.parse(init.body), init.method]);
    return { ok, status: ok ? 200 : 503, json: async () => body };
  };
  const lookup = remoteLookup({ endpoint: 'https://risk.test/check', fetch });
  assert.equal(await lookup(hashes), 'crypto');
  assert.deepEqual(sent[0], ['https://risk.test/check', { prefixes: hashes.map((x: string) => x.slice(0, 8)) }, 'POST']);
  // a prefix collision with another full hash, an unknown category, a malformed body: nothing
  body = { matches: [{ hash: 'f'.repeat(64), category: 'banking' }, { hash: hashes[0], category: 'cloud_metadata' }, null] };
  assert.equal(await lookup(hashes), null);
  body = {};
  assert.equal(await lookup(hashes), null);
  body = null;
  assert.equal(await lookup(hashes), null);
  ok = false;
  await assert.rejects(lookup(hashes), /503/);
  // the default fetch is the global one
  assert.equal(typeof remoteLookup({ endpoint: 'https://risk.test/' }), 'function');
});

test('SiteRisk: offline by default; with the remote check on, an unknown host it flags becomes high risk (cached)', async () => {
  const local = new SiteRisk();
  assert.equal((await local.assess('https://shop.evil.test/')).level, 'normal');
  assert.equal(local.classify('https://www.chase.com/').level, 'high');
  // a remote lookup is wired but its switch (default off) keeps it unused
  let called = 0;
  const off = new SiteRisk({ remote: async () => (++called, 'banking') });
  assert.equal((await off.assess('https://shop.evil.test/')).level, 'normal');
  assert.equal(called, 0);

  let on = false;
  const asked: string[][] = [];
  let answer: any = 'payments';
  let fail: any = null;
  const r = new SiteRisk({
    data: DATA,
    remote: async (h: string[]) => {
      asked.push(h);
      if (fail) throw fail;
      return answer;
    },
    remoteEnabled: () => on,
    timeoutMs: 50,
  });
  assert.equal((await r.assess('https://shop.evil.test/')).level, 'normal', 'the switch is off');
  assert.equal(asked.length, 0);
  on = true;
  // known locally, or not a web host: never asked
  assert.equal((await r.assess('https://www.chase.com/')).category, 'banking');
  assert.equal((await r.assess('about:blank')).level, 'normal');
  assert.equal(asked.length, 0);
  const flagged = await r.assess('https://user:pw@shop.evil.test/pay');
  assert.deepEqual([flagged.level, flagged.category, flagged.financial, flagged.credentials], ['high', 'payments', true, true]);
  assert.equal(asked.length, 1);
  // cached: classify sees it, assess doesn't ask again
  assert.equal(r.classify('https://shop.evil.test/').level, 'high');
  await r.assess('https://shop.evil.test/again');
  assert.equal(asked.length, 1);
  // an unknown answer is cached as nothing
  answer = 'whatever';
  assert.equal((await r.assess('https://fine.test/')).level, 'normal');
  assert.equal(r.cache.get('fine.test'), null);
  // a failure or a slow answer stays local and is asked again next time
  fail = new Error('offline');
  assert.equal((await r.assess('https://later.test/')).level, 'normal');
  assert.equal(r.cache.has('later.test'), false);
  fail = null;
  r.remote = () => new Promise(() => {});
  assert.equal((await r.assess('https://slow.test/')).level, 'normal');
  assert.equal(r.cache.has('slow.test'), false);
  // the cache is bounded
  r.remote = async () => null;
  r.cache.clear();
  for (let i = 0; i < 5000; i++) r.cache.set(`h${i}.test`, null);
  await r.assess('https://newest.test/');
  assert.equal(r.cache.size, 5000);
  assert.equal(r.cache.has('h0.test'), false);
  assert.equal(r.cache.has('newest.test'), true);
});

// ---------------------------------------------------------------- OriginGrants

const ctx = { chatId: 'c1', segmentId: 's1' };

test('OriginGrants: a blocked URL is refused everywhere, Full access included', async () => {
  let asks = 0;
  for (const anchor of ['ask', 'full']) {
    const g = new OriginGrants({ anchor: () => anchor, ask: async () => (++asks, { decision: 'allow', scope: 'always', level: 'write' }) });
    assert.equal(g.peek('http://169.254.169.254/latest/', 'read', ctx), 'blocked');
    assert.equal(g.peek('chrome://settings', 'read', ctx), 'blocked');
    await assert.rejects(
      g.require('http://user:pw@169.254.169.254/latest/', 'read', ctx),
      (e: any) =>
        e.code === 'blocked' &&
        /^Cloud metadata endpoint: agents can't open or use it\. http:\/\/169\.254\.169\.254\/latest\/$/.test(e.message),
    );
    await assert.rejects(g.act('http://metadata.google.internal/', ctx, { tool: 'click' }), { code: 'blocked' });
  }
  assert.equal(asks, 0);
});

test('OriginGrants: Full access does not cover a high-risk site; the card says why and may save it for good (#5464)', async () => {
  const asked: any[] = [];
  let answer: any = { decision: 'allow', scope: 'always', level: 'write' };
  let anchor = 'full';
  const g = new OriginGrants({ anchor: () => anchor, ask: async (q: any) => (asked.push(q), answer) });
  assert.equal(g.peek('https://www.chase.com/x', 'read', ctx), 'ask');
  await g.require('https://www.chase.com/accounts', 'read', ctx, { offer: 'write', localAlways: false });
  const q = asked.pop();
  assert.equal(q.allowAlways, undefined);
  assert.equal(q.need, 'write');
  assert.deepEqual(q.risk, riskView(classify('https://www.chase.com/')));
  assert.equal(q.risk.financial, true);
  // "always" saves it: this chat and the next go without a card
  assert.equal(g.get('https://www.chase.com'), 'write');
  assert.equal(g.peek('https://www.chase.com/x', 'write', ctx), 'ok');
  assert.equal(g.peek('https://www.chase.com/x', 'read', { ...ctx, chatId: 'c2' }), 'ok');
  // read-only chats still refuse writes first
  anchor = 'readOnly';
  assert.equal(g.peek('https://www.chase.com/x', 'write', ctx), 'read_only');
  // "once": nothing kept, the next read asks again
  anchor = 'ask';
  answer = { decision: 'allow', scope: 'once', level: 'read' };
  await g.require('http://192.168.1.1/', 'read', ctx);
  assert.equal(asked.pop().risk.category, 'private_network');
  assert.equal(g.peek('http://192.168.1.1/', 'read', ctx), 'ask');
  // an ordinary site with Full access: no card, as before
  anchor = 'full';
  await g.require('https://example.com/', 'write', ctx);
  assert.equal(asked.length, 0);
});

test('OriginGrants: an address with a user name or password asks every time, never for good', async () => {
  const asked: any[] = [];
  let answer: any = { decision: 'allow', scope: 'always', level: 'read' };
  let anchor = 'full';
  const g = new OriginGrants({ anchor: () => anchor, ask: async (q: any) => (asked.push(q), answer) });
  await g.require('https://bob:hunter2@example.com/', 'read', ctx);
  await g.require('https://bob:hunter2@example.com/', 'read', ctx);
  assert.equal(asked.length, 2);
  assert.equal(asked[0].allowAlways, false);
  assert.equal(asked[0].risk.credentials, true);
  assert.equal(g.get('https://example.com'), null);
  // the same site without credentials: the chat grant from those answers covers it
  anchor = 'ask';
  await g.require('https://example.com/', 'read', ctx);
  assert.equal(asked.length, 2);
  // a denial in this chat stands
  answer = { decision: 'deny' };
  await assert.rejects(g.require('https://x:y@other.test/', 'read', ctx), { code: 'denied' });
  await assert.rejects(g.require('https://x:y@other.test/', 'read', ctx), { code: 'denied' });
  assert.equal(asked.length, 3);
});

test('OriginGrants.act: high-risk sites, and sensitive actions Full access does not cover, ask each time; others pass', async () => {
  const confirms: any[] = [];
  let ok: any = true;
  const g = new OriginGrants({ anchor: () => 'full', ask: async () => null, confirmAction: async (q: any) => (confirms.push(q), ok) });
  // false: no card was needed; true: the user was asked (and said yes)
  assert.equal(await g.act('https://example.com/', ctx, { tool: 'click', summary: 'click "Next"' }), false);
  await g.act('https://example.com/', ctx);
  assert.equal(confirms.length, 0);
  assert.equal(await g.act('https://www.chase.com/', ctx, { tool: 'click', summary: 'x'.repeat(400) }), true);
  const q = confirms.pop();
  assert.deepEqual(
    [q.chatId, q.segmentId, q.origin, q.tool, q.summary.length, q.sensitive, q.risk.category],
    ['c1', 's1', 'https://www.chase.com', 'click', 300, null, 'banking'],
  );
  const sensitive = { kind: 'payment', verb: 'submit payment details', detail: 'Pay now' };
  await g.act('https://example.com/', ctx, { tool: 'click', summary: 'click', sensitive });
  assert.equal(confirms.pop().risk, undefined);
  // defaults: the tool is "act"
  await g.act('http://10.0.0.1/', ctx);
  assert.deepEqual([confirms.at(-1).tool, confirms.at(-1).summary], ['act', '']);
  // a "no", an answer that isn't a yes, or a failing card: denied, naming the site and the risk
  ok = false;
  await assert.rejects(
    g.act('https://www.chase.com/', ctx, { sensitive }),
    (e: any) => e.code === 'denied' && /\(submit payment details\) on https:\/\/www\.chase\.com\. Banking site: high risk/.test(e.message),
  );
  ok = 'yes';
  await assert.rejects(
    g.act('https://example.com/', ctx, { sensitive }),
    (e: any) => e.code === 'denied' && e.message === 'The user did not allow this action (submit payment details) on https://example.com.',
  );
  g.confirmAction = async () => {
    throw new Error('card gone');
  };
  // a card that could not be shown is not the user's no
  await assert.rejects(g.act('http://10.0.0.1/', ctx), {
    code: 'unavailable',
    message: "Couldn't ask the user about http://10.0.0.1: card gone. Try again.",
  });
  // a page that isn't a web page (a data: URL) is named by its address; no way to ask: disabled
  const none = new OriginGrants({ ask: async () => null });
  await assert.rejects(
    none.act('data:text/html,x', ctx, { sensitive }),
    (e: any) => e.code === 'disabled' && /^This action \(submit payment details\) needs the user's confirmation/.test(e.message),
  );
  await assert.rejects(
    none.act('https://www.chase.com/', ctx),
    (e: any) => e.code === 'disabled' && /^Actions on https:\/\/www\.chase\.com need the user's confirmation/.test(e.message),
  );
  ok = true;
  const named = new OriginGrants({ ask: async () => null, confirmAction: async (q: any) => (confirms.push(q), true) });
  await named.act('not a url', ctx, { sensitive });
  assert.equal(confirms.pop().origin, 'not a url');
  assert.equal(named.riskOf('https://www.chase.com/').category, 'banking');
});
