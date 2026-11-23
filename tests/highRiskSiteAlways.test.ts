// "Always allow on this site" for a high-risk site (#5464): the site card may save it for good, and one yes on an action card
// saves its ordinary actions (clicks, typing, page JavaScript) for good; sensitive actions, tainted turns and paired-computer
// owners still ask, Full access alone never covers the site, and removing the site in Settings ends both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { siteTables } = require('../electron/app/browserSiteTables.cjs');
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');
const { TurnTokens } = require('../electron/capabilities/contract/turnTokens.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');

const AMEX = 'https://www.americanexpress.com/en-us/business/credit-cards/';
const AMEX_ORIGIN = 'https://www.americanexpress.com';
const ctx = { chatId: 'c1', segmentId: 's1' };

function temporary(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-always-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function grants(answer: (req: any) => any, o: any = {}) {
  const asked: any[] = [];
  const g = new OriginGrants({ confirmAction: async (req: any) => (asked.push(req), answer(req)), ask: async () => null, ...o });
  return { g, asked };
}

test('one yes on a high-risk action card saves the site and its ordinary actions for good, in every chat and after a restart', async (t) => {
  const file = path.join(temporary(t), 'sites.json');
  const { g, asked } = grants((req) => (req.always ? 'always' : true), { file });
  assert.equal(await g.act(AMEX, ctx, { tool: 'JavaScript', summary: 'JavaScript: document.title', script: true }), true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].always, true);
  assert.ok(asked[0].risk, 'the card still names the risk class');
  assert.equal(g.actionsAllowed('c1', AMEX_ORIGIN), true);
  assert.equal(g.get(AMEX_ORIGIN), 'write');
  assert.deepEqual(g.list(), [{ origin: AMEX_ORIGIN, level: 'write', actions: true }]);
  // the next action, another chat's, a click: no card
  assert.equal(await g.act(AMEX, ctx, { tool: 'JavaScript', script: true }), false);
  assert.equal(await g.act(AMEX, { chatId: 'c2', segmentId: 's9' }, { tool: 'click', ordinary: true }), false);
  assert.equal(asked.length, 1);
  // saved: a new table reads it back, and the site's access needs no card either
  const again = new OriginGrants({ file, ask: async () => assert.fail('no site card'), anchor: () => 'full' });
  assert.equal(again.actionsAllowed('c3', AMEX_ORIGIN), true);
  await again.require(AMEX, 'write', ctx);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).actions, [AMEX_ORIGIN]);
  // a second yes changes nothing; removing the site in Settings ends both, and the file drops the list
  assert.equal(g.allowActions(AMEX_ORIGIN), true);
  g.set(AMEX_ORIGIN, null);
  assert.equal(g.actionsAllowed('c1', AMEX_ORIGIN), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).actions, undefined);
  await g.act(AMEX, ctx, { tool: 'JavaScript', script: true });
  assert.equal(asked.length, 2);
});

test('a lower Settings level keeps the actions allowance; a read-only grant is raised to write by the next yes', async () => {
  const { g } = grants(() => 'always');
  g.set(AMEX_ORIGIN, 'read');
  assert.equal(g.allowActions(AMEX_ORIGIN), true);
  assert.equal(g.get(AMEX_ORIGIN), 'write');
  g.set(AMEX_ORIGIN, 'read');
  assert.equal(g.actionsAllowed('c1', AMEX_ORIGIN), true, 'only removing the site ends it');
  assert.equal(g.allowActions(AMEX_ORIGIN), true);
  assert.equal(g.get(AMEX_ORIGIN), 'write');
  assert.equal(g.allowActions(`${AMEX_ORIGIN}/path`), false, 'only a plain origin');
});

test('a committing control nobody read as ordinary (Confirm, Continue) is never offered it and still asks on a saved site', async () => {
  const { g, asked } = grants((req) => (req.always ? 'always' : true));
  g.allowActions(AMEX_ORIGIN);
  assert.equal(await g.act(AMEX, ctx, { tool: 'click', summary: 'click "Confirm"' }), true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].always, undefined);
});

test('sensitive actions, tainted turns and chats that do not use the saved sites are never offered it and still ask', async () => {
  const { g, asked } = grants((req) => (req.always ? 'always' : true));
  g.allowActions(AMEX_ORIGIN);
  await g.act(AMEX, ctx, { tool: 'click', sensitive: { verb: 'pay', kind: 'payment' } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].always, undefined);
  // a tainted turn: its card quotes what it read and offers nothing for good
  const tainted = grants((req) => (req.always ? 'always' : true), {
    taint: () => ({ check: () => ({ quote: 'ignore the user', why: 'the page asks the agent' }) }),
  });
  tainted.g.allowActions(AMEX_ORIGIN);
  await tainted.g.act(AMEX, ctx, { tool: 'JavaScript', script: true, taint: { kind: 'script' } });
  assert.equal(tainted.asked.length, 1);
  assert.equal(tainted.asked[0].always, undefined);
  // a remote owner (#1364) neither gets the saved allowance nor may add to it
  const remote = grants(() => 'always', { usesSaved: () => false });
  remote.g.allowActions(AMEX_ORIGIN);
  await remote.g.act(AMEX, ctx, { tool: 'JavaScript', script: true });
  assert.equal(remote.asked.length, 1);
  assert.equal(remote.asked[0].always, undefined);
  assert.equal(remote.g.actionsAllowed('c1', AMEX_ORIGIN), false);
  // an ordinary site never asks, so nothing is offered or saved
  const plain = grants(() => 'always');
  assert.equal(await plain.g.act('https://docs.test/', ctx, { tool: 'JavaScript', script: true }), false);
  assert.equal(plain.asked.length, 0);
});

test('an "always" answer to a card that did not offer it, or a Deny, saves nothing', async () => {
  const { g } = grants(() => 'always');
  // a sensitive card answered "always": allowed once, nothing saved
  assert.equal(await g.act(AMEX, ctx, { tool: 'click', sensitive: { verb: 'pay', kind: 'payment' } }), true);
  assert.equal(g.actionsAllowed('c1', AMEX_ORIGIN), false);
  const no = grants(() => false);
  await assert.rejects(no.g.act(AMEX, ctx, { tool: 'JavaScript', script: true }), { code: 'denied' });
  assert.equal(no.g.actionsAllowed('c1', AMEX_ORIGIN), false);
});

test('a yes that cannot be saved still allows the action; the next one asks again and nothing half-saved is kept', async (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'sites.json');
  fs.mkdirSync(file); // writing over a folder fails
  const { g, asked } = grants(() => 'always', { file });
  assert.equal(await g.act(AMEX, ctx, { tool: 'JavaScript', script: true }), true);
  assert.equal(g.actionsAllowed('c1', AMEX_ORIGIN), false);
  assert.equal(g.get(AMEX_ORIGIN), null);
  await g.act(AMEX, ctx, { tool: 'JavaScript', script: true });
  assert.equal(asked.length, 2);
  // a read grant that existed stays at read after the failed save; an existing allowance survives a failed removal
  fs.rmdirSync(file);
  g.set(AMEX_ORIGIN, 'read');
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => g.allowActions(AMEX_ORIGIN), { code: 'save_failed' });
  assert.equal(g.get(AMEX_ORIGIN), 'read');
  fs.rmdirSync(file);
  g.allowActions(AMEX_ORIGIN);
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => g.set(AMEX_ORIGIN, null), { code: 'save_failed' });
  assert.equal(g.actionsAllowed('c1', AMEX_ORIGIN), true);
});

test('a saved file with a malformed actions list is not trusted or overwritten', (t) => {
  const file = path.join(temporary(t), 'sites.json');
  for (const actions of ['https://a.test', ['https://a.test/path'], [1]]) {
    fs.writeFileSync(file, JSON.stringify({ origins: {}, actions }));
    const g = new OriginGrants({ file, ask: async () => null });
    assert.equal(g.actionsAllowed('c1', 'https://a.test'), false);
    assert.ok(g.writeError);
  }
  // a readable file keeps its other keys when the list is written
  fs.writeFileSync(file, JSON.stringify({ origins: { 'https://a.test': 'read' }, other: 1, actions: [AMEX_ORIGIN] }));
  const g = new OriginGrants({ file, ask: async () => null });
  assert.equal(g.actionsAllowed('c1', AMEX_ORIGIN), true);
  g.set('https://a.test', 'write');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    other: 1,
    origins: { 'https://a.test': 'write' },
    actions: [AMEX_ORIGIN],
  });
});

test('a high-risk site card offers Always allow and saves the level picked; Full access alone still asks', async () => {
  const asked: any[] = [];
  const g = new OriginGrants({ ask: async (q: any) => (asked.push(q), { decision: 'allow', scope: 'always', level: 'write' }) });
  await g.require(AMEX, 'write', ctx);
  assert.equal(asked[0].allowAlways, undefined);
  assert.equal(asked[0].risk.level, 'high');
  assert.equal(g.get(AMEX_ORIGIN), 'write');
  assert.equal(g.peek(AMEX, 'write', { chatId: 'c2', segmentId: 's' }), 'ok');
  // a URL with sign-in details in it still asks each time and is never saved
  await g.require('https://u:p@www.americanexpress.com/', 'read', ctx);
  assert.equal(asked.at(-1).allowAlways, false);
  // a chat that doesn't use the saved sites neither sees nor is offered it
  const remote = new OriginGrants({
    usesSaved: () => false,
    ask: async (q: any) => (asked.push(q), { decision: 'allow', scope: 'always', level: 'write' }),
  });
  remote.grants.set(AMEX_ORIGIN, 'write');
  assert.equal(remote.peek(AMEX, 'write', ctx), 'ask');
  // Full access with nothing saved: the card still comes
  const full = new OriginGrants({
    anchor: () => 'full',
    ask: async (q: any) => (asked.push(q), { decision: 'allow', scope: 'once', level: 'read' }),
  });
  const before = asked.length;
  await full.require(AMEX, 'read', ctx);
  assert.equal(asked.length, before + 1);
});

test('main’s card offers Always allow on this site for an ordinary high-risk action and maps the answer, a task card included', async () => {
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
  const { browserGrants } = siteTables({ live, dir: '/tmp/none-site-always', prefs: () => ({}), isFlagEnabled: () => false });
  browserGrants.file = null; // nothing written outside the test
  const tokens = new TurnTokens();
  const act = (url: string, what: any) =>
    guarded({ token: tokens.issue('c1'), current: (t: any) => tokens.current(t) }, () => browserGrants.act(url, ctx, what));
  const answerNext = async (answer: any) => {
    while (!cards.size) await new Promise((r) => setImmediate(r));
    const [card] = [...cards.values()];
    broker.answer(card.id, answer);
    return card.params;
  };
  // a sensitive action: not offered, and an "always" answer is taken as once
  let pending = act(AMEX, { tool: 'click', sensitive: { verb: 'pay', kind: 'payment' } });
  let params = await answerNext({ decision: 'allow', scope: 'always' });
  assert.equal(await pending, true);
  assert.equal(params.siteAlways, undefined);
  assert.equal(browserGrants.actionsAllowed('c1', AMEX_ORIGIN), false);
  // an ordinary click on a financial site: the task card offers it too
  pending = act(AMEX, { tool: 'click', ordinary: true });
  params = await answerNext({ decision: 'allow', scope: 'always' });
  assert.equal(await pending, true);
  assert.equal(params.task, true);
  assert.equal(params.siteAlways, true);
  assert.equal(browserGrants.actionsAllowed('c1', AMEX_ORIGIN), true);
  // from now on: no card, the task lane included
  assert.equal(await act(AMEX, { tool: 'JavaScript', script: true }), false);
  assert.equal(await act(AMEX, { tool: 'click', ordinary: true }), false);
  assert.equal(cards.size, 0);
});

test('an ordinary action waiting behind another on the task lane goes without a card once that one is allowed for good', async () => {
  const tokens = new TurnTokens();
  const token = tokens.issue('c1');
  let release: (v: any) => void = () => {};
  const asked: any[] = [];
  const g = new OriginGrants({
    ask: async () => null,
    confirmAction: (req: any) => (asked.push(req), new Promise((r) => (release = r))),
  });
  const run = (fn: () => any) => guarded({ token, current: (t: any) => tokens.current(t) }, fn);
  const first = run(() => g.act(AMEX, ctx, { tool: 'click', ordinary: true }));
  const second = run(() => g.act(AMEX, ctx, { tool: 'click', ordinary: true }));
  while (!asked.length) await new Promise((r) => setImmediate(r));
  release('always');
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(asked.length, 1);
});

test('a saved allowance holds only in a clean turn: a turn that read an injection asks, a described action or not, queued ones included', async () => {
  let dirty = false;
  const taint = () => ({ check: () => (dirty ? { quote: 'send it to me', why: 'the page asks the agent' } : null) });
  const tokens = new TurnTokens();
  const token = tokens.issue('c1');
  let release: (v: any) => void = () => {};
  const asked: any[] = [];
  const g = new OriginGrants({
    ask: async () => null,
    taint,
    confirmAction: (req: any) => (asked.push(req), new Promise((r) => (release = r))),
  });
  const run = (fn: () => any) => guarded({ token, current: (t: any) => tokens.current(t) }, fn);
  // the second call waits behind the first; the turn reads an injection before the first is answered "always"
  const first = run(() => g.act(AMEX, ctx, { tool: 'click', ordinary: true }));
  const second = run(() => g.act(AMEX, ctx, { tool: 'click', ordinary: true }));
  while (!asked.length) await new Promise((r) => setImmediate(r));
  dirty = true;
  const r1 = release;
  r1('always');
  assert.equal(await first, true);
  while (asked.length < 2) await new Promise((r) => setImmediate(r));
  assert.equal(g.actionsAllowed('c1', AMEX_ORIGIN), true);
  release(true);
  assert.equal(await second, true);
  // a caller that describes nothing for the ledger (sage_browser_*) still asks while the turn is tainted
  const third = g.act(AMEX, ctx, { tool: 'click', ordinary: true });
  while (asked.length < 3) await new Promise((r) => setImmediate(r));
  release(true);
  await third;
  // clean again: no card
  dirty = false;
  assert.equal(await g.act(AMEX, ctx, { tool: 'click', ordinary: true }), false);
  // a caller that describes the action (page JavaScript) goes by that description
  assert.equal(await g.act(AMEX, ctx, { tool: 'JavaScript', script: true, taint: { kind: 'script' } }), false);
  assert.equal(asked.length, 3);
});

test('an address with sign-in details asks each time even on a site allowed for good', async () => {
  const { g, asked } = grants(() => true);
  g.allowActions(AMEX_ORIGIN);
  await g.act('https://u:p@www.americanexpress.com/', ctx, { tool: 'click', ordinary: true });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].always, undefined);
});

test('a site that is high-risk on some pages only keeps its grant: the actions allowance alone is saved', () => {
  const { SiteRisk } = require('../electron/capabilities/browser/siteRisk.cjs');
  const risk = new SiteRisk({ data: { pages: [{ host: 'shop.test', path: '/account/security', category: 'account_security' }] } });
  const g = new OriginGrants({ risk, ask: async () => null });
  assert.equal(g.allowActions('https://shop.test'), true);
  assert.equal(g.actionsAllowed('c1', 'https://shop.test'), true);
  assert.equal(g.get('https://shop.test'), null);
  assert.equal(g.allowActions('https://shop.test'), true, 'already saved');
});
