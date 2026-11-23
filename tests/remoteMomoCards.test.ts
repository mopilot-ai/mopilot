// A momoAction card answered by a phone (electron/remote/methods/momo.cjs, momo/audit.cjs): the action runs and the audit entries name the device, the log still verifies, the card's choices, and the lazy wiring's edges.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';
import { sweep } from './support/momo-routines.ts';
import { auditLog } from './support/momo-trust.ts';
import { ok, fail, momoRig, cardRig } from './support/remote-momo-kit.ts';

const require = createRequire(import.meta.url);
const { parseParams } = require('../shared/remote/schema.mjs');
const { tapIpc } = require('../electron/remote/momoOps.cjs');

test('a momoAction card is answered by a phone, the action runs and the intent entry names the device; the log still verifies', async () => {
  const { m, p, gate, call, approvals, entries, log } = await cardRig();
  ok(await p.ask('momo.chat.follow', {}));
  let ran = 0;
  const pending = gate(call, async () => ran++);
  await settle();
  assert.equal(approvals.length, 1);
  const card = (await m.r.ops.cardsOf())[0];
  // a card the phone can answer, not "finish this on your Mac"
  assert.equal(card.inApp, undefined);
  assert.match(card.title, /Allow MoMo to send to ann@example.com\?/);
  assert.deepEqual(card.choices.map((c: any) => c.key).slice(0, 2), ['once', 'chat']);
  assert.ok(card.choices.some((c: any) => c.key === 'deny'));
  // the wrong rev, a key the card did not offer and a device that does not follow are refused
  fail(await p.ask('momo.card.answer', { cardId: card.id, rev: 0, key: 'once' }, undefined), 'stale');
  fail(await p.ask('momo.card.answer', { cardId: card.id, rev: 4, key: 'sudo' }), 'invalid', /offered by this request/);
  fail(await m.r.phone('p2').ask('momo.card.answer', { cardId: card.id, rev: 4, key: 'once' }), 'forbidden', /Follow this chat/);
  fail(await p.ask('momo.card.answer', { cardId: 'gone', rev: 4, key: 'once' }), 'stale');
  assert.equal(ran, 0);
  assert.deepEqual(ok(await p.ask('momo.card.answer', { cardId: card.id, rev: 4, key: 'once' })), { answered: true });
  const out = await pending;
  assert.equal(out.ok, true);
  assert.equal(ran, 1);
  const [intent, outcome] = await entries();
  assert.equal(intent.kind, 'intent');
  assert.equal(intent.device, 'p1');
  assert.equal(intent.decision, 'asked:once');
  assert.equal(outcome.device, 'p1');
  assert.equal((await log.verify()).ok, true);
  // a second answer to the same card is stale
  fail(await p.ask('momo.card.answer', { cardId: card.id, rev: 4, key: 'once' }), 'stale');
});

test('a phone denies a card: the refusal entry names the device, and "always deny" is remembered', async () => {
  const { p, gate, call, approvals, entries, log, m } = await cardRig();
  ok(await p.ask('momo.chat.follow', {}));
  let ran = 0;
  const pending = gate(call, async () => ran++);
  await settle();
  const card = (await m.r.ops.cardsOf())[0];
  assert.ok(card.choices.some((c: any) => c.key === 'denyAlways'));
  ok(await p.ask('momo.card.answer', { cardId: card.id, rev: 4, key: 'denyAlways' }));
  const out = await pending;
  assert.deepEqual([out.ok, out.reason, ran, approvals.length], [false, 'denied', 0, 0]);
  const [refusal] = await entries();
  assert.deepEqual([refusal.kind, refusal.decision, refusal.device], ['refusal', 'denied', 'p1']);
  assert.equal((await log.verify()).ok, true);
});

test('an entry with no answering device has no device field, so entries written before this verify unchanged', async () => {
  const t = auditLog({});
  await t.log.refusal({ action: 'a', chatId: 'c', decision: 'blocked' });
  const { id } = await t.log.intent({ action: 'a', chatId: 'c', decision: 'asked:once' });
  await t.log.outcome(id, { result: 'done' });
  const lines = (await t.log.exportJsonl())
    .split('\n')
    .filter(Boolean)
    .map((l: string) => JSON.parse(l));
  assert.ok(lines.every((e: any) => !('device' in e)));
  await assert.rejects(t.log.intent({ action: 'a', chatId: 'c', decision: 'd', device: '' }), /device must be a short string/);
  assert.equal((await t.log.verify()).ok, true);
});

test('the card for a momoAction names only what the rule shows, with its scopes and Deny', () => {
  const { momoActionCard } = require('../electron/remote/momoCard.cjs');
  const base = {
    source: 'Mail',
    action: 'change',
    summary: 'Send a message',
    account: 'work',
    scopes: ['once', 'chat', 'bogus'],
    hosts: [],
    recipients: [],
    unknown: false,
    denyAlways: false,
  };
  const c = momoActionCard(base);
  assert.equal(c.title, 'Allow MoMo to change Mail?');
  assert.equal(c.detail, 'Send a message\nAccount: work');
  assert.deepEqual(
    c.choices.map((x: any) => x.key),
    ['once', 'chat', 'deny'],
  );
  assert.equal(momoActionCard({ ...base, action: 'read' }).title, 'Allow MoMo to read Mail?');
  assert.equal(momoActionCard({ ...base, unknown: true }).title, 'Allow MoMo to send data out?');
  const to = momoActionCard({ ...base, hosts: ['example.com'], denyAlways: true });
  assert.equal(to.title, 'Allow MoMo to send to example.com?');
  assert.match(to.detail, /To: example.com/);
  assert.ok(to.choices.some((x: any) => x.key === 'denyAlways'));
  assert.deepEqual(
    momoActionCard({}).choices.map((x: any) => x.key),
    ['deny'],
  );
  assert.equal(momoActionCard({}).title, 'Allow MoMo to change this source?');
  // a navigation (#3655): it asks to open the site, and Always allow names the host it opens
  const open = momoActionCard({ ...base, hosts: ['www.ycombinator.com'], opens: true, scopes: ['once', 'site'] });
  assert.equal(open.title, 'Allow MoMo to open www.ycombinator.com?');
  assert.deepEqual(
    open.choices.map((x: any) => x.label),
    ['Allow once', 'Always allow www.ycombinator.com', 'Deny'],
  );
  assert.deepEqual(open.results.site, { decision: 'allow', scope: 'site' });
  assert.equal(momoActionCard({ ...base, scopes: ['site'] }).choices[0].label, 'Always allow this site');
});

test('answering a card that main no longer holds, or with a key the card lacks, is refused; tapIpc passes the rest of ipcMain through', async () => {
  const { m } = await cardRig();
  assert.throws(
    () =>
      m.remote.answerCard(
        { id: 'x', method: 'sage/momoAction', params: { kind: 'momoAction', momo: { scopes: ['once'] } } },
        'bogus',
        'p1',
      ),
    /offered by this request/,
  );
  assert.equal(m.remote.cardOf('momo-main', 'nope'), null);
  const calls: string[] = [];
  const tap = tapIpc({
    handle: () => undefined,
    removeHandler: (c: string) => calls.push(c),
    on: function (this: any) {
      return this === undefined ? 'unbound' : 'bound';
    },
    name: 'ipc',
  });
  tap.ipc.handle('x:y', () => 1);
  assert.equal(tap.ipc.name, 'ipc');
  assert.equal(tap.ipc.on(), 'bound');
  assert.equal(tap.call('x:y'), 1);
  tap.ipc.removeHandler('x:y');
  assert.deepEqual(calls, ['x:y']);
  assert.throws(() => tap.call('x:y'), /MoMo is not ready/);
});

test('the gaps: a card answered meanwhile is stale, a queued send says why, a refusal with no words, a brain with no echo, odd params, no ops yet', async () => {
  const { hostCard } = require('../electron/capabilities/browser/chromePanelHostCard.cjs');
  assert.deepEqual(
    hostCard({ kind: 'momoAction' }, 'MoMo').choices.map((c: any) => c.key),
    ['deny'],
  );
  const { p, gate, call, m } = await cardRig();
  ok(await p.ask('momo.chat.follow', {}));
  void gate(call, async () => 1);
  await settle();
  const card = (await m.r.ops.cardsOf())[0];
  // the broker no longer holds it: someone answered first
  m.remote.answerCard = () => false;
  fail(await p.ask('momo.card.answer', { cardId: card.id, rev: 4, key: 'once' }), 'stale', /already answered/);
  m.controller.send = async () => ({ action: 'queued', id: 'r1', error: 'Busy.' }) as any;
  assert.deepEqual(ok(await p.ask('momo.chat.send', { id: 'r1', text: 'x' })), { sent: true, warning: 'Busy.' });
  m.wired.ipc.handle('momoMemory:list', async () => ({ ok: false }));
  fail(await p.ask('momo.memory.list'), 'failed', /MoMo could not do that/);
  m.mainChat.setBrain = () => undefined;
  m.live.controller = m.controller as any;
  m.gate.remoteBrain = true;
  assert.deepEqual(ok(await p.ask('momo.brain.set', { brain: { harness: 'codex' } })).brain, { harness: 'codex' });
  for (const [method, params] of [
    ['momo.memory.search', { query: 5 }],
    ['momo.memory.edit', { factId: 'f', text: 5 }],
    ['momo.chat.send', { id: 'a', text: 5 }],
  ] as const)
    assert.throws(
      () => parseParams(method, params),
      (e: any) => e.code === 'invalid',
      method,
    );
  // no operations yet: the service default answers that MoMo is not ready
  const bare = rig({ momo: true });
  fail(await bare.phone('p1').ask('momo.chat.stop'), 'failed', /MoMo is not ready/);
  assert.equal(bare.service.momo(), null);
});

test('the wiring: the phones see the broker, routines and prefs of main’s live state, and nothing before the panel exists', async () => {
  const m = momoRig();
  const live: any = { controller: m.controller, chromePanel: undefined };
  const remote = m.wired.attach({ live, mainChat: m.mainChat, readState: () => undefined, runAttended: async () => undefined });
  assert.equal(remote.brain.allowedToSet(), false);
  assert.doesNotThrow(() => remote.changed('memory'));
  await assert.rejects(remote.routines.run('x'), (e: any) => e.code === 'gone' || e.code === 'failed');
  assert.throws(() => remote.answerCard({ id: 'x' }, 'once', 'p1'));
  assert.equal(m.live.computerUse.broker.answer('nope', {}), false);
});

test('with no broker and no routines service yet, an answer reaches nothing and Run now says routines are off', async () => {
  const m = momoRig();
  const routine = await m.w.routines.add({ ...sweep }, { approved: true });
  const live: any = { controller: m.controller, chromePanel: { service: { ops: { cardAnswer: () => ({ decision: 'deny' }) } } } };
  const remote = m.wired.attach({ live, mainChat: m.mainChat, readState: () => undefined, runAttended: async () => undefined });
  assert.equal(remote.answerCard({ id: 'x' }, 'deny', 'p1'), false);
  await assert.rejects(remote.routines.run(routine.id), (e: any) => e.code === 'failed' && /routines are off/.test(e.message));
});
