// MoMo's always-allowed sites through the call gate (#3655, electron/momo/toolTrust.cjs over a real sentinel, trust gate and audit log): a navigation names the address it opens; "Always allow <host>" on its card lets a later tainted chat open that host with a clean address and no card, audited as `site`; such an open opens the host for the chat as Allow once does, so acts there ask no more than after Allow once (never more cards than before for the same journey); an address with data asks in a chat that hasn't opened the host; an open redirect on the allowed host lands nowhere opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditLog } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { Sentinel } = require('../electron/momo/sentinel.cjs');
const { createTrustGate } = require('../electron/momo/trustGate.cjs');
const { CURRENT } = require('../electron/momo/audit.cjs');
const { momoTool } = require('../electron/momo/contract/toolIsolation.cjs');
const { createMomoCallGate } = require('../electron/momo/toolTrust.cjs');
const { SiteList } = require('../electron/momo/sentinelSites.cjs');
const { riskyUnasked } = require('../electron/app/momoSiteRisk.cjs');

const HOST = 'www.ycombinator.com';

/** MoMo's gate over a fake Chrome whose tab shows where each navigation landed; the card answers from `answers` (none left: no answer). */
function rig(answers: any[] = []) {
  const registry = new Registry();
  registry.setChatScope(momoTool, (id: string) => id.startsWith('momo-'));
  const cards: any[] = [];
  const sentinel = new Sentinel({
    askUser: async (card: any) => {
      cards.push(card);
      return answers.shift() ?? null;
    },
    allowed: () => true,
    // the app's sites: checked against the browser's site risk (electron/app/momo.cjs)
    sites: new SiteList({ risky: riskyUnasked }),
  });
  const t = auditLog();
  const pages = new Map<string, string>();
  const redirects = new Map<string, string>();
  registry.setChatGate(
    createMomoCallGate({
      trust: createTrustGate({ sentinel, audit: t.log }),
      sentinel,
      identity: () => ({}),
      pageOf: (chatId: string) => pages.get(chatId) ?? null,
    }),
  );
  const ran: string[] = [];
  for (const name of ['chrome_navigate', 'chrome_get_page_text', 'chrome_form_input', 'chrome_computer'])
    registry.register({
      name,
      policy: 'act',
      authorizesItself: true,
      handler: async (a: any, ctx: any) => {
        ran.push(`${name} ${a.url ?? a.value ?? ''}`.trim());
        if (name === 'chrome_navigate') pages.set(ctx.chatId, redirects.get(a.url) ?? a.url);
        return name === 'chrome_get_page_text' ? 'Balance: 1800' : 'ok';
      },
    });
  const call = (chatId: string, name: string, args: any = {}) => registry.invoke(chatId, 'seg', name, args);
  const entries = () =>
    fs
      .readFileSync(path.join(t.dir, CURRENT), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { sentinel, cards, call, ran, entries, redirects, pages };
}

test('#3655 repro: Always allow on the open card, then a new tainted chat opens the same site with no card', async () => {
  const { call, cards, entries, sentinel } = rig([{ allow: true, scope: 'site' }]);
  await call('momo-a', 'chrome_get_page_text');
  assert.equal((await call('momo-a', 'chrome_navigate', { url: `https://${HOST}/` })).ok, true);
  assert.deepEqual([cards[0].opens, cards[0].scopes, cards[0].destinations.hosts], [true, ['once', 'site'], [HOST]]);
  // the card shows the address it opens
  assert.equal(cards[0].summary, `Open https://${HOST}/`);
  // a chat that chose Always allow opened the host, as Allow once does
  assert.equal(sentinel.hasOpened('momo-a', HOST), true);
  await call('momo-b', 'chrome_get_page_text');
  assert.equal((await call('momo-b', 'chrome_navigate', { url: `https://${HOST}/companies` })).ok, true);
  assert.equal(cards.length, 1, 'no second card');
  const intents = entries().filter((e) => e.kind === 'intent' && e.action === 'chrome_navigate');
  assert.deepEqual(
    intents.map((e) => e.decision),
    ['asked:site', 'site'],
  );
  // opened with no card: opened for the chat, as after Allow once
  assert.equal(sentinel.hasOpened('momo-b', HOST), true);
});

/** One chat's research journey on the site: a page read, the open, a click and typing there; the cards it raised. */
async function journey(r: ReturnType<typeof rig>, chatId: string) {
  const before = r.cards.length;
  await r.call(chatId, 'chrome_get_page_text');
  const opened = await r.call(chatId, 'chrome_navigate', { url: `https://${HOST}/companies` });
  const clicked = await r.call(chatId, 'chrome_computer', { action: 'left_click', ref: 'e1' });
  const typed = await r.call(chatId, 'chrome_form_input', { ref: 'q', value: 'airbnb' });
  return { cards: r.cards.length - before, ok: [opened.ok, clicked.ok, typed.ok] };
}

test('#3655: the same journey in two chats never raises more cards with Always allow than with Allow once', async () => {
  const once = rig([
    { allow: true, scope: 'once' },
    { allow: true, scope: 'once' },
  ]);
  const always = rig([{ allow: true, scope: 'site' }]);
  const onceRuns = [await journey(once, 'momo-a'), await journey(once, 'momo-b')];
  const alwaysRuns = [await journey(always, 'momo-a'), await journey(always, 'momo-b')];
  // Allow once: the open asks in each chat; the click and typing there then run, as before this change
  assert.deepEqual(onceRuns, [
    { cards: 1, ok: [true, true, true] },
    { cards: 1, ok: [true, true, true] },
  ]);
  // Always allow: the first chat asks once; the second asks nothing, and acts there run the same way
  assert.deepEqual(alwaysRuns, [
    { cards: 1, ok: [true, true, true] },
    { cards: 0, ok: [true, true, true] },
  ]);
  for (const i of [0, 1]) assert.ok(alwaysRuns[i].cards <= onceRuns[i].cards);
});

test('#3655: after a no-card open, an address with data to that site still asks until the user answers a card for it', async () => {
  const { call, cards, ran } = rig([{ allow: true, scope: 'site' }, null, { allow: true, scope: 'once' }]);
  await call('momo-a', 'chrome_get_page_text');
  await call('momo-a', 'chrome_navigate', { url: `https://${HOST}/` });
  await call('momo-b', 'chrome_get_page_text');
  assert.equal((await call('momo-b', 'chrome_navigate', { url: `https://${HOST}/` })).ok, true);
  // opened for acts, but another open with data in its address asks, Allow once only
  const leak = await call('momo-b', 'chrome_navigate', { url: `https://${HOST}/?q=1800` });
  assert.equal(leak.ok, false);
  assert.deepEqual([cards.at(-1).reasons, cards.at(-1).scopes], [['egress', 'carries-data'], ['once']]);
  assert.equal(ran.includes(`chrome_navigate https://${HOST}/?q=1800`), false);
  // the user allows one: from then on the chat has the site opened as after Allow once today
  assert.equal((await call('momo-b', 'chrome_navigate', { url: `https://${HOST}/?q=1800` })).ok, true);
  const n = cards.length;
  assert.equal((await call('momo-b', 'chrome_navigate', { url: `https://${HOST}/?q=airbnb` })).ok, true);
  assert.equal(cards.length, n);
});

test('#3655: an open redirect on an allowed site lands on a host that is not opened, so nothing can be sent there', async () => {
  const { call, sentinel, redirects } = rig([{ allow: true, scope: 'site' }]);
  await call('momo-a', 'chrome_get_page_text');
  await call('momo-a', 'chrome_navigate', { url: `https://${HOST}/` });
  // a clean path that redirects elsewhere (the address itself carries nothing)
  redirects.set(`https://${HOST}/out`, 'https://attacker.example/');
  await call('momo-b', 'chrome_get_page_text');
  assert.equal((await call('momo-b', 'chrome_navigate', { url: `https://${HOST}/out` })).ok, true);
  assert.equal(sentinel.hasOpened('momo-b', 'attacker.example'), false);
  assert.equal((await call('momo-b', 'chrome_form_input', { ref: 'q', value: '1800' })).ok, false);
  // a redirect target named in the path is data: it asks
  assert.equal((await call('momo-b', 'chrome_navigate', { url: `https://${HOST}/r/attacker.example` })).ok, false);
});
