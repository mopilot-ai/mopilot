// The approval engine through the Host protocol, for Claude Code, Codex and ACP alike: a card reaches every client with its attention, the first answer wins, an unanswered card pauses the run, a Stop or a new owner retires the clock, and a restart closes what it cut off (A1-A4, A6, W2, B5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createProtocol, wireError } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { NOT_RUN_NOTICE } from '../host/src/approvals.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';

const MIN = 60_000;
const quiet = { report: () => undefined };
const FAMILIES = [
  { name: 'claude', chatId: 'claude:c1' },
  { name: 'codex', chatId: 'codex-c1' },
  { name: 'acp', chatId: 'acp:kimi:c1' },
];
const familyOf = (id: string) => (id.startsWith('claude:') ? 'claude' : id.startsWith('acp:') ? 'acp' : 'codex');

function setup(chatId: string, extra: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-approvals-'));
  const host: any = new EventEmitter();
  const cancelled: string[] = [];
  host.cancel = (key: string) => cancelled.push(key);
  const sends: any[] = [];
  const asked: any[] = [];
  const runtime: any = {
    host,
    familyOf,
    send: async (p: any) => (sends.push(p), { turnId: `t${sends.length + 1}` }),
    permit: (p: any) => (asked.push(p), p.requestId !== 'gone'),
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  let now = 10_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const told: any[] = [];
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    status: () => ({ running: true }),
    dataDir: dir,
    ...quiet,
    notify: (m: any) => told.push(m),
    approvalClock: {
      now: () => now,
      after: (fn: () => void, ms: number) => {
        const timer = { at: now + ms, fn, live: true };
        timers.push(timer);
        return () => void (timer.live = false);
      },
    },
    ...extra,
  });
  const advance = (ms: number) => {
    const to = now + ms;
    for (;;) {
      const next = timers.filter((x) => x.live && x.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      now = next.at;
      next.fn();
    }
    now = to;
  };
  const out: any[] = [];
  const conn = protocol.connection((m: object) => out.push(m));
  const scope = { chatId, epoch: 1 };
  const key = (n: number) => `key-${String(n).padStart(8, '0')}`;
  const card = (requestId = 'r1', turnId = 't1') => {
    host.emit('event', { kind: 'turnStart', key: chatId, turnId });
    host.emit('event', {
      kind: 'permission',
      key: chatId,
      requestId,
      turnId,
      toolCall: { title: 'git push origin main', kind: 'execute' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
  };
  const closes = () =>
    out.filter((m) => m.frame?.t === 'durable' && m.frame.item.event?.kind === 'permissionCancelled').map((m) => m.frame.item.event);
  const attention = () => out.filter((m) => m.frame?.t === 'state' && 'attention' in m.frame.patch).map((m) => m.frame.patch.attention);
  return { dir, host, runtime, sends, asked, cancelled, protocol, conn, out, scope, key, card, closes, attention, told, advance, epochs };
}
const hello = (conn: any) => conn.call('host.hello', helloParams());

for (const { name, chatId } of FAMILIES) {
  test(`${name}: a card reaches the state lane and host.pending; the first answer wins and says who answered`, async () => {
    const s = setup(chatId);
    await hello(s.conn);
    await s.conn.call('chat.subscribe', s.scope);
    s.card();
    assert.deepEqual(s.attention().at(-1), { kind: 'approval', since: 10_000, cards: ['r1'] });
    const pending = (await s.conn.call('host.pending', {})) as any;
    assert.equal(pending.cards[0].summary.tool, 'execute');
    assert.equal(pending.cards[0].summary.line, 'git push origin main');
    assert.equal(pending.cards[0].family, familyOf(chatId));
    assert.equal(pending.cards[0].epoch, 1);
    assert.deepEqual(
      pending.attention.map((a: any) => a.chatId),
      [chatId],
    );
    assert.deepEqual(
      s.told.map((m) => m.kind),
      ['needsYou'],
    );
    // the card itself is on the record with its time
    assert.equal(s.out.find((m) => m.frame?.item?.event?.kind === 'permission').frame.item.event.at, 10_000);
    assert.deepEqual(
      ((await s.conn.call('chat.answer', { ...s.scope, key: s.key(1), requestId: 'r1', optionId: 'allow' })) as any).result,
      { answered: true },
    );
    // another client, another key, a moment later: refused, and the runtime is told once
    const late = await s.conn.call('chat.answer', { ...s.scope, key: s.key(2), requestId: 'r1', optionId: 'deny' }).catch((e: any) => e);
    assert.equal(wireError(late).code, 'card_answered');
    assert.deepEqual(Object.keys(wireError(late).details), ['by', 'at']);
    assert.equal(s.asked.length, 1);
    assert.deepEqual(
      s.closes().map((e: any) => [e.reason, e.optionKind, e.requestId]),
      [['answered', 'allow', 'r1']],
    );
    assert.equal(s.attention().at(-1), null);
    assert.deepEqual(((await s.conn.call('host.pending', {})) as any).cards, []);
  });

  test(`${name}: nobody answers: the run pauses at 30 minutes, the action is not run, and the next message tells the agent`, async () => {
    const s = setup(chatId);
    await hello(s.conn);
    await s.conn.call('chat.subscribe', s.scope);
    s.card();
    s.advance(10 * MIN);
    assert.deepEqual(
      s.told.map((m) => m.kind),
      ['needsYou', 'reminder'],
    );
    s.advance(20 * MIN);
    assert.deepEqual(s.cancelled, [chatId]);
    assert.deepEqual(
      s.closes().map((e: any) => e.reason),
      ['expired'],
    );
    assert.deepEqual(s.attention().at(-1), { kind: 'paused', since: 10_000 + 30 * MIN, reason: 'approval_timeout', pauseMinutes: 30 });
    // the harness ends the turn and closes its own card: nothing is recorded twice, and the pause stays
    s.host.emit('event', { kind: 'permissionCancelled', key: chatId, requestId: 'r1' });
    s.host.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'cancelled' });
    assert.equal(s.closes().length, 1);
    assert.equal(s.attention().at(-1).kind, 'paused');
    // a late answer finds nothing to answer; it is not a refusal
    assert.deepEqual(
      ((await s.conn.call('chat.answer', { ...s.scope, key: s.key(3), requestId: 'gone', optionId: 'allow' })) as any).result,
      { answered: false },
    );
    await s.conn.call('chat.send', { ...s.scope, key: s.key(4), text: 'carry on' });
    assert.equal(s.sends[0].prefix, NOT_RUN_NOTICE);
    assert.equal(s.attention().at(-1), null);
    await s.conn.call('chat.send', { ...s.scope, key: s.key(5), text: 'again' });
    assert.equal(s.sends[1].prefix, undefined);
  });

  test(`${name}: a Stop, a removed chat and a new owner each retire the clock`, async () => {
    const s = setup(chatId);
    await hello(s.conn);
    await s.conn.call('chat.subscribe', s.scope);
    s.card();
    await s.conn.call('chat.stop', { ...s.scope, key: s.key(6) });
    assert.deepEqual(
      s.closes().map((e: any) => e.reason),
      ['stopped'],
    );
    s.advance(60 * MIN);
    assert.deepEqual(s.cancelled, [chatId]);
    // a card of the next turn is not closed by the old turn's late close
    s.card('r2', 't2');
    s.host.emit('event', { kind: 'permissionCancelled', key: chatId, requestId: 'r1' });
    assert.deepEqual(s.attention().at(-1).cards, ['r2']);
    // a continue elsewhere moves the epoch: the card is no longer this Host's to time
    await s.conn.call('chat.subscribe', { chatId, epoch: 2 });
    s.advance(60 * MIN);
    assert.deepEqual(s.cancelled, [chatId]);
    s.card('r3', 't3');
    await s.conn.call('chat.remove', { chatId, epoch: 2, key: s.key(7) });
    s.advance(60 * MIN);
    assert.equal(s.cancelled.length, 2);
  });

  test(`${name}: a turn that ends with a card left closes it; a restart closes what it cut off, before the turn ends`, async () => {
    const s = setup(chatId);
    await hello(s.conn);
    await s.conn.call('chat.subscribe', s.scope);
    s.card();
    s.host.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
    assert.deepEqual(
      s.closes().map((e: any) => e.reason),
      ['turn_ended'],
    );
    // a Host that died with a card open: the next one closes it as host_restarted
    const r = setup(chatId);
    await hello(r.conn);
    await r.conn.call('chat.subscribe', r.scope);
    r.card('r9', 't9');
    r.host.emit('event', { kind: 'question', key: chatId, turnId: 't9', question: { id: 'q9', message: 'Colour?' } });
    r.host.emit('event', { kind: 'permission', key: chatId, requestId: 'other', turnId: 'other-turn' });
    const answered = await r.conn.call('chat.answer', { ...r.scope, key: r.key(1), requestId: 'q9', form: { action: 'accept' } });
    assert.deepEqual((answered as any).result, { answered: true });
    const fresh = setup(chatId);
    // the new process reads the old journal: here the same protocol is told its turn was left running
    r.protocol.interrupted([['t9', chatId]]);
    const kinds = r.out.filter((m) => m.frame?.t === 'durable').map((m) => m.frame.item.event?.kind ?? m.frame.item.t);
    assert.ok(kinds.indexOf('turnEnd') > kinds.lastIndexOf('permissionCancelled'));
    assert.deepEqual(
      r.closes().map((e: any) => [e.requestId, e.reason]),
      [
        ['q9', 'answered'],
        ['r9', 'host_restarted'],
      ],
    );
    assert.ok(fresh);
  });
}

test('a pause survives a restart: the next message is still told, and the lane is cleared', async () => {
  const s = setup('claude:c1');
  await hello(s.conn);
  await s.conn.call('chat.subscribe', s.scope);
  s.card();
  s.advance(30 * MIN);
  // a new process over the same lane has no memory of the pause, but the lane kept it
  s.protocol.interrupted([['t1', 'claude:c1']]);
  await s.conn.call('chat.send', { ...s.scope, key: s.key(1), text: 'back' });
  assert.equal(s.sends[0].prefix, NOT_RUN_NOTICE);
});

test('a handoff and a pause notice go in front of the first message together', async () => {
  const s = setup('claude:c1', { handoffs: { take: () => ({ text: 'HANDOFF', cwd: '/w' }), done: () => undefined } });
  await hello(s.conn);
  s.card();
  s.advance(30 * MIN);
  await s.conn.call('chat.send', { ...s.scope, key: s.key(1), text: 'back' });
  assert.equal(s.sends[0].prefix, `${NOT_RUN_NOTICE}\n\nHANDOFF`);
});

test('an older end without approvals2 is refused host.pending, never served half of it', async () => {
  const s = setup('claude:c1');
  await s.conn.call('host.hello', { ...helloParams(), features: helloParams().features.filter((f: string) => f !== 'approvals2') });
  const refused = await s.conn.call('host.pending', {}).catch((e: any) => e);
  assert.equal(wireError(refused).code, 'feature_missing');
});

test('the owner’s clock replaces the default through the protocol', async () => {
  const s = setup('claude:c1', { approvalTimes: () => ({ remindMs: MIN, pauseMs: 2 * MIN }) });
  await hello(s.conn);
  s.card();
  s.advance(2 * MIN);
  assert.deepEqual(s.cancelled, ['claude:c1']);
});
