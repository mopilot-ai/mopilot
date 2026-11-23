// A site card that goes away unanswered (its turn ended, no window could show it) is nobody's answer: the site is
// not recorded as refused, and the next call asks again (electron/capabilities/browser/origins.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, codex } from './support/controller/fixture';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');

const SITE = 'https://www.instagram.com';

/** A Codex chat mid-turn whose broker is swept on every approvals change, as computerUse.cjs onSessionPatch does. */
function chat() {
  const { c, s } = setup();
  c.send('t1', { text: 'go' }, 1);
  c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'turn-1' } }));
  const broker = new ApprovalBroker({ controller: c });
  const g = new OriginGrants({
    ask: ({ chatId, origin, need, signal }: any) => broker.ask(chatId, 'browserOrigin', { origin, level: need }, { signal }),
  });
  const endTurn = () => {
    c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'turn-1' } }));
    broker.sweep('t1', s('t1').approvals);
  };
  const click = (answer: unknown) => {
    const card = s('t1').approvals.at(-1);
    return card ? broker.answer(card.id, answer) : false;
  };
  const ctx = () => ({ chatId: 't1', segmentId: 'seg', signal: new AbortController().signal });
  return { c, s, g, endTurn, click, ctx };
}

test('a site card the turn end took away is not a refusal: the call is told nobody answered, and the next call asks again', async () => {
  const { c, s, g, endTurn, click, ctx } = chat();
  const call = g.require(`${SITE}/`, 'read', ctx(), { offer: 'write' });
  await tick();
  assert.equal(s('t1').approvals.length, 1);
  // the harness gave up on the tool call and ended its turn, without aborting it
  endTurn();
  await assert.rejects(call, (e: any) => e.code === 'unanswered' && /didn't answer/.test(e.message));
  assert.equal(s('t1').approvals.length, 0);
  assert.equal(g.denied.get('t1')?.has(SITE) ?? false, false);
  assert.equal(g.peek(`${SITE}/`, 'read', { chatId: 't1', segmentId: 'seg' }), 'ask');
  assert.equal(g.asking.size, 0);
  // a late click on a card that is gone answers nothing
  assert.equal(click({ decision: 'allow', scope: 'always', level: 'write' }), false);
  assert.equal(g.get(SITE), null);

  // the next turn's call puts a new card up, and Always allow saves the site
  c.send('t1', { text: 'again' }, 2);
  c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'turn-2' } }));
  const retry = g.require(`${SITE}/`, 'read', ctx(), { offer: 'write' });
  await tick();
  assert.equal(s('t1').approvals.length, 1);
  assert.equal(click({ decision: 'allow', scope: 'always', level: 'write' }), true);
  await retry;
  assert.equal(g.get(SITE), 'write');
  await g.require(`${SITE}/p/1`, 'write', ctx());
});

test('an unanswered card or a malformed answer refuses the call but is never remembered: the next call asks again', async () => {
  for (const answer of [null, {}, { decision: 'allow', level: 'full' }]) {
    let asks = 0;
    const g = new OriginGrants({ ask: async () => (++asks, answer) });
    const ctx = { chatId: 'c1', segmentId: 's1' };
    await assert.rejects(g.require(`${SITE}/`, 'read', ctx), { code: 'unanswered' });
    await assert.rejects(g.require(`${SITE}/`, 'read', ctx), { code: 'unanswered' });
    assert.equal(asks, 2);
    assert.deepEqual(g.list(), []);
    assert.equal(g.denied.size, 0);
  }
});

test('an explicit Deny is still remembered for the chat', async () => {
  const { s, g, click, ctx } = chat();
  const call = g.require(`${SITE}/`, 'read', ctx());
  await tick();
  assert.equal(s('t1').approvals.length, 1);
  click({ decision: 'deny' });
  await assert.rejects(call, (e: any) => e.code === 'denied');
  assert.equal(g.denied.get('t1').has(SITE), true);
  await assert.rejects(g.require(`${SITE}/`, 'read', ctx()), (e: any) => e.code === 'denied');
});
