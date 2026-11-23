// MoMo's always-allowed sites (#3655, electron/momo/sentinelSites.cjs and sentinel.cjs): which navigation addresses carry no data, the site list, and the sentinel's rule: after a private read, a navigation to an always-allowed host with a clean address runs without a card in any chat; a query, a fragment, data in the path, a subdomain, a recipient, an act, a change or a high-risk site still asks every time with Allow once only; Remove and Reset make it ask again; an untainted chat and a read are unchanged; the list is stored with the approvals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Sentinel, LEVELS, SCOPES } = require('../electron/momo/sentinel.cjs');
const { cleanOpenHost, plainOpenHost, SiteList, MAX_SITES, MAX_OPENS } = require('../electron/momo/sentinelSites.cjs');
const { grantOf } = require('../electron/momo/sentinelRules.cjs');
const { riskyUnasked } = require('../electron/app/momoSiteRisk.cjs');
/** the app's sites: checked against the browser's site risk (electron/app/momo.cjs) */
const sites = () => new SiteList({ risky: riskyUnasked });

const HOST = 'www.ycombinator.com';
/** A navigation as the call gate sends it (toolTrust.cjs): a repeatable read with the host it opens. */
const nav = (chatId: string, url: string, host = new URL(/^https?:/.test(url) ? url : `https://${url}`).hostname) => ({
  chatId,
  tool: 'chrome_navigate',
  source: 'browser',
  kind: 'read',
  args: { url },
  egress: { hosts: [host] },
  repeatable: true,
  opens: url,
});
const readFile = (chatId: string) => ({ chatId, tool: 'momo_files_read', source: 'files', kind: 'read', args: { p: 'rent.txt' } });

function memoryStorage(initial: any = null) {
  const box = { data: initial, writes: 0, fail: false as boolean | Error };
  return {
    box,
    read: async () => {
      if (box.fail) throw box.fail;
      return box.data;
    },
    write: async (d: any) => {
      box.writes++;
      box.data = JSON.parse(JSON.stringify(d));
    },
  };
}

/** A sentinel whose card answers from `answers` in turn (none left: no answer), with private files and the browser. */
function rig(o: { answers?: any[]; storage?: any } = {}) {
  const cards: any[] = [];
  const answers = [...(o.answers ?? [])];
  const s = new Sentinel({
    askUser: async (card: any) => {
      cards.push(card);
      return answers.shift() ?? null;
    },
    allowed: () => true,
    sources: { files: { level: LEVELS.READ, private: true }, browser: { level: LEVELS.READ }, mail: { level: LEVELS.ASK } },
    storage: o.storage ?? null,
    newId: () => 'g1',
    sites: sites(),
  });
  return { s, cards, answers };
}

/** A sentinel with HOST always allowed, through the card, and chat `a` tainted. */
async function withSite(o: { storage?: any } = {}) {
  const r = rig({ answers: [{ allow: true, scope: 'site' }], storage: o.storage });
  await r.s.decide(readFile('a'));
  const d = await r.s.decide(nav('a', `https://${HOST}/`));
  assert.deepEqual([d.allow, d.via, d.scope], [true, 'asked', 'site']);
  return r;
}

test('an address carries no data only without a query, fragment, user name or port, and with a short, plain path', () => {
  for (const url of [
    'https://www.ycombinator.com',
    'https://www.ycombinator.com/',
    'https://www.ycombinator.com/?',
    'https://www.ycombinator.com/#',
    'https://www.ycombinator.com/?#',
    'http://www.ycombinator.com/companies/airbnb',
    'https://example.com/w/Item-1234',
    'www.ycombinator.com/people',
    'https://en.wikipedia.org/wiki/Paul_Graham_(programmer)',
    'https://example.com/about/index.html',
    'https://example.com/a/b/c/',
  ])
    assert.equal(plainOpenHost(url), new URL(/^https?:/.test(url) ? url : `https://${url}`).hostname, url);
  for (const url of [
    3,
    '',
    'https://ex ample.com/',
    'javascript:alert(1)',
    'data:text/html,hi',
    'https://example.com/?q=ann',
    'https://example.com/#ann',
    'https://example.com?q',
    'https://ann:pw@example.com/',
    'https://example.com:8443/',
    'https://example.com//evil.example/x',
    'https://example.com/r/evil.example',
    'https://example.com/ann%40example.com',
    'https://example.com/%E0%A4%A',
    'https://example.com/ann@example.com',
    'https://example.com/a=b',
    `https://example.com/${'x'.repeat(41)}`,
    `https://example.com/${'abcdefghij/'.repeat(10)}`,
    'https://example.com/a/b/c/d',
    'https://example.com/call/4155551234',
    // what the review found a plain path could carry: an SSN, a card number, a sentence, a proxy path to a .md host
    'https://example.com/123-45-6789',
    'https://example.com/4111-1111-1111-1111',
    'https://example.com/JohnSmithPasswordIsHunterTwoBankChase/x',
    'https://www.google.com/amp/s/attacker.md/JohnSmith',
    'https://example.com/notes.md',
    'https://example.com/a.html/b',
    `https://example.com/${'abcdefghijklmnop/'.repeat(3)}`,
    'https://example.com/t/deadbeefcafe',
    'https://example.com/t/aGVsbG8gd29ybGQ1',
    'https://[::1',
  ])
    assert.equal(plainOpenHost(url), null, String(url));
  // a high-risk site is plain but never openable without a card
  assert.equal(plainOpenHost('https://www.chase.com/'), 'www.chase.com');
  assert.equal(cleanOpenHost('https://www.chase.com/', riskyUnasked), null);
  assert.equal(cleanOpenHost('https://10.0.0.1/', riskyUnasked), null);
  // loopback is normal for development, but no site to open after a private read
  assert.equal(plainOpenHost('http://localhost/'), 'localhost');
  for (const local of ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/'])
    assert.equal(cleanOpenHost(local, riskyUnasked), null, local);
  assert.equal(cleanOpenHost(`https://${HOST}/companies`, riskyUnasked), HOST);
  assert.equal(cleanOpenHost('https://example.com/?q=1', riskyUnasked), null);
  // without a risk check every site is risky: nothing is openable without a card
  assert.equal(cleanOpenHost(`https://${HOST}/`), null);
  assert.equal(riskyUnasked('not a url'), true);
});

test('the site list keeps exact hosts, at most MAX_SITES, and restores only hosts', () => {
  const l = new SiteList();
  assert.equal(l.add('not a host'), false);
  assert.equal(l.add('HTTPS://Example.COM./x'), true);
  assert.equal(l.add('example.com'), true, 'already there');
  assert.deepEqual(l.toJSON(), ['example.com']);
  assert.equal(l.remove(3 as any), false);
  assert.equal(l.remove('nope.example'), false);
  assert.equal(l.remove('Example.com'), true);
  for (let i = 0; i < MAX_SITES; i++) assert.equal(l.add(`s${i}.example`), true);
  assert.equal(l.add('one-more.example'), false, 'full');
  assert.equal(l.clear(), MAX_SITES);
  l.restore('nope');
  l.restore(['b.example', 3, 'x'.repeat(254), 'a.example', 'gone.example', 'not a host'], new Set(['gone.example']));
  assert.deepEqual(l.list(), ['a.example', 'b.example']);
  // a stored grant can never claim the site scope
  assert.equal(grantOf({ id: 'g', effect: 'allow', fingerprint: 'a'.repeat(64), scope: 'site', createdAt: 1, expiresAt: 2 }), null);
});

test('a tainted chat opening a new host with a clean address is asked to open it, with Always allow that host', async () => {
  const { s, cards } = rig({ answers: [{ allow: true, scope: 'site' }] });
  await s.decide(readFile('a'));
  const d = await s.decide(nav('a', `https://${HOST}/`));
  assert.deepEqual([d.allow, d.via, d.scope, d.persisted], [true, 'asked', 'site', false]);
  assert.deepEqual(
    [cards[0].reasons, cards[0].scopes, cards[0].opens, cards[0].destinations.hosts],
    [['egress'], [SCOPES.ONCE, SCOPES.SITE], true, [HOST]],
  );
  assert.deepEqual(s.listSites(), [HOST]);
});

test('an always-allowed host with a clean address opens in any tainted chat with no card, audited as site', async () => {
  const { s, cards } = await withSite();
  await s.decide(readFile('b'));
  for (const url of [`https://${HOST}/`, `https://${HOST}/companies/airbnb`, HOST])
    assert.deepEqual(await s.decide(nav('b', url, HOST)), {
      allow: true,
      via: 'site',
      fingerprint: (await s.decide(nav('b', url, HOST))).fingerprint,
    });
  assert.equal(cards.length, 1, 'only the first card');
});

test('the same host with a query, a fragment or data in the path asks every time, with Allow once only, and says why', async () => {
  const { s, cards } = await withSite();
  for (const url of [
    `https://${HOST}/?q=ann`,
    `https://${HOST}/#ann`,
    `https://${HOST}/ann%40example.com`,
    `https://${HOST}/aGVsbG8gd29ybGQ1`,
  ]) {
    assert.equal((await s.decide(nav('a', url, HOST))).reason, 'no-answer', url);
    assert.deepEqual([cards.at(-1).reasons, cards.at(-1).scopes], [['egress', 'carries-data'], ['once']], url);
  }
});

test('a subdomain, a second host, or a high-risk site asks; a subdomain may be allowed on its own', async () => {
  const { s, cards } = await withSite();
  assert.equal((await s.decide(nav('a', `https://news.ycombinator.com/`))).reason, 'no-answer');
  assert.deepEqual([cards.at(-1).reasons, cards.at(-1).scopes], [['egress'], ['once', 'site']]);
  assert.equal((await s.decide({ ...nav('a', `https://${HOST}/`), egress: { hosts: [HOST, 'evil.example'] } })).reason, 'no-answer');
  assert.deepEqual(cards.at(-1).scopes, ['once']);
  assert.equal((await s.decide(nav('a', 'https://www.chase.com/'))).reason, 'no-answer');
  assert.deepEqual([cards.at(-1).reasons, cards.at(-1).scopes], [['egress'], ['once']]);
  // a site answer the card didn't offer is no answer
  const r = rig({ answers: [{ allow: true, scope: 'site' }] });
  await r.s.decide(readFile('a'));
  assert.equal((await r.s.decide(nav('a', 'https://www.chase.com/'))).reason, 'no-answer');
  assert.deepEqual(r.s.listSites(), []);
});

test('a recipient, an act on the page, a form submit or a change to that host asks every time', async () => {
  const { s, cards } = await withSite();
  const base = nav('a', `https://${HOST}/`);
  for (const call of [
    // the call gate never names `opens` for an act: a click, typing, a form fill
    { ...base, tool: 'chrome_form_input', opens: undefined },
    { ...base, tool: 'chrome_computer', args: { action: 'left_click' }, opens: undefined },
    // a recipient beside the host, or the page itself as a script sees it
    { ...base, egress: { hosts: [HOST], recipients: ['ann@example.com'] } },
    { ...base, egress: { hosts: [HOST], recipients: ['the page open in the browser'] } },
    { ...base, egress: { hosts: [HOST], unknown: true } },
    // a change, even naming the address
    { ...base, tool: 'mail_send', source: 'mail', kind: 'change' },
  ]) {
    const before = cards.length;
    const d = await s.decide(call);
    assert.equal(d.allow, false, call.tool);
    assert.equal(cards.length, before + 1, call.tool);
    assert.deepEqual(cards.at(-1).scopes, ['once'], call.tool);
  }
});

test('Remove makes it ask again; Reset (revoke all) clears the list', async () => {
  const { s, cards } = await withSite();
  assert.equal(s.removeSite(3 as any), false);
  assert.equal(s.removeSite('nope.example'), false);
  assert.equal(s.removeSite(`HTTPS://${HOST.toUpperCase()}/`), true);
  assert.equal((await s.decide(nav('a', `https://${HOST}/`))).reason, 'no-answer');
  assert.deepEqual(cards.at(-1).scopes, ['once', 'site']);
  const again = await withSite();
  assert.equal(again.s.revokeAll(), 1);
  assert.deepEqual(again.s.listSites(), []);
  assert.equal((await again.s.decide(nav('a', `https://${HOST}/`))).reason, 'no-answer');
});

test('an untainted chat and a read are unchanged', async () => {
  const { s, cards } = rig();
  assert.equal((await s.decide(nav('c', `https://${HOST}/?q=1`, HOST))).via, 'read');
  assert.equal((await s.decide(nav('c', 'https://evil.example/'))).via, 'read');
  assert.equal((await s.decide(readFile('c'))).via, 'read');
  // a read sends nothing, before and after the chat is tainted, site list or not
  const w = await withSite();
  assert.equal((await w.s.decide(readFile('a'))).via, 'read');
  assert.equal((await w.s.decide({ ...readFile('a'), opens: `https://${HOST}/` })).via, 'read');
  assert.equal(cards.length, 0);
});

test('Allow once, Deny and a full list never add the site; a cleared chat answers nothing', async () => {
  const once = rig({ answers: [{ allow: true, scope: 'once' }, { allow: false }] });
  await once.s.decide(readFile('a'));
  assert.deepEqual([(await once.s.decide(nav('a', `https://${HOST}/`))).scope, once.s.listSites()], ['once', []]);
  assert.equal((await once.s.decide(nav('a', `https://${HOST}/`))).reason, 'denied');
  // a full list: the card's site answer allows once
  const filler = rig({ answers: Array.from({ length: MAX_SITES + 1 }, () => ({ allow: true, scope: 'site' })) });
  await filler.s.decide(readFile('a'));
  for (let i = 0; i < MAX_SITES; i++) await filler.s.decide(nav('a', `https://s${i}.example/`));
  const last = await filler.s.decide(nav('a', 'https://one-more.example/'));
  assert.deepEqual([last.allow, last.scope], [true, 'once'], 'a full list allows once');
  assert.equal(filler.s.listSites().length, MAX_SITES);
  // answered after the chat went away: nothing runs, nothing is kept
  const cleared = rig();
  cleared.s.askUser = async () => {
    cleared.s.clearChat('a');
    return { allow: true, scope: 'site' };
  };
  await cleared.s.decide(readFile('a'));
  assert.equal((await cleared.s.decide(nav('a', `https://${HOST}/`))).reason, 'no-answer');
  assert.deepEqual(cleared.s.listSites(), []);
});

test('the list is stored with the approvals, read back, and a Remove or Reset before the read holds', async () => {
  const storage = memoryStorage();
  const { s } = await withSite({ storage });
  await s.idle();
  assert.deepEqual(storage.box.data.sites, [HOST]);
  // read back by a new sentinel: opens with no card in a tainted chat
  const next = rig({ storage: memoryStorage(storage.box.data) });
  await next.s.decide(readFile('b'));
  assert.equal((await next.s.decide(nav('b', `https://${HOST}/`))).via, 'site');
  assert.equal(next.cards.length, 0);
  // removed while storage couldn't be read yet: it stays removed once it is
  const locked = memoryStorage({ ...storage.box.data, sites: [HOST, 'keep.example'] });
  locked.box.fail = Object.assign(new Error('locked'), { code: 'locked' });
  const early = rig({ storage: locked });
  await early.s.load();
  assert.equal(early.s.removeSite(HOST), true);
  locked.box.fail = false;
  await early.s.load();
  assert.deepEqual(early.s.listSites(), ['keep.example']);
  // reset while unread drops every stored site
  const reset = memoryStorage({ ...storage.box.data, sites: [HOST] });
  reset.box.fail = new Error('locked');
  const r = rig({ storage: reset });
  await r.s.load();
  r.s.revokeAll();
  reset.box.fail = false;
  await r.s.load();
  assert.deepEqual(r.s.listSites(), []);
  // an unknown entry stored is skipped
  const odd = rig({ storage: memoryStorage({ v: 1, grants: [], sites: 'x' }) });
  await odd.s.load();
  assert.deepEqual(odd.s.listSites(), []);
});

test('a chat opens listed sites without a card at most MAX_OPENS times; then each open asks once only, and says why', async () => {
  const { s, cards } = await withSite();
  await s.decide(readFile('b'));
  for (let i = 0; i < MAX_OPENS; i++) assert.equal((await s.decide(nav('b', `https://${HOST}/`))).via, 'site', String(i));
  assert.equal((await s.decide(nav('b', `https://${HOST}/`))).reason, 'no-answer');
  assert.deepEqual([cards.at(-1).reasons, cards.at(-1).scopes], [['egress', 'many-opens'], ['once']]);
  // another chat has its own budget
  await s.decide(readFile('c'));
  assert.equal((await s.decide(nav('c', `https://${HOST}/`))).via, 'site');
});

test('a sentinel made without a risk check never opens a listed site without a card', async () => {
  const s = new Sentinel({
    askUser: async () => ({ allow: true, scope: 'site' }),
    allowed: () => true,
    sources: { files: { level: LEVELS.READ, private: true }, browser: { level: LEVELS.READ } },
  });
  await s.decide(readFile('a'));
  assert.equal((await s.decide(nav('a', `https://${HOST}/`))).reason, 'no-answer', 'no site offered, so a site answer counts as none');
  assert.deepEqual(s.listSites(), []);
});
