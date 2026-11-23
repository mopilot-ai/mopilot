// An approval card asked inside a tool call goes with the call: an aborted call's card leaves SessionState.approvals,
// and a late answer grants nothing (#1865, [unsignalled-wait], electron/capabilities/contract/approvals.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, codex } from './support/controller/fixture';
import { withTab, fakeGrants } from './support/iab-backend/fixture';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');

/** A chat with a running Codex turn and a broker that puts its cards into the chat's SessionState. */
function chat() {
  const { c, s } = setup();
  c.send('t1', { text: 'go' }, 1);
  c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'turn-1' } }));
  const broker = new ApprovalBroker({ controller: c });
  // what the window does: the card a click answers
  const click = (answer: unknown) => {
    const card = s('t1').approvals.at(-1);
    return card ? broker.answer(card.id, answer) : false;
  };
  return { c, s, broker, click };
}

test('an aborted call withdraws its card from every window; a late answer resolves nothing', async () => {
  const { s, broker } = chat();
  const ac = new AbortController();
  const answer = broker.ask('t1', 'computerConfirm', { verb: 'delete' }, { signal: ac.signal });
  assert.equal(s('t1').approvals.length, 1);
  assert.equal(s('t1').turn, 'awaitingUser');
  ac.abort('cancelled');
  assert.equal(await answer, null);
  assert.equal(s('t1').approvals.length, 0);
  assert.equal(s('t1').turn, 'running');
  assert.equal(broker.pending.size, 0);
  assert.equal(broker.answer(answer.id, { decision: 'allow' }), false);
});

test('a call aborted before it asks puts no card up', async () => {
  const { s, broker } = chat();
  const ac = new AbortController();
  ac.abort('stopped');
  const answer = broker.ask('t1', 'computerAccess', { app: 'x' }, { signal: ac.signal });
  assert.equal(typeof answer.id, 'string');
  assert.equal(await answer, null);
  assert.equal(s('t1').approvals.length, 0);
  assert.equal(broker.pending.size, 0);
});

test('a card answered or swept before the abort lets go of the signal', async () => {
  const { s, broker, click } = chat();
  const ac = new AbortController();
  let listeners = 0;
  const signal = {
    aborted: false,
    addEventListener: (..._a: unknown[]) => void listeners++,
    removeEventListener: (..._a: unknown[]) => void listeners--,
  };
  const answered = broker.ask('t1', 'visionConsent', {}, { signal });
  assert.equal(listeners, 1);
  assert.equal(click({ decision: 'allow' }), true);
  assert.deepEqual(await answered, { decision: 'allow' });
  assert.equal(listeners, 0);
  const swept = broker.ask('t1', 'visionConsent', {}, { signal });
  broker.sweep('t1', []);
  assert.equal(await swept, null);
  assert.equal(listeners, 0);
  // a real signal aborted after its card was answered changes nothing
  const later = broker.ask('t1', 'devServer', {}, { signal: ac.signal });
  click({ decision: 'allow' });
  ac.abort();
  assert.deepEqual(await later, { decision: 'allow' });
  assert.equal(
    s('t1').approvals.some((a: { id: string }) => a.id === later.id),
    false,
  );
});

/** The in-app browser's site table, asking on the chat's broker the way browserSiteTables.cjs does. */
function sites(broker: any) {
  return new OriginGrants({
    ask: ({ chatId, origin, need, signal }: any) => broker.ask(chatId, 'browserOrigin', { origin, level: need }, { signal }),
    confirmAction: async ({ chatId, origin, signal }: any) =>
      (await broker.ask(chatId, 'computerConfirm', { app: { bundleId: origin, name: origin } }, { signal }))?.decision === 'allow',
  });
}

test('a site card withdrawn by an aborted call stores no grant and no refusal; a late click grants nothing', async () => {
  const { s, broker, click } = chat();
  const g = sites(broker);
  const ac = new AbortController();
  const ctx = { chatId: 't1', segmentId: 'seg', signal: ac.signal };
  const call = g.require('https://example.com/', 'read', ctx);
  await tick();
  assert.equal(s('t1').approvals.length, 1);
  ac.abort('cancelled');
  await assert.rejects(call, (e: any) => e.code === 'aborted');
  assert.equal(s('t1').approvals.length, 0);
  assert.equal(click({ decision: 'allow', scope: 'always', level: 'write' }), false);
  assert.equal(g.get('https://example.com'), null);
  assert.equal(g.chatGrants.get('t1'), undefined);
  assert.equal(g.denied.get('t1'), undefined);
  assert.equal(g.asking.size, 0);
  // the next call asks again, and its answer is stored as usual
  const next = g.require('https://example.com/', 'read', { chatId: 't1', segmentId: 'seg', signal: new AbortController().signal });
  await tick();
  assert.equal(click({ decision: 'allow', scope: 'chat', level: 'read' }), true);
  await next;
  assert.equal(g.chatGrants.get('t1').get('https://example.com'), 'read');
});

test('a call aborted before the site card asks puts none up', async () => {
  const { s, broker } = chat();
  const g = sites(broker);
  const ac = new AbortController();
  ac.abort('stopped');
  await assert.rejects(
    g.require('https://example.com/', 'read', { chatId: 't1', segmentId: 'seg', signal: ac.signal }),
    (e: any) => e.code === 'aborted',
  );
  await assert.rejects(
    g.act('https://example.com/', { chatId: 't1', segmentId: 'seg', signal: ac.signal }, { sensitive: { verb: 'delete' } }),
    (e: any) => e.code === 'aborted',
  );
  assert.equal(s('t1').approvals.length, 0);
});

test('a shared site card stays up while another call still waits on it, and goes when the last one aborts', async () => {
  const { s, broker, click } = chat();
  const g = sites(broker);
  const a = new AbortController();
  const b = new AbortController();
  const first = g.require('https://example.com/', 'read', { chatId: 't1', segmentId: 'seg', signal: a.signal });
  const second = g.require('https://example.com/', 'read', { chatId: 't1', segmentId: 'seg', signal: b.signal });
  await tick();
  assert.equal(s('t1').approvals.length, 1);
  a.abort('cancelled');
  await assert.rejects(first, (e: any) => e.code === 'aborted');
  assert.equal(s('t1').approvals.length, 1);
  assert.equal(click({ decision: 'allow', scope: 'chat', level: 'read' }), true);
  await second;
  assert.equal(g.chatGrants.get('t1').get('https://example.com'), 'read');

  // both abort: the card goes, nothing is stored
  const c1 = new AbortController();
  const c2 = new AbortController();
  const x = g.require('https://other.example/', 'read', { chatId: 't1', segmentId: 'seg', signal: c1.signal });
  const y = g.require('https://other.example/', 'read', { chatId: 't1', segmentId: 'seg', signal: c2.signal });
  await tick();
  c1.abort();
  c2.abort();
  await assert.rejects(x, (e: any) => e.code === 'aborted');
  await assert.rejects(y, (e: any) => e.code === 'aborted');
  assert.equal(s('t1').approvals.length, 0);
  assert.equal(g.denied.get('t1'), undefined);
  assert.equal(g.chatGrants.get('t1').has('https://other.example'), false);

  // a waiter with no signal keeps the card after the others abort
  const d = new AbortController();
  const z = g.require('https://third.example/', 'read', { chatId: 't1', segmentId: 'seg', signal: d.signal });
  const free = g.require('https://third.example/', 'read', { chatId: 't1', segmentId: 'seg' });
  await tick();
  d.abort();
  await assert.rejects(z, (e: any) => e.code === 'aborted');
  assert.equal(s('t1').approvals.length, 1);
  click({ decision: 'deny' });
  await assert.rejects(free, (e: any) => e.code === 'denied');
});

test("an action card withdrawn by an aborted call doesn't count as the user's no, and a late click allows nothing", async () => {
  const { s, broker, click } = chat();
  const g = sites(broker);
  const ac = new AbortController();
  const call = g.act('https://example.com/', { chatId: 't1', segmentId: 'seg', signal: ac.signal }, { sensitive: { verb: 'delete' } });
  await tick();
  assert.equal(s('t1').approvals.length, 1);
  ac.abort('stopped');
  await assert.rejects(call, (e: any) => e.code === 'aborted');
  assert.equal(s('t1').approvals.length, 0);
  assert.equal(click({ decision: 'allow' }), false);
});

test("the in-app browser backend's Stop withdraws a site card its request waits on; the next request asks again", async () => {
  const { s, broker, click } = chat();
  const real = sites(broker);
  const seen: any[] = [];
  const grants = fakeGrants({
    verdict: 'reask',
    require: (url: string, need: string, ctx: any, opts: any) => (seen.push(ctx), real.require(url, need, { ...ctx, chatId: 't1' }, opts)),
  });
  const { b, call } = await withTab({ grants });
  const nav = () => call('executeCdp', { target: { tabId: 1 }, method: 'Page.navigate', commandParams: { url: 'https://example.com/' } });
  const first = nav();
  await tick();
  await tick();
  assert.equal(s('t1').approvals.length, 1);
  assert.equal(seen[0].signal.aborted, false);
  b.stopped();
  await assert.rejects(first, (e: any) => e.code === 'aborted');
  assert.equal(s('t1').approvals.length, 0);
  assert.equal(click({ decision: 'allow', scope: 'always', level: 'write' }), false);
  assert.equal(real.get('https://example.com'), null);
  assert.equal(real.denied.get('t1'), undefined);
  // a request after the stop has a live signal: its card stays up until the user answers
  const second = nav();
  await tick();
  await tick();
  assert.equal(seen[1].signal.aborted, false);
  assert.equal(click({ decision: 'allow', scope: 'chat', level: 'read' }), true);
  await second;
  assert.equal(real.chatGrants.get('t1').get('https://example.com'), 'read');
});
