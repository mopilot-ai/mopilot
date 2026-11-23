// MoMo's test tool (#2139, electron/momo/debugAction.cjs) through the real trust gate, sentinel, audit log and approval card: a MoMo chat's change asks; Allow once runs it and is audited; Allow for this chat runs the next one without a card; Deny tells the model not to retry and is audited; only a MoMo chat that owns the call may use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditLog } from './support/momo-trust.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { registerMomoDebugAction, TOOL, SOURCE } = require('../electron/momo/debugAction.cjs');
const { createMomoActionAsk } = require('../electron/momo/actionAsk.cjs');
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { Sentinel } = require('../electron/momo/sentinel.cjs');
const { createTrustGate } = require('../electron/momo/trustGate.cjs');
const { refusalText } = require('../electron/momo/trustTexts.cjs');
const { CURRENT } = require('../electron/momo/audit.cjs');

async function until(cond: () => boolean) {
  await waitFor(cond, 'the condition');
  assert.ok(cond(), 'timed out');
}

function rig(o: { harnessOf?: boolean } = {}) {
  const cards: any[] = [];
  const broker = new ApprovalBroker({
    controller: { addApproval: (chatId: string, a: any) => cards.push({ chatId, ...a }), resolveApproval: () => true },
  });
  let sentinel: any;
  const asks = createMomoActionAsk({
    broker: () => broker,
    harnessOf: () => 'claude',
    sourceName: (id: string) => sentinel.sources.get(id)?.name,
  });
  sentinel = new Sentinel({ askUser: asks.askUser, allowed: () => true });
  const a = auditLog();
  const trust = createTrustGate({ sentinel, audit: a.log });
  const registry = new Registry();
  const momo = new Set(['momo-main', 'momo-other']);
  const tool = registerMomoDebugAction(registry, {
    trust,
    sentinel,
    allowed: () => true,
    isMomoChat: (id: string) => momo.has(id),
    owner: (ctx: any) => ctx.chatId,
    ...(o.harnessOf === false ? {} : { harnessOf: () => 'claude' }),
  });
  const handler = registry.tools.get(TOOL).handler;
  const call = (text: string, chatId = 'momo-main', signal?: AbortSignal) => handler({ text }, { chatId, segmentId: 's', signal });
  const entries = () =>
    fs.existsSync(path.join(a.dir, CURRENT))
      ? fs
          .readFileSync(path.join(a.dir, CURRENT), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return { cards, broker, registry, tool, call, entries, sentinel };
}

test('the test source asks before a change, named for the user', () => {
  const r = rig();
  assert.deepEqual(r.sentinel.sources.get(SOURCE), { level: 'ask', private: false, name: 'Test notes' });
  assert.equal(r.registry.tools.get(TOOL).visibleTo('momo-main'), true);
  assert.equal(r.registry.tools.get(TOOL).visibleTo('code-chat'), false);
});

test('Allow once runs it and is audited; Allow for this chat runs the next one without a card', async () => {
  const r = rig();
  const first = r.call('one');
  await until(() => r.cards.length === 1);
  assert.equal(r.cards[0].params.momo.summary, 'Write “one” to the test notes');
  assert.equal(r.cards[0].params.momo.source, 'Test notes');
  r.broker.answer(r.cards[0].id, { decision: 'allow', scope: 'once' });
  assert.equal(await first, 'Saved. Wrote: one');
  // the same action asks again after once
  const second = r.call('one');
  await until(() => r.cards.length === 2);
  r.broker.answer(r.cards[1].id, { decision: 'allow', scope: 'chat' });
  assert.equal(await second, 'Saved. Wrote: one');
  assert.equal(await r.call('one'), 'Saved. Wrote: one');
  assert.equal(r.cards.length, 2);
  assert.deepEqual(r.tool.written, ['one', 'one', 'one']);
  const kinds = r.entries().map((e: any) => [e.kind, e.decision ?? e.result]);
  assert.deepEqual(kinds, [
    ['intent', 'asked:once'],
    ['outcome', 'done'],
    ['intent', 'asked:chat'],
    ['outcome', 'done'],
    ['intent', 'remembered:chat'],
    ['outcome', 'done'],
  ]);
});

test('Deny tells the model not to retry, and is audited; nothing runs', async () => {
  const r = rig({ harnessOf: false });
  const p = r.call('two');
  await until(() => r.cards.length === 1);
  r.broker.answer(r.cards[0].id, { decision: 'deny' });
  await assert.rejects(p, (e: any) => e.code === 'denied' && e.message === refusalText('denied', { source: 'Test notes', kind: 'change' }));
  assert.match(refusalText('denied', { kind: 'change' }), /Don't retry it; ask what they'd like instead/);
  assert.deepEqual(r.tool.written, []);
  assert.deepEqual(
    r.entries().map((e: any) => [e.kind, e.decision]),
    [['refusal', 'denied']],
  );
});

test('a stopped call withdraws its card and runs nothing', async () => {
  const r = rig();
  const ac = new AbortController();
  const p = r.call('three', 'momo-main', ac.signal);
  await until(() => r.cards.length === 1);
  ac.abort();
  await assert.rejects(p, (e: any) => e.code === 'no-answer');
  assert.deepEqual(r.tool.written, []);
});

test('a send names its recipients on the card; one that names none, or none it can read, is blocked with its reason (#4649 A4)', async () => {
  const r = rig();
  const handler = r.registry.tools.get(TOOL).handler;
  const run = (args: any) => handler(args, { chatId: 'momo-main', segmentId: 's' });
  const first = run({ text: 'hi', send: true, to: ['b@x.com', 'a@x.com'] });
  await until(() => r.cards.length === 1);
  const m = r.cards[0].params.momo;
  assert.deepEqual([m.recipients, m.recipientCount, m.blocked], [['a@x.com', 'b@x.com'], 2, '']);
  r.broker.answer(r.cards[0].id, { decision: 'allow', scope: 'once' });
  assert.equal(await first, 'Saved. Wrote: hi');
  for (const [args, why] of [
    [{ text: 'hi', send: true }, 'no-recipients'],
    [{ text: 'hi', to: { nope: 1 } }, 'unreadable-recipients'],
  ] as const) {
    const p = run(args);
    await until(() => r.cards.length === (why === 'no-recipients' ? 2 : 3));
    const blocked = r.cards.at(-1).params.momo;
    assert.deepEqual([blocked.blocked, blocked.scopes], [why, []]);
    r.broker.answer(r.cards.at(-1).id, { decision: 'deny' });
    await assert.rejects(p, (e: any) => e.code === why);
  }
  assert.deepEqual(r.tool.written, ['hi']);
});

test('a chat that is not MoMo’s, or owns no segment, can’t use it', async () => {
  const r = rig();
  await assert.rejects(r.call('x', 'code-chat'), (e: any) => e.code === 'unavailable');
  await assert.rejects(
    r.registry.tools.get(TOOL).handler({ text: 'x' }, { chatId: '', segmentId: 's' }),
    (e: any) => e.code === 'unavailable',
  );
  assert.equal(r.cards.length, 0);
});

test('a refusal without a reason reads as failed', async () => {
  const registry = new Registry();
  registerMomoDebugAction(registry, {
    trust: async () => ({ ok: false, text: 'no' }),
    sentinel: { setSource: () => undefined },
    allowed: () => true,
    isMomoChat: () => true,
    owner: () => 'momo-main',
  });
  await assert.rejects(
    registry.tools.get(TOOL).handler({ text: 'x' }, { chatId: 'momo-main', segmentId: 's' }),
    (e: any) => e.code === 'failed',
  );
});
