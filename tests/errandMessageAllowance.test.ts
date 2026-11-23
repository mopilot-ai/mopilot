// "Allow messages for this errand" (electron/capabilities/browser/errandGrants.cjs): one yes on a send-message card covers that chat's
// ordinary messages on that site, across turns, until the user revokes it, the chat is forgotten or the app restarts. Main decides what
// is ordinary: undeclared, committing or unreadable messages, and any message that accepts or declines, changes the order or shares
// personal details, ask every time. Another site, another chat, the other browser and a high-risk site are never covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ErrandGrants, commitsWhy, errandSite, messageOf, onErrandsChanged } = require('../electron/capabilities/browser/errandGrants.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { siteTables } = require('../electron/app/browserSiteTables.cjs');
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');
const { hostCard } = require('../electron/capabilities/browser/chromePanelHostCard.cjs');

const STORE = 'https://help.store.example/chat?order=W1';
const SEND = { kind: 'send_message', verb: 'send a message' };
const ordinary = (text: string) => ({ declared: 'ordinary', text });
const ctx = (chatId = 'c1') => ({ chatId, segmentId: 's1' });

function grants(answers: (req: any) => any, browser: 'iab' | 'chrome' = 'iab') {
  const asked: any[] = [];
  const g = new OriginGrants({ browser, confirmAction: async (req: any) => (asked.push(req), answers(req)) });
  const send = (url: string, message: any, chatId = 'c1', sensitive: any = SEND) =>
    g.act(url, ctx(chatId), { tool: 'click', summary: 'click Send', sensitive, message });
  return { g, asked, send };
}

test('main decides what is ordinary: only a declared ordinary message whose text commits to nothing', () => {
  assert.equal(commitsWhy(ordinary('My order W100200300 was promised by October 28. What is the new delivery date?')), null);
  assert.equal(commitsWhy(ordinary('That is not a date. What can you offer for the delay?')), null);
  // asking about a refund commits to nothing; asking for one does
  assert.equal(commitsWhy(ordinary('Can you refund the shipping?')), null);
  assert.equal(commitsWhy(ordinary('Please refund the shipping.')), 'it may change the order');
  assert.equal(commitsWhy(ordinary('Cancel the order. Is that possible?')), 'it may change the order');
  assert.equal(commitsWhy(ordinary('Yes, please apply the $25 credit.')), 'it may accept or decline an offer');
  assert.equal(commitsWhy(ordinary('No thanks, I will wait.')), 'it may accept or decline an offer');
  for (const pii of [
    'Email me at a.person@example.com',
    'Call me on +1 (415) 555-0134',
    'Ship it to 12 Market Street',
    '4111 1111 1111 1111',
  ])
    assert.equal(commitsWhy(ordinary(pii)), 'it shares personal details', pii);
  // the agent's declaration alone never makes a message ordinary, and can make it committing
  assert.equal(commitsWhy({ text: 'What is the new date?' }), 'the agent did not say what kind of message it is');
  assert.equal(commitsWhy({ declared: 'commits', text: 'What is the new date?' }), 'the agent says it commits you');
  // nothing typed through the tools (the page's own text, or a script's raw input): it can't be read, so it asks
  assert.equal(commitsWhy(ordinary('   ')), "MoPilot couldn't read what it sends");
  assert.equal(commitsWhy({ declared: 'ordinary', text: null }), "MoPilot couldn't read what it sends");
  assert.equal(commitsWhy({}), 'the agent did not say what kind of message it is');
});

test('an allowance covers the registrable domain with its scheme; an IP, localhost or odd address keeps its origin', () => {
  assert.equal(errandSite('https://help.store.example'), 'https://store.example');
  assert.equal(errandSite('https://chat.shop.co.uk'), 'https://shop.co.uk');
  assert.equal(errandSite('http://store.example'), 'http://store.example');
  assert.equal(errandSite('http://127.0.0.1:4100'), 'http://127.0.0.1:4100');
  assert.equal(errandSite('http://localhost:5000'), 'http://localhost:5000');
  assert.equal(errandSite('not a url'), 'not a url');
});

test('the table: add once, list, revoke, end; every change tells the listeners, a repeat or a miss does not', () => {
  const told: string[] = [];
  const off = onErrandsChanged((browser: string, chatId: string) => told.push(`${browser} ${chatId}`));
  const t = new ErrandGrants('chrome');
  t.add('c1', 'https://a.store.example', 5);
  t.add('c1', 'https://b.store.example', 6);
  assert.equal(t.has('c1', 'https://c.store.example'), true, 'the same registrable domain');
  assert.equal(t.has('c2', 'https://a.store.example'), false);
  assert.deepEqual(t.list('c1'), [{ site: 'https://store.example', since: 5, browser: 'chrome' }]);
  assert.equal(t.revoke('c1', 'https://other.example'), false);
  assert.equal(t.revoke('c1', 'https://store.example'), true);
  assert.equal(t.has('c1', 'https://a.store.example'), false);
  assert.deepEqual(t.list('c1'), []);
  t.add('c1', 'https://store.example');
  t.end('c1');
  t.end('c1');
  assert.deepEqual(t.list('c1'), []);
  off();
  t.add('c3', 'https://store.example');
  assert.deepEqual(told, ['chrome c1', 'chrome c1', 'chrome c1', 'chrome c1']);
  // the default table is the built-in browser's
  assert.equal(new ErrandGrants().browser, 'iab');
});

test('a send carries the text the agent typed: fill replaces it, typing adds to it, the send takes it; its kind is the action’s, else the call’s', () => {
  const tab: any = {};
  assert.equal(messageOf(tab, { kind: 'fill', value: 'Hello' }, null, {}), null);
  assert.equal(messageOf(tab, { kind: 'type', text: ', where is it?' }, null, {}), null);
  assert.deepEqual(messageOf(tab, { kind: 'click' }, SEND, { messageKind: 'ordinary' }), {
    declared: 'ordinary',
    text: 'Hello, where is it?',
  });
  // taken: the next send has nothing the agent typed
  assert.deepEqual(messageOf(tab, { kind: 'key', messageKind: 'commits' }, SEND, { messageKind: 'ordinary' }), {
    declared: 'commits',
    text: '',
  });
  // typing into a fresh tab, and a fill without a value
  const other: any = {};
  messageOf(other, { kind: 'type' }, null, {});
  assert.equal(other.outgoing, '');
  messageOf(other, { kind: 'fill' }, null, {});
  assert.deepEqual(messageOf(other, { kind: 'click' }, SEND, {}), { declared: undefined, text: '' });
  // a click that sends nothing leaves the text for the send
  const third: any = { outgoing: 'Hi' };
  assert.equal(messageOf(third, { kind: 'click' }, { kind: 'delete' }, {}), null);
  assert.equal(third.outgoing, 'Hi');
  assert.deepEqual(messageOf({}, { kind: 'click' }, SEND, {}), { declared: undefined, text: null });
});

test('the first ordinary message offers the errand; allowed, the chat’s next ordinary messages on the site go without a card, across turns', async () => {
  const { g, asked, send } = grants((req) => (req.errand ? 'errand' : true));
  assert.equal(await send(STORE, ordinary('What is the new delivery date?')), true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].errand, true);
  assert.equal(asked[0].commits, undefined);
  assert.equal(await send(STORE, ordinary('That is vague. What can you offer?')), false, 'no card');
  g.turnEnded('c1');
  assert.equal(await send('https://chat.store.example/', ordinary('Thanks. Which carrier?')), false, 'the next turn, another subdomain');
  assert.equal(asked.length, 1);
});

test('each boundary asks again: another site, another chat, after revoke, after restart, the other browser, a high-risk site', async () => {
  const { g, asked, send } = grants((req) => (req.errand ? 'errand' : true));
  await send(STORE, ordinary('Where is my order?'));
  assert.equal(asked.length, 1);
  await send('https://other.example/chat', ordinary('Where is my order?'));
  assert.equal(asked.length, 2, 'another site');
  assert.equal(asked[1].errand, true);
  await send(STORE, ordinary('Where is my order?'), 'c2');
  assert.equal(asked.length, 3, 'another chat');
  g.errands.revoke('c1', 'https://store.example');
  await send(STORE, ordinary('Where is my order?'));
  assert.equal(asked.length, 4, 'after revoke');
  // the app restarted: nothing was saved
  const fresh = grants(() => true);
  await fresh.send(STORE, ordinary('Where is my order?'));
  assert.equal(fresh.asked.length, 1, 'after restart');
  // a yes in the built-in browser never covers the user's Chrome
  const chrome = grants(() => true, 'chrome');
  await chrome.send(STORE, ordinary('Where is my order?'));
  assert.equal(chrome.asked.length, 1, 'the other browser');
  assert.equal(chrome.asked[0].browser, 'chrome');
  // the chat is forgotten (archived, deleted): its errand ends
  g.forget('c1');
  assert.deepEqual(g.errands.list('c1'), []);
  // a high-risk site: every action asks, with no errand to offer
  const bank = grants(() => true);
  await bank.send('https://www.chase.com/messages', ordinary('Where is my card?'));
  assert.equal(bank.asked[0].errand, undefined);
});

test('a committing message still asks under the allowance, says why, and an errand answer to it allows only that once', async () => {
  const { g, asked, send } = grants((req) => (req.errand || req.commits ? 'errand' : true));
  await send(STORE, ordinary('Where is my order?'));
  assert.equal(await send(STORE, ordinary('Yes, please apply the $25 credit.')), true);
  assert.equal(asked.length, 2);
  assert.equal(asked[1].commits, 'it may accept or decline an offer');
  assert.equal(asked[1].errand, undefined);
  // undeclared, and declared committing: asks too
  await send(STORE, { text: 'Where is it?' });
  await send(STORE, { declared: 'commits', text: 'Cancel and reorder it.' });
  assert.equal(asked.length, 4);
  // on another site, an "errand" answer to a committing card adds nothing
  await send('https://other.example/', ordinary('Please cancel my order.'));
  assert.deepEqual(
    g.errands.list('c1').map((e: any) => e.site),
    ['https://store.example'],
  );
  // a send with no message details (an older caller) asks
  await send(STORE, null);
  assert.equal(asked.length, 6);
  // Deny on a message card refuses it
  const no = grants(() => false);
  await assert.rejects(no.send(STORE, ordinary('Where?')), { code: 'denied' });
  // a sensitive action that is not a message offers no errand
  const del = grants(() => true);
  await del.send(STORE, ordinary('Delete'), 'c1', { kind: 'delete', verb: 'delete something' });
  assert.equal(del.asked[0].errand, undefined);
  assert.equal(del.asked[0].commits, undefined);
});

test('main’s card offers the errand only for an ordinary message, names why one commits, and maps the answer', async () => {
  const cards = new Map<string, any>();
  const broker = new ApprovalBroker({
    controller: { addApproval: (_c: string, a: any) => void cards.set(a.id, a), resolveApproval: (id: string) => cards.delete(id) },
  });
  const live = {
    sessions: new Map([['c1', { permission: 'default', activeTurn: { id: 't' } }]]),
    controller: { ref: () => ({ kind: 'claude', id: null }), adapterOf: () => ({}) },
    remoteOwners: { get: () => null },
    computerUse: { broker },
  };
  const { browserGrants } = siteTables({ live, dir: '/tmp/none', prefs: () => ({}), isFlagEnabled: () => false });
  const answerNext = async (answer: any) => {
    while (!cards.size) await new Promise((r) => setImmediate(r));
    const [card] = [...cards.values()];
    broker.answer(card.id, answer);
    return card.params;
  };
  const go = (message: any) => browserGrants.act(STORE, ctx(), { tool: 'click', summary: 'click Send', sensitive: SEND, message });
  let pending = go(ordinary('Where is my order?'));
  let params = await answerNext({ decision: 'allow', scope: 'errand' });
  assert.equal(await pending, true);
  assert.equal(params.errand, true);
  assert.equal(params.verb, 'send a message');
  assert.equal(browserGrants.errands.has('c1', STORE), true);
  pending = go(ordinary('Yes, apply the credit.'));
  params = await answerNext({ decision: 'allow', scope: 'errand' });
  assert.equal(await pending, true);
  assert.equal(params.commits, 'it may accept or decline an offer');
  assert.equal(params.errand, undefined);
  // Allow once on a fresh site keeps nothing
  pending = browserGrants.act('https://other.example/', ctx(), { tool: 'click', sensitive: SEND, message: ordinary('Hi?') });
  await answerNext({ decision: 'allow', scope: 'once' });
  assert.equal(await pending, true);
  assert.equal(browserGrants.errands.has('c1', 'https://other.example/'), false);
});

test('the Chrome panel and phone card: the errand choice first, Allow once without a hold, and the reason a message commits', () => {
  const offer = hostCard({ kind: 'computerConfirm', verb: 'send a message', origin: STORE, errand: true }, 'Claude Code');
  assert.deepEqual(
    offer.choices.map((c: any) => [c.key, c.label, !!c.hold]),
    [
      ['errand', 'Allow messages for this errand', false],
      ['once', 'Allow once', false],
      ['deny', 'Deny', false],
    ],
  );
  assert.deepEqual(offer.results.errand, { decision: 'allow', scope: 'errand' });
  const commits = hostCard(
    { kind: 'computerConfirm', verb: 'send a message', origin: STORE, commits: 'it shares personal details' },
    'Codex',
  );
  assert.match(commits.detail, /Asks every time: it shares personal details\./);
  assert.deepEqual(
    commits.choices.map((c: any) => [c.key, !!c.hold]),
    [
      ['once', true],
      ['deny', false],
    ],
  );
});
