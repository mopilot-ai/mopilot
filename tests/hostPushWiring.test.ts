// The approval push as the serve entry wires it (host/src/pushWiring.mjs, #4576): a card on a protocol with an enrolled phone sends the sealed push on that phone's relay link; the owner's needsYou, paused, detail and quiet choices decide what is sent; the answer clears it; nothing is sent when no phone is enrolled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore
import { createStampSeal } from '../shared/remote/stampSeal.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { createPolicy } from '../host/src/policy.mjs';
// @ts-ignore
import { pushWiringFor, quietEnd, relayWithPush } from '../host/src/pushWiring.mjs';
// @ts-ignore
import { parseOwnerPolicy } from '../shared/host/policy.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createCardPush } from '../shared/remote/cardPush.mjs';
import { chatRef } from '../shared/remote/ref.mjs';

const MIN = 60_000;
const quiet = { report: () => undefined };
const ROOT = new Uint8Array(32).fill(5);
const cp = createCardPush(createNodePrimitives());
const ownerDoc = (d: object) => parseOwnerPolicy({ version: 1, ...d }, (m: string) => new Error(m));
const chatId = 'claude:00000000-0000-4000-8000-0000000000c1';

function rig(opts: { phones?: number; owner?: object } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-push-wiring-'));
  const policy = createPolicy({ dataDir: dir });
  if (opts.owner) policy.set(ownerDoc(opts.owner));
  const phones = Array.from({ length: opts.phones ?? 1 }, (_, i) => ({ hostId: `h${i + 1}`, pairId: `pair${i + 1}`, root: ROOT }));
  const sent: { hostId: string; req: any }[] = [];
  const relay = { pushTargets: () => phones, push: async (hostId: string, req: any) => (sent.push({ hostId, req }), 'sent') };
  let now = 10_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const wiring = pushWiringFor({ policy, relay, machineName: () => 'build-box', now: () => now, report: () => undefined });
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = { host, familyOf: () => 'claude', send: async () => ({ turnId: 't2' }), permit: () => true };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const protocol = createProtocol({
    runtime,
    epochs,
    guard: createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) }),
    status: () => ({ running: true }),
    dataDir: dir,
    policy,
    ...quiet,
    ...wiring.options,
    approvalClock: {
      now: () => now,
      after: (fn: () => void, ms: number) => {
        const t = { at: now + ms, fn, live: true };
        timers.push(t);
        return () => void (t.live = false);
      },
    },
  });
  const conn = protocol.connection(() => undefined);
  const start = async () => (await conn.call('host.hello', helloParams()), await conn.call('chat.subscribe', { chatId, epoch: 1 }));
  const card = () => {
    host.emit('event', { kind: 'turnStart', key: chatId, turnId: 't1' });
    host.emit('event', {
      kind: 'permission',
      key: chatId,
      requestId: 'r1',
      turnId: 't1',
      toolCall: { title: 'git push origin main', kind: 'execute' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
  };
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
  const settle = () => new Promise((r) => setImmediate(r));
  const opened = (s: any) => cp.open({ sealed: s.req.sealed, ref: chatRef(s.req.pair, chatId), keys: [cp.cardKey(ROOT)] });
  return { conn, start, card, advance, sent, settle, wiring, opened, timers, setNow: (n: number) => (now = n) };
}
const answer = (r: ReturnType<typeof rig>) =>
  r.conn.call('chat.answer', { chatId, epoch: 1, key: 'key-00000001', requestId: 'r1', optionId: 'allow' });

test('a card on a served Host sends the sealed push on each enrolled phone’s own relay link, and the answer clears it', async () => {
  const r = rig({ phones: 2 });
  await r.start();
  r.card();
  await r.settle();
  assert.deepEqual(
    r.sent.map((s) => [s.hostId, s.req.kind, s.req.pair]),
    [
      ['h1', 'needsYou', 'pair1'],
      ['h2', 'needsYou', 'pair2'],
    ],
  );
  const first = r.opened(r.sent[0]);
  assert.deepEqual([first?.requestId, first?.card.machine, first?.card.tool], ['r1', 'build-box', 'execute']);
  assert.ok(!JSON.stringify(r.sent).includes('git push'), 'the default detail carries no command line');
  await answer(r);
  await r.settle();
  assert.deepEqual(
    r.sent.slice(2).map((s) => [s.hostId, s.req.kind]),
    [
      ['h1', 'cleared'],
      ['h2', 'cleared'],
    ],
  );
  // a clearing is not a finished chat and says nothing of the card: no blob for the relay to carry
  assert.equal(r.sent[2].req.sealed, undefined);
});

test('with no phone enrolled nothing is sent and the card still waits', async () => {
  const r = rig({ phones: 0 });
  await r.start();
  r.card();
  await r.settle();
  assert.equal(r.sent.length, 0);
  assert.equal(((await r.conn.call('host.pending', {})) as any).cards.length, 1);
});

test('the owner’s choices: needsYou off sends nothing, detail full adds the line', async () => {
  const off = rig({ owner: { notify: { needsYou: false } } });
  await off.start();
  off.card();
  await off.settle();
  off.advance(11 * MIN);
  await off.settle();
  assert.equal(off.sent.length, 0, 'neither the card nor its reminder');
  const full = rig({ owner: { notify: { detail: 'full' } } });
  await full.start();
  full.card();
  await full.settle();
  assert.equal(full.opened(full.sent[0])?.card.line, 'git push origin main');
});

test('a reminder follows the owner’s minutes, then the pause is sent; paused off sends no pause', async () => {
  const r = rig({ owner: { approvals: { remindMinutes: 2, pauseMinutes: 5 } } });
  await r.start();
  r.card();
  await r.settle();
  r.advance(2 * MIN);
  await r.settle();
  assert.equal(r.opened(r.sent.at(-1)!)?.card.state, 'reminder');
  r.advance(3 * MIN);
  await r.settle();
  assert.equal(r.opened(r.sent.at(-1)!)?.card.state, 'paused');
  const mute = rig({ owner: { notify: { paused: false } } });
  await mute.start();
  mute.card();
  await mute.settle();
  mute.advance(31 * MIN);
  await mute.settle();
  assert.deepEqual(
    mute.sent.map((s) => mute.opened(s)?.card.state ?? 'waiting'),
    ['waiting', 'reminder'],
  );
});

test('the default timings are ten and thirty minutes, and quiet hours hold the push to their end', () => {
  const r = rig();
  assert.deepEqual(r.wiring.approvalTimes(), { remindMs: 10 * MIN, pauseMs: 30 * MIN });
  const at = Date.UTC(2026, 10, 15, 23, 30, 0);
  const win = { start: '22:00', end: '07:00', tz: 'UTC' };
  assert.equal(quietEnd(win, at), Date.UTC(2026, 10, 16, 7, 0, 0));
  assert.equal(quietEnd(win, Date.UTC(2026, 10, 15, 3, 0, 0)), Date.UTC(2026, 10, 15, 7, 0, 0));
  assert.equal(quietEnd(win, Date.UTC(2026, 10, 15, 12, 0, 0)), null);
  assert.equal(quietEnd({ start: '09:00', end: '17:00', tz: 'UTC' }, Date.UTC(2026, 10, 15, 12, 15, 30)), Date.UTC(2026, 10, 15, 17, 0, 0));
  assert.equal(quietEnd({ start: '09:00', end: '09:00', tz: 'UTC' }, at), null);
  assert.equal(quietEnd({ start: '22:00', end: '07:00', tz: 'Not/AZone' }, at), null);
  assert.equal(quietEnd(null, at), null);
});

test('a card during quiet hours is held, not sent', async () => {
  const r = rig({ owner: { notify: { quiet: { start: '00:00', end: '23:59', tz: 'UTC' } } } });
  await r.start();
  r.card();
  await r.settle();
  assert.equal(r.sent.length, 0);
});

test('the relay links and the push are made together, and closing stops the notifier', () => {
  const made = relayWithPush({
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'host-push-links-')),
    socketPath: '/nowhere.sock',
    policy: createPolicy({}),
  });
  assert.deepEqual(made.relayLinks.pushTargets(), []);
  assert.equal(typeof made.approvalPush.options.notify, 'function');
  made.approvalPush.close();
  made.relayLinks.close();
});

test('the Host says how many phones are linked and how many cards found none, for its status (#4721)', () => {
  const none = rig({ phones: 0 });
  assert.deepEqual(none.wiring.state(), { phones: 0, skipped: 0, lastSkippedAt: null });
  const one = rig({ phones: 2 });
  assert.deepEqual(one.wiring.state(), { phones: 2, skipped: 0, lastSkippedAt: null });
});

test('a phone with no pair root gets MoMo’s push with no sealed stamp', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-push-noroot-'));
  const sent: any[] = [];
  const relay = { pushTargets: () => [{ hostId: 'h1', pairId: 'pair1' }], push: async (_h: string, req: any) => (sent.push(req), 'sent') };
  const wiring = pushWiringFor({ policy: createPolicy({ dataDir: dir }), relay, machineName: () => 'build-box' });
  const momoNotify = wiring.momoNotify({
    granted: () => true,
    stamp: () => ({ homeId: 'studio', leaseEpoch: 1 }),
    current: () => true,
    receiveStamp: () => ({ ok: true }),
    storage: { dir },
    data: { safeStorage: createFileSafeStorage(dir) },
    prefs: { forRoutines: () => ({ momo: { routines: { quietHours: null }, notify: { previews: false, tellNowMax: 6 } } }) },
  });
  await momoNotify({ kind: 'needsYou', chatId, card: { requestId: 'r1' } });
  assert.equal(sent.length, 1);
  assert.equal('sealedStamp' in sent[0] && sent[0].sealedStamp != null, false);
});

test('MoMo’s own push rides the same relay links: the fixed kind with opaque handles and no sealed card, whether or not the Host has a report', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-push-momo-'));
  const sent: { hostId: string; req: any }[] = [];
  const relay = {
    pushTargets: () => [{ hostId: 'h1', pairId: 'pair1', root: ROOT }],
    push: async (hostId: string, req: any) => (sent.push({ hostId, req }), 'sent'),
  };
  const wiring = pushWiringFor({ policy: createPolicy({ dataDir: dir }), relay, machineName: () => 'build-box' });
  const momoNotify = wiring.momoNotify({
    granted: () => true,
    stamp: () => ({ homeId: 'studio', leaseEpoch: 1 }),
    current: () => true,
    receiveStamp: () => ({ ok: true }),
    storage: { dir },
    data: { safeStorage: createFileSafeStorage(dir) },
    prefs: { forRoutines: () => ({ momo: { routines: { quietHours: null }, notify: { previews: false, tellNowMax: 6 } } }) },
  });
  await momoNotify({ kind: 'needsYou', chatId, card: { requestId: 'r1' } });
  assert.equal(sent.length, 1);
  // the lease travels sealed for this phone: the relay sees no home id and no epoch, the phone opens it with its pair root
  const { sealedStamp, ...rest } = sent[0].req;
  assert.deepEqual(sent[0].hostId, 'h1');
  assert.deepEqual(rest, { pair: 'pair1', kind: 'momoNeedsYou', ref: chatRef('pair1', chatId), card: chatRef('pair1', 'r1') });
  assert.doesNotMatch(JSON.stringify(sent), /studio/);
  const prim = createNodePrimitives();
  const seal = createStampSeal(prim);
  assert.deepEqual(seal.open({ sealed: sealedStamp, ref: chatRef('pair1', chatId), keys: [seal.stampKey(ROOT)] }), {
    homeId: 'studio',
    leaseEpoch: 1,
  });
  // answered anywhere: the same phone is told it is no longer needed
  sent.length = 0;
  await momoNotify({ kind: 'cleared', chatId });
  assert.deepEqual(
    sent.map((x: any) => [x.hostId, x.req.kind]),
    [['h1', 'cleared']],
  );
  wiring.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
