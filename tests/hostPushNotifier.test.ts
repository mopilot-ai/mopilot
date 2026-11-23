// The Host's push notifier (host/src/pushNotifier.mjs): a sealed push per phone enrollment, detail levels, clearing, reminder and pause on one chat, quiet hours, bounded retry, and the relay never seeing command text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createCardPush } from '../shared/remote/cardPush.mjs';
import { chatRef } from '../shared/remote/ref.mjs';
import { createPushNotifier, RETRY_MS } from '../host/src/pushNotifier.mjs';

const prim = createNodePrimitives();
const cp = createCardPush(prim);
const root = (n: number) => new Uint8Array(32).fill(n);
const card = {
  requestId: 'q1',
  rev: 2,
  cardKind: 'permission',
  summary: { tool: 'execute', line: 'rm -rf planted-secret-9921', stat: { files: 2, added: 10, removed: 3 } },
};

function rig(over: Record<string, unknown> = {}) {
  const sent: { hostId: string; req: any }[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const reports: string[] = [];
  let status: string | Error | (() => string | Error) = 'sent';
  let detail = 'tool';
  let quiet: number | null = null;
  let clock = 1000;
  const targets = [
    { hostId: 'h1', pairId: 'pair1', root: root(1) },
    { hostId: 'h2', pairId: 'pair2', root: root(2) },
  ];
  const n = createPushNotifier({
    targets: () => targets,
    send: async (hostId: string, req: any) => {
      sent.push({ hostId, req });
      const s = typeof status === 'function' ? status() : status;
      if (s instanceof Error) throw s;
      return s;
    },
    machineName: () => 'build-box',
    detail: () => detail as any,
    quietUntil: () => quiet,
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t: any) => (t.live = false),
    report: (m: string) => reports.push(m),
    ...over,
  });
  const fireNext = async () => {
    const t = timers.find((x) => x.live)!;
    t.live = false;
    t.fn();
    await new Promise((r) => setImmediate(r));
  };
  return {
    n,
    sent,
    timers,
    reports,
    fireNext,
    set: (o: any) => {
      if ('status' in o) status = o.status;
      if ('detail' in o) detail = o.detail;
      if ('quiet' in o) quiet = o.quiet;
      if ('clock' in o) clock = o.clock;
    },
  };
}
const open = (r: { hostId: string; req: any }, h = 1, chat = 'c1') =>
  cp.open({ sealed: r.req.sealed, ref: chatRef(`pair${h}`, chat), keys: [cp.cardKey(root(h))] });
const flush = () => new Promise((r) => setImmediate(r));

test('one push per phone enrollment, each sealed under its own pair root, on its own link', async () => {
  const r = rig();
  await r.n.notify({ kind: 'needsYou', chatId: 'c1', card });
  assert.deepEqual(
    r.sent.map((s) => [s.hostId, s.req.pair, s.req.kind, s.req.ref]),
    [
      ['h1', 'pair1', 'needsYou', chatRef('pair1', 'c1')],
      ['h2', 'pair2', 'needsYou', chatRef('pair2', 'c1')],
    ],
  );
  const a = open(r.sent[0])!;
  assert.deepEqual([a.requestId, a.rev, a.card], ['q1', 2, { machine: 'build-box', tool: 'execute' }]);
  // phone 2's blob does not open with phone 1's key
  assert.equal(cp.open({ sealed: r.sent[1].req.sealed, ref: chatRef('pair2', 'c1'), keys: [cp.cardKey(root(1))] }), null);
  assert.ok(open(r.sent[1], 2));
});

test('detail levels: minimal fixed, tool kind only, full adds the line and stat; the relay never sees command text', async () => {
  for (const [detail, expectLine] of [
    ['minimal', false],
    ['tool', false],
    ['full', true],
  ] as const) {
    const r = rig();
    r.set({ detail });
    await r.n.notify({ kind: 'needsYou', chatId: 'c1', card });
    const o = open(r.sent[0])!;
    assert.equal(!!o.card.line, expectLine);
    assert.equal(detail === 'minimal', !o.card.tool);
    for (const s of r.sent)
      assert.ok(
        !JSON.stringify(s.req).includes('planted-secret-9921') &&
          !Buffer.from(s.req.sealed, 'base64url').toString('latin1').includes('planted'),
      );
  }
  const r = rig();
  r.set({ detail: 'full' });
  await r.n.notify({ kind: 'needsYou', chatId: 'c1', card: { ...card, cardKind: 'question' } });
  assert.equal(open(r.sent[0])!.card.stat, '2 files +10 -3');
  assert.equal(open(r.sent[0])!.card.question, true);
});

test('reminder, paused and clearing reuse the chat ref; a clearing is its own kind, never a done push, and carries no card text', async () => {
  const r = rig();
  await r.n.notify({ kind: 'needsYou', chatId: 'c1', card });
  await r.n.notify({ kind: 'reminder', chatId: 'c1' });
  await r.n.notify({ kind: 'paused', chatId: 'c1' });
  await r.n.notify({ kind: 'cleared', chatId: 'c1' });
  const h1 = r.sent.filter((s) => s.hostId === 'h1');
  assert.deepEqual(
    h1.map((s) => [s.req.kind, s.req.sealed ? open(s)!.card.state : 'unsealed', s.req.sealed ? open(s)!.requestId : null]),
    [
      ['needsYou', undefined, 'q1'],
      ['needsYou', 'reminder', 'q1'],
      ['needsYou', 'paused', 'q1'],
      ['cleared', 'unsealed', null],
    ],
  );
  assert.equal(new Set(h1.map((s) => s.req.ref)).size, 1);
  // after the clearing nothing is known about the chat
  await r.n.notify({ kind: 'reminder', chatId: 'c1' });
  assert.equal(r.sent.length, 8);
});

test('unknown kinds, a clearing nobody was told about, and a closed notifier send nothing', async () => {
  const r = rig();
  await r.n.notify({ kind: 'blocked', chatId: 'c1', card });
  await r.n.notify({ kind: 'cleared', chatId: 'c1' });
  await r.n.notify({ kind: 'reminder', chatId: 'never' });
  assert.equal(r.sent.length, 0);
  r.n.close();
  await r.n.notify({ kind: 'needsYou', chatId: 'c1', card });
  assert.equal(r.sent.length, 0);
});

test('an enrollment that cannot carry the ids sends nothing', async () => {
  const r = rig();
  await r.n.notify({ kind: 'needsYou', chatId: 'c1', card: { ...card, requestId: '' } });
  assert.equal(r.sent.length, 0);
});

test('a missing rev counts as 0 and a card without a summary still sends', async () => {
  const r = rig();
  await r.n.notify({ kind: 'needsYou', chatId: 'c1', card: { requestId: 'q9' } });
  const o = open(r.sent[0])!;
  assert.deepEqual([o.requestId, o.rev, o.card.tool], ['q9', 0, 'other']);
});

test('a failed push is tried again on a bounded backoff, never more than the bound, and reports why', async () => {
  const r = rig({ targets: () => [{ hostId: 'h1', pairId: 'pair1', root: root(1) }] });
  r.set({ status: 'failed' });
  const done = r.n.notify({ kind: 'needsYou', chatId: 'c1', card });
  await flush();
  for (let i = 0; i < RETRY_MS.length; i++) {
    assert.equal(r.timers.filter((t) => t.live)[0].ms, RETRY_MS[i]);
    await r.fireNext();
  }
  await done;
  assert.equal(r.sent.length, RETRY_MS.length + 1);
  // a thrown error is reported and retried like a failure
  const e = rig({ targets: () => [{ hostId: 'h1', pairId: 'pair1', root: root(1) }] });
  let calls = 0;
  e.set({ status: () => (++calls < 2 ? new Error('The relay is not connected') : 'sent') });
  const d2 = e.n.notify({ kind: 'needsYou', chatId: 'c1', card });
  await flush();
  await e.fireNext();
  await d2;
  assert.deepEqual([e.sent.length, e.reports], [2, ['push: The relay is not connected', 'push needsYou waiting: sent']]);
  // every answer is reported, so a push the relay did not send is told from one that was (no chat, card or text in the line)
  assert.ok(r.reports.every((m) => /^push needsYou waiting: failed$/.test(m)) && r.reports.length === RETRY_MS.length + 1);
});

test("a newer push for the same chat ends the older one's retries; close ends them all", async () => {
  const r = rig({ targets: () => [{ hostId: 'h1', pairId: 'pair1', root: root(1) }] });
  r.set({ status: 'failed' });
  const first = r.n.notify({ kind: 'needsYou', chatId: 'c1', card });
  await flush();
  const second = r.n.notify({ kind: 'reminder', chatId: 'c1' });
  await flush();
  assert.equal(r.sent.length, 2);
  await r.fireNext(); // the first one's wait ends, sees a newer push, stops
  await first;
  assert.equal(r.sent.length, 2);
  r.n.close();
  assert.equal(r.timers.filter((t) => t.live).length, 0);
  await second;
  // closed while waiting
  const c = rig({ targets: () => [{ hostId: 'h1', pairId: 'pair1', root: root(1) }] });
  c.set({ status: 'failed' });
  const p = c.n.notify({ kind: 'needsYou', chatId: 'c1', card });
  await flush();
  c.n.close();
  await c.fireNext().catch(() => undefined);
  await p;
  assert.equal(c.sent.length, 1);
});

test('a relay that is slow or down does not turn into a push storm: one in flight per phone and chat', async () => {
  const r = rig({ targets: () => [{ hostId: 'h1', pairId: 'pair1', root: root(1) }] });
  r.set({ status: 'failed' });
  const all: Promise<unknown>[] = [];
  for (let i = 0; i < 5; i++) all.push(r.n.notify({ kind: 'reminder', chatId: 'c1', card }));
  await flush();
  assert.equal(r.sent.length, 5);
  // each older retry loop ends at its first wait; only the newest one keeps trying
  while (r.timers.some((t) => t.live)) await r.fireNext();
  await Promise.all(all);
  assert.equal(r.sent.length, 5 + RETRY_MS.length);
});

test('quiet hours hold the push; the end sends one catch-up for the newest card, and a card answered meanwhile sends nothing', async () => {
  const r = rig({ targets: () => [{ hostId: 'h1', pairId: 'pair1', root: root(1) }] });
  r.set({ quiet: 5000, clock: 1000 });
  await r.n.notify({ kind: 'needsYou', chatId: 'a', card });
  await r.n.notify({ kind: 'needsYou', chatId: 'b', card: { ...card, requestId: 'qb' } });
  await r.n.notify({ kind: 'reminder', chatId: 'b' });
  assert.equal(r.sent.length, 0);
  assert.equal(r.timers.filter((t) => t.live).length, 1);
  assert.equal(r.timers[0].ms, 4000);
  r.set({ quiet: null });
  await r.fireNext();
  assert.deepEqual(
    r.sent.map((s) => [s.req.ref, open(s, 1, 'b')?.requestId, open(s, 1, 'b')?.card.state]),
    [[chatRef('pair1', 'b'), 'qb', 'reminder']],
  );
  // answered during quiet hours: nothing is sent
  const q = rig();
  q.set({ quiet: 5000 });
  await q.n.notify({ kind: 'needsYou', chatId: 'a', card });
  await q.n.notify({ kind: 'cleared', chatId: 'a' });
  q.set({ quiet: null });
  await q.fireNext();
  assert.equal(q.sent.length, 0);
});

test('quiet hours that are still on at the timer wait again; a clearing of a told chat waits for the end', async () => {
  const r = rig({ targets: () => [{ hostId: 'h1', pairId: 'pair1', root: root(1) }] });
  await r.n.notify({ kind: 'needsYou', chatId: 'a', card });
  assert.equal(r.sent.length, 1);
  r.set({ quiet: 9000, clock: 1000 });
  await r.n.notify({ kind: 'cleared', chatId: 'a' });
  assert.equal(r.sent.length, 1);
  await r.n.notify({ kind: 'cleared', chatId: 'a' });
  assert.equal(r.timers.filter((t) => t.live).length, 1);
  r.set({ quiet: 12000 });
  await r.fireNext(); // still quiet: waits again, sends nothing
  assert.equal(r.sent.length, 1);
  assert.equal(r.timers.filter((t) => t.live).length, 1);
  r.set({ quiet: null });
  await r.fireNext();
  assert.deepEqual(
    r.sent.map((s) => s.req.kind),
    ['needsYou', 'cleared'],
  );
  // a held card then cleared: both the held push and the clearing are dropped except the earlier told one
  const h = rig({ targets: () => [{ hostId: 'h1', pairId: 'pair1', root: root(1) }] });
  await h.n.notify({ kind: 'needsYou', chatId: 'a', card });
  h.set({ quiet: 9000 });
  await h.n.notify({ kind: 'reminder', chatId: 'a' });
  await h.n.notify({ kind: 'cleared', chatId: 'a' });
  h.set({ quiet: null });
  await h.fireNext();
  assert.deepEqual(
    h.sent.map((s) => s.req.kind),
    ['needsYou', 'cleared'],
  );
  h.n.close();
});

test('closing while quiet hours hold stops the catch-up', async () => {
  const r = rig();
  r.set({ quiet: 5000 });
  await r.n.notify({ kind: 'needsYou', chatId: 'a', card });
  r.n.close();
  r.set({ quiet: null });
  const t = r.timers[0];
  assert.equal(t.live, false);
  t.fn();
  assert.equal(r.sent.length, 0);
});

test('the default timer and detail work without injection', async () => {
  const sent: any[] = [];
  const n = createPushNotifier({
    targets: () => [{ hostId: 'h', pairId: 'p', root: root(3) }],
    send: async (_h: string, req: any) => (sent.push(req), 'failed'),
    machineName: () => 'm',
  });
  void n.notify({ kind: 'needsYou', chatId: 'c', card });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(cp.open({ sealed: sent[0].sealed, ref: chatRef('p', 'c'), keys: [cp.cardKey(root(3))] })!.card.tool, 'execute');
  n.close();
  // quiet default off, report default no-op
  const m = createPushNotifier({
    targets: () => [{ hostId: 'h', pairId: 'p', root: root(3) }],
    send: async () => {
      throw new Error('x');
    },
    machineName: () => 'm',
  });
  const pending = m.notify({ kind: 'needsYou', chatId: 'c', card });
  await flush();
  m.close();
  await pending;
});

test('a card raised while no phone is linked to the Host is logged and counted, and the count clears once a push goes out (#4721)', async () => {
  let targets: { hostId: string; pairId: string; root: Uint8Array }[] = [];
  const reports: string[] = [];
  const sent: string[] = [];
  const n = createPushNotifier({
    targets: () => targets,
    send: async (hostId: string) => (sent.push(hostId), 'sent'),
    machineName: () => 'build-box',
    report: (m: string) => reports.push(m),
    now: () => 5000,
  });
  assert.deepEqual(n.state(), { skipped: 0, lastSkippedAt: null });
  await n.notify({ kind: 'needsYou', chatId: 'c1', card });
  await n.notify({ kind: 'reminder', chatId: 'c1' });
  assert.deepEqual(n.state(), { skipped: 2, lastSkippedAt: 5000 });
  assert.deepEqual(reports, [
    'push: no phone is linked to this Host, so a waiting card is not pushed',
    'push: no phone is linked to this Host, so a waiting card is not pushed',
  ]);
  // a clearing of a card nobody was told of is not a skipped push
  await n.notify({ kind: 'cleared', chatId: 'c1' });
  assert.equal(n.state().skipped, 2);
  targets = [{ hostId: 'h1', pairId: 'pair1', root: root(1) }];
  await n.notify({ kind: 'needsYou', chatId: 'c2', card: { ...card, requestId: 'q2' } });
  assert.deepEqual(sent, ['h1']);
  assert.deepEqual(n.state(), { skipped: 0, lastSkippedAt: null }, 'a phone is linked again: nothing is left unpushed');
  n.close();
});

test('a relay that predates the clearing kind refuses it: no retry, nothing else is sent in its place, and the waiting push stands', async () => {
  const r = rig({ targets: () => [{ hostId: 'h1', pairId: 'pair1', root: root(1) }] });
  await r.n.notify({ kind: 'needsYou', chatId: 'c1', card });
  r.set({ status: Object.assign(new Error('The relay refused: bad_message'), { code: 'bad_message' }) });
  await r.n.notify({ kind: 'cleared', chatId: 'c1' });
  assert.deepEqual(
    r.sent.map((s) => s.req.kind),
    ['needsYou', 'cleared'],
    'never a done, which would claim the chat finished',
  );
  assert.equal(r.timers.filter((t) => t.live).length, 0, 'a refusal is final: nothing is tried again');
  assert.ok(r.reports.some((m) => m.includes('bad_message')));
  r.n.close();
});
