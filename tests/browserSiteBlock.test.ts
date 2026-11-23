// A site that blocks or rate-limits the in-app browser (#4651): the note an agent's navigation gets, the pace per site, and the cool-down
// after a block (electron/capabilities/browser/siteBlock.cjs, wired in hostNavigation.cjs navigate and tab.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);
const {
  documentStatus,
  blockNote,
  pacedHost,
  SitePacing,
  GAP_MS,
  COOL_MS,
  MAX_COOL_MS,
} = require('../electron/capabilities/browser/siteBlock.cjs');

test('blockNote: a 403 or 429 is named with its status and the way on; other statuses and no status say nothing', () => {
  assert.match(
    blockNote(403, 'https://www.example.test/p/1'),
    /^www\.example\.test answered HTTP 403: it refused this browser, so the page shown may be its block page/,
  );
  assert.match(blockNote(429, 'https://www.example.test/p/1'), /HTTP 429: it is rate-limiting this browser.*Continue in Chrome\.$/);
  // an address with no host or on this machine gets none: it is no site's bot check
  assert.equal(blockNote(403, 'not a url'), null);
  for (const status of [200, 404, 500, 503, null, undefined]) assert.equal(blockNote(status, 'https://a.test/'), null);
});

test('pacedHost: web sites are paced; hostless addresses, this machine and private networks are not, unless the E2E asks', () => {
  assert.equal(pacedHost('https://www.shop.test:8443/p'), 'www.shop.test:8443');
  for (const url of [
    'about:blank',
    'file:///a.html',
    'data:text/html,x',
    'not a url',
    'http://localhost:3000/',
    'http://app.localhost/',
    'http://127.0.0.1:8080/',
    'http://[::1]:8080/',
    'http://10.1.2.3/',
    'http://192.168.1.5/',
    'http://172.20.0.1/',
    'http://nas.local/',
  ])
    assert.equal(pacedHost(url), '', url);
  // 172.15 and 172.32 are public addresses
  assert.equal(pacedHost('http://172.32.0.1/'), '172.32.0.1');
  process.env.SAGE_E2E_PACE_LOCAL = '1';
  try {
    assert.equal(pacedHost('http://127.0.0.1:8080/'), '127.0.0.1:8080');
    assert.match(blockNote(403, 'http://127.0.0.1:8080/'), /^127\.0\.0\.1:8080 answered HTTP 403/);
  } finally {
    delete process.env.SAGE_E2E_PACE_LOCAL;
  }
  // a dev server's 403 is its own answer: no block note, no cool-down
  assert.equal(blockNote(403, 'http://127.0.0.1:8080/'), null);
});

test('SitePacing: concurrent navigations take consecutive slots, a block that comes in while one waits refuses it, a redirect marks both sites, hostless addresses are free', async () => {
  let now = 5_000_000;
  const waits: number[] = [];
  let during: (() => void) | null = null;
  const pacing = new SitePacing({
    now: () => now,
    wait: async (ms: number) => {
      waits.push(ms);
      during?.();
      during = null;
    },
  });
  // three at the same moment: the first goes, the others wait one and two gaps
  await Promise.all([pacing.before('https://a.test/1'), pacing.before('https://a.test/2'), pacing.before('https://a.test/3')]);
  assert.deepEqual(waits, [GAP_MS, 2 * GAP_MS]);
  // a block that lands while a navigation waits its slot refuses that navigation too
  now += 10 * GAP_MS;
  await pacing.before('https://a.test/4');
  during = () => pacing.after('https://a.test/4', 429);
  await assert.rejects(pacing.before('https://a.test/5'), { code: 'blocked_by_site' });
  // a redirect from example.test to www.example.test that is blocked there cools both
  now += 10 * GAP_MS;
  await pacing.before('https://example.test/');
  await pacing.before('https://www.example.test/');
  pacing.after('https://example.test/', 403, 'https://www.example.test/landing');
  await assert.rejects(pacing.before('https://example.test/x'), { code: 'blocked_by_site' });
  await assert.rejects(pacing.before('https://www.example.test/y'), { code: 'blocked_by_site' });
  // addresses that are not paced neither wait nor are refused
  const before = waits.length;
  await pacing.before('about:blank');
  await pacing.before('about:blank');
  pacing.after('about:blank', 403);
  await pacing.before('http://127.0.0.1:9/');
  assert.equal(waits.length, before);
});

test('SitePacing: a gap between navigations to one site, a cool-down after a block that doubles to a cap, and an ordinary page ends it', async () => {
  let now = 1_000_000;
  const waits: number[] = [];
  const pacing = new SitePacing({ now: () => now, wait: async (ms: number) => void waits.push(ms) });
  // the first navigation to a site waits for nothing; a second right after waits out the gap; another site is not held
  await pacing.before('https://a.test/1');
  await pacing.before('https://a.test/2');
  await pacing.before('https://b.test/1');
  assert.deepEqual(waits, [GAP_MS]);
  // the second took the slot one gap after the first: a third one gap later waits again, one two gaps later does not
  now += 2 * GAP_MS;
  await pacing.before('https://a.test/3');
  assert.deepEqual(waits, [GAP_MS], 'the slots have passed: no wait');
  // pages that are not blocks, and a site never asked, leave nothing behind
  pacing.after('https://a.test/3', 200);
  pacing.after('https://never.test/', 403);
  await pacing.before('https://a.test/4');
  // a block: the site is refused without a load until the cool-down ends
  pacing.after('https://a.test/4', 403);
  await assert.rejects(pacing.before('https://a.test/5'), {
    code: 'blocked_by_site',
    message: /^a\.test blocked this browser a moment ago \(HTTP 403\).*not asked again for 45 s/,
  });
  now += COOL_MS - 1000;
  await assert.rejects(pacing.before('https://a.test/5'), { message: /for 1 s/ });
  now += 1000;
  await pacing.before('https://a.test/5');
  // blocked again: the next cool-down doubles, up to the cap
  pacing.after('https://a.test/5', 429);
  await assert.rejects(pacing.before('https://a.test/6'), { message: /HTTP 429.*90 s/ });
  for (let i = 0; i < 6; i += 1) {
    now += MAX_COOL_MS;
    await pacing.before('https://a.test/7');
    pacing.after('https://a.test/7', 403);
  }
  await assert.rejects(pacing.before('https://a.test/8'), { message: /300 s/ });
  // a page the site serves ends the cool-down and starts the next one at the base length
  now += MAX_COOL_MS;
  await pacing.before('https://a.test/9');
  pacing.after('https://a.test/9', 200);
  pacing.after('https://a.test/9', 403);
  await assert.rejects(pacing.before('https://a.test/10'), { message: /45 s/ });
});

test('navigate: a block page comes back with its status and a note, a served page does not, and a blocked site is not asked again', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  let answered = 0;
  const answer = (url: string, status: number) => {
    tab.wc.url = url;
    tab.network.set('r', { id: 'r', type: 'Document', url, status });
  };
  tab.wc.handlers['Page.navigate'] = ({ url }: any) => {
    answered += 1;
    answer(url, 403);
    return { loaderId: 'L1' };
  };
  const blocked = await drive(t, h.tabs.navigate(tab, 'https://shop.test/p/1'));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.note, /^shop\.test answered HTTP 403/);
  // the site is left alone: the next navigation to it is refused without a load; another site loads
  await assert.rejects(drive(t, h.tabs.navigate(tab, 'https://shop.test/p/2')), { code: 'blocked_by_site' });
  assert.equal(answered, 1);
  tab.wc.handlers['Page.navigate'] = ({ url }: any) => {
    answer(url, 200);
    return { loaderId: 'L2' };
  };
  const served = await drive(t, h.tabs.navigate(tab, 'https://other.test/'));
  assert.equal(served.blocked, undefined);
  assert.equal(served.note, undefined);
});

test('reload: a site that blocked this browser is left alone, and a reload that is served ends it', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.url = 'https://shop.test/p/1';
  tab.wc.handlers['Page.getNavigationHistory'] = () => ({ currentIndex: 0, entries: [{ transitionType: 'typed' }] });
  const answer = (status: number) => tab.network.set('r', { id: 'r', type: 'Document', url: 'https://shop.test/p/1', status });
  tab.wc.reload = () => {
    answer(429);
    tab.wc.emit('did-stop-loading');
  };
  await drive(t, h.tabs.history(tab, 'reload'));
  await assert.rejects(drive(t, h.tabs.history(tab, 'reload')), { code: 'blocked_by_site' });
  // back and forward are not requests the pace covers
  assert.ok(await drive(t, h.tabs.history(tab, 'back')).catch(() => 'went on'));
});

test('documentStatus: the status of the document at the address shown; subresources, frames and a tab with no log say null', () => {
  const doc = (url: string, status: number | null, type = 'Document') => ({ type, url, status });
  const network = new Map([
    ['a', doc('https://a.test/p#top', 200)],
    ['img', doc('https://a.test/p', 500, 'Image')],
    ['frame', doc('https://ads.test/', 403)],
    ['b', doc('https://a.test/p', 429)],
  ]);
  assert.equal(documentStatus({ url: 'https://a.test/p', network }), 429, 'the newest document for the address, hash aside');
  assert.equal(documentStatus({ url: 'https://ads.test/', network }), 403);
  assert.equal(documentStatus({ url: 'https://elsewhere.test/', network }), null);
  assert.equal(documentStatus({ url: 'https://a.test/p' }), null);
});
