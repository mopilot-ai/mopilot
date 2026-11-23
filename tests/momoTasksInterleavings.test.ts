// Adversarial property suite for MoMo tasks: seeded random interleavings of start/stop/finished/failed/retry and late or duplicate events, with the task invariants checked after every step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { words } from './support/momoTaskItems/words.ts';
import { HARD_ATTEMPTS, MAX_WORKING, TaskRefusal, createTaskManager, type TaskManager } from '../shared/momoTasks/manager.ts';
import { createItemStore, createMemorySeam } from '../shared/momoTasks/store.ts';
import type { Item, MachineInfo, Probe, ResultCard, SessionEvent, StartOutcome } from '../shared/momoTasks/types.ts';

/** Tiny seeded PRNG so a failing sequence is reproduced by its seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Status = 'live' | 'ended' | 'silent';
type Sess = { id: string; itemId: string; machineId: string; key: string; status: Status; stops: number };
type Op =
  | { op: 'create'; title: string; origin: 'asked' | 'matter'; machineId: string }
  | { op: 'start'; item: number; move: boolean }
  | { op: 'stop'; item: number }
  | { op: 'event'; session: number; ev: SessionEvent }
  | { op: 'silent'; session: number }
  | { op: 'recover' }
  | { op: 'flush' }
  | { op: 'toggle'; machineId: string };

const TITLES = [
  'Rebuild the seat sheet',
  'Collect invoices',
  'Summarise the board notes',
  'Draft the visa form',
  'Tidy the photos',
  'Check the lease',
];
const MACHINES = ['home', 'mini'];

/** Everything around the real manager is fake: machines (idempotent on the start key), brain, chat, store seam. */
function makeWorld(seed: number) {
  const rng = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
  const ticks = async (): Promise<void> => {
    for (let i = Math.floor(rng() * 4); i > 0; i--) await Promise.resolve();
  };
  let now = 1_000_000;
  const clock = { now: () => (now += 1000) };
  const sessions: Sess[] = [];
  const byKey = new Map<string, Sess>();
  const offline = new Set<string>();
  const deliveries = new Map<string, number>();
  const cards = new Map<string, ResultCard>();
  const wire = { chaos: true, sinkFails: true };
  let ids = 0;
  const machines = (): MachineInfo[] =>
    MACHINES.map((machineId) => ({
      machineId,
      name: machineId,
      online: !offline.has(machineId),
      outdated: false,
      installable: true,
      agents: [{ id: 'claude', state: 'ready' as const }],
    }));
  const store = createItemStore(createMemorySeam(), clock);
  const mgr = createTaskManager({
    words,
    store,
    clock,
    randomId: () => `r${++ids}`,
    home: async () => ({ machineId: 'home', harness: 'claude' }),
    machines: {
      list: async () => {
        await ticks();
        return machines();
      },
      start: async (req): Promise<StartOutcome> => {
        await ticks();
        const same = byKey.get(req.key);
        if (same) return { ok: true, sessionId: same.id };
        if (wire.chaos && rng() < 0.08) throw new Error('socket closed');
        if (wire.chaos && rng() < 0.08) return { ok: false, code: 'login_limited', message: 'limit reached' };
        const s: Sess = {
          id: `s${sessions.length + 1}`,
          itemId: req.itemId,
          machineId: req.machineId,
          key: req.key,
          status: 'live',
          stops: 0,
        };
        sessions.push(s);
        byKey.set(req.key, s);
        return { ok: true, sessionId: s.id };
      },
      stop: async (_m, sid) => {
        await ticks();
        const s = sessions.find((x) => x.id === sid);
        if (s) {
          s.stops++;
          s.status = 'ended';
        }
      },
      probe: async (_m, sid): Promise<Probe> => {
        await ticks();
        const s = sessions.find((x) => x.id === sid);
        if (!s || s.status === 'ended') return { state: 'gone' };
        if (s.status === 'silent') return { state: 'finished', report: 'Result: made it.\nFiles: a.txt\nEvidence: opened a.txt' };
        return rng() < 0.2 ? { state: 'unreachable' } : { state: 'running' };
      },
    },
    check: {
      ask: async () => {
        await ticks();
        const r = rng();
        if (r < 0.55) return '{"met": true, "reason": "ok", "checked": "opened the file"}';
        if (r < 0.8) return '{"met": false, "reason": "totals differ", "checked": "opened the file"}';
        if (r < 0.9) return 'no idea';
        throw new Error('brain unavailable');
      },
    },
    chat: {
      postResult: async (card) => {
        await ticks();
        if (wire.sinkFails && rng() < 0.2) throw new Error('chat closed');
        const key = `${card.itemId}:${card.settle}`;
        // the sink is idempotent on (itemId, settle), as the contract asks: a repeated call is the same row, a different card under one key is a bug
        const had = cards.get(key);
        if (had) assert.deepEqual(card, had, `card ${key} delivered with different content`);
        else deliveries.set(key, 1);
        cards.set(key, card);
      },
      postWatchChanged: async () => {},
    },
  });
  const items = (): Promise<Item[]> => mgr.list();

  /** One random operation, chosen from what exists now. */
  async function chooseOp(): Promise<Op> {
    const list = await items();
    const r = rng();
    const idx = () => Math.floor(rng() * Math.max(list.length, 1));
    if (r < 0.14 || list.length === 0)
      return { op: 'create', title: pick(TITLES), origin: rng() < 0.7 ? 'asked' : 'matter', machineId: pick(MACHINES) };
    if (r < 0.26) return { op: 'start', item: idx(), move: rng() < 0.25 };
    if (r < 0.38) return { op: 'stop', item: idx() };
    if (r < 0.45) return { op: 'silent', session: Math.floor(rng() * Math.max(sessions.length, 1)) };
    if (r < 0.5) return { op: 'recover' };
    if (r < 0.55) return { op: 'flush' };
    if (r < 0.58) return { op: 'toggle', machineId: pick(MACHINES) };
    const kinds: SessionEvent[] = [
      { kind: 'progress', line: 'step' },
      { kind: 'needs_you', line: 'approve a write', cardId: `c${Math.floor(rng() * 1000)}` },
      { kind: 'resumed' },
      { kind: 'finished', report: 'Result: made it.\nFiles: a.txt\nEvidence: opened a.txt' },
      { kind: 'finished', report: 'Result: made it.\nFiles: a.txt\nEvidence: opened a.txt' },
      { kind: 'failed', message: 'the agent crashed' },
      { kind: 'failed', signal: 'rate_limit', message: 'limit' },
      { kind: 'lost', reason: 'machine_restarted' },
      { kind: 'lost', reason: 'session_gone' },
    ];
    return { op: 'event', session: Math.floor(rng() * Math.max(sessions.length, 1)), ev: pick(kinds) };
  }

  async function run(o: Op): Promise<{ created?: Awaited<ReturnType<TaskManager['create']>> } | void> {
    const list = await items();
    switch (o.op) {
      case 'create':
        return {
          created: await mgr.create({
            title: o.title,
            doneMeans: `${o.title} is complete`,
            origin: o.origin,
            userStarted: o.origin === 'asked' ? true : undefined,
            where: { machineId: o.machineId, harness: 'claude' },
          }),
        };
      case 'start': {
        const it = list[o.item];
        if (!it) return;
        const where = o.move ? { machineId: it.where.machineId === 'home' ? 'mini' : 'home', harness: 'claude' } : undefined;
        await mgr.retry(it.id, where).catch(refusalOnly);
        return;
      }
      case 'stop': {
        const it = list[o.item];
        if (it) await mgr.stop(it.id).catch(refusalOnly);
        return;
      }
      case 'silent': {
        const s = sessions[o.session];
        if (s && s.status === 'live') s.status = 'silent';
        return;
      }
      case 'recover':
        await mgr.recover();
        return;
      case 'flush':
        await mgr.flushCards();
        return;
      case 'toggle':
        if (offline.has(o.machineId)) offline.delete(o.machineId);
        else offline.add(o.machineId);
        return;
      case 'event': {
        const s = sessions[o.session];
        if (!s) return;
        if (s.status !== 'ended' && ['finished', 'failed', 'lost'].includes(o.ev.kind)) s.status = 'ended';
        await mgr.onEvent(s.machineId, s.id, o.ev);
      }
    }
  }
  return { rng, sessions, byKey, offline, deliveries, cards, wire, mgr, items, chooseOp, run, ticks, clock };
}
type World = ReturnType<typeof makeWorld>;

function refusalOnly(e: unknown): void {
  if (!(e instanceof TaskRefusal)) throw e;
}

const TERMINAL = new Set(['done', 'failed', 'stopped']);
const snap = (list: Item[]): string => JSON.stringify(list);

/** What must hold whenever nothing is in flight. `before` is the state ahead of the step, `ops` what ran. Every message names the seed and step. */
function checkInvariants(w: World, before: Item[], after: Item[], ops: Op[], tag: string): void {
  const fail = (msg: string): never => assert.fail(`${tag}: ${msg}\nops: ${JSON.stringify(ops)}`);
  const open = after.filter((i) => i.state === 'working' || i.state === 'needs_you');
  // no orphan session: every live session belongs to exactly one open task, and each task has at most one live session
  for (const s of w.sessions.filter((x) => x.status === 'live')) {
    const owners = open.filter((i) => i.where.machineId === s.machineId && i.where.sessionId === s.id);
    if (owners.length !== 1) fail(`live session ${s.id} (item ${s.itemId}) has ${owners.length} owning open tasks`);
  }
  for (const i of after) {
    const live = w.sessions.filter((s) => s.itemId === i.id && s.status === 'live');
    if (live.length > 1) fail(`task ${i.id} runs ${live.length} attempts at once`);
    // vice versa: a working task has a session that is live (or finished silently, waiting for recover)
    if (i.state === 'working') {
      const s = w.sessions.find((x) => x.id === i.where.sessionId);
      if (!s) fail(`working task ${i.id} has no session (stuck)`);
      else if (s.status === 'ended') fail(`working task ${i.id} points at ended session ${s.id}`);
    }
    if (i.state === 'needs_you' && i.cardId !== null) {
      const s = w.sessions.find((x) => x.id === i.where.sessionId);
      if (!s || s.status === 'ended') fail(`task ${i.id} waits on card ${i.cardId} but its session is gone`);
    }
    if (i.attempts > i.attemptCap || i.attemptCap > HARD_ATTEMPTS) fail(`task ${i.id} attempts ${i.attempts} cap ${i.attemptCap}`);
    if (i.posted > i.settled) fail(`task ${i.id} posted ${i.posted} > settled ${i.settled}`);
  }
  // (the five-working cap is checked on create below; a retry past the cap is finding F1 in momoTasksInterleavingsFindings.test.ts)
  // at most one delivered card per (task, settle); and every delivered card belongs to a real settle
  for (const [key, n] of w.deliveries) {
    if (n > 1) fail(`card ${key} delivered ${n} times`);
    const i = after.find((x) => x.id === key.split(':')[0]);
    if (!i || Number(key.split(':')[1]) > i.settled) fail(`card ${key} has no settle behind it`);
  }
  // stop is idempotent: a session is stopped at most once
  for (const s of w.sessions) if (s.stops > 1) fail(`session ${s.id} stopped ${s.stops} times`);
  // transitions: terminal stays terminal unless a retry made a NEW attempt
  const started = new Set(ops.flatMap((o) => (o.op === 'start' ? [before[o.item]?.id] : [])));
  for (const b of before) {
    const a = after.find((x) => x.id === b.id);
    if (!a) fail(`task ${b.id} vanished`);
    else if (b.state === 'done' && (a.state !== 'done' || a.settled !== b.settled))
      fail(`done task ${b.id} changed to ${a.state}/${a.settled}`);
    else if (TERMINAL.has(b.state) && !started.has(b.id)) {
      if (a.state !== b.state || a.settled !== b.settled || a.where.sessionId !== b.where.sessionId)
        fail(`terminal task ${b.id} (${b.state}) became ${a.state}, settled ${b.settled} -> ${a.settled}, without a retry`);
    } else if (TERMINAL.has(b.state) && a.state === 'working' && (a.attempts !== b.attempts + 1 || a.where.sessionId === b.where.sessionId))
      fail(`task ${b.id} restarted without a NEW attempt`);
    if (a && a.settled < b.settled) fail(`settle went backwards for ${b.id}`);
  }
}

/** Events that can only be stale: the target session is not the current session of an open task. They must change nothing at all. */
function staleEvent(o: Op, before: Item[], w: World): boolean {
  if (o.op !== 'event') return false;
  const s = w.sessions[o.session];
  if (!s) return true;
  return !before.some((i) => i.where.machineId === s.machineId && i.where.sessionId === s.id && !TERMINAL.has(i.state));
}

async function sequence(seed: number, steps: number, configure?: (w: World) => void): Promise<void> {
  const w = makeWorld(seed);
  configure?.(w);
  for (let step = 0; step < steps; step++) {
    const tag = `seed ${seed} step ${step}`;
    const before = await w.items();
    const ops: Op[] = [await w.chooseOp()];
    // sometimes two operations race, never two starts on one task (the Host's key answers the same session twice)
    if (w.rng() < 0.3) {
      const second = await w.chooseOp();
      const same = (a: Op, b: Op) => (a.op === 'start' || a.op === 'stop') && (b.op === 'start' || b.op === 'stop') && a.item === b.item;
      if (!same(ops[0] as Op, second) && !(ops[0]?.op === 'create' && second.op === 'create')) ops.push(second);
    }
    const results = await Promise.all(ops.map((o) => w.run(o)));
    const after = await w.items();
    checkInvariants(w, before, after, ops, tag);
    if (ops.length === 1 && staleEvent(ops[0] as Op, before, w) && snap(before) !== snap(after))
      assert.fail(`${tag}: a stale event changed a task\nops: ${JSON.stringify(ops)}`);
    // queue: a create is a live task, or says why not; a refusal for being full needs five working
    const made = (results[0] as { created?: Awaited<ReturnType<TaskManager['create']>> } | undefined)?.created;
    if (ops.length === 1 && made) {
      if (made.error === null && made.item.state !== 'working' && !before.some((i) => i.id === made.item.id))
        assert.fail(`${tag}: create gave ${made.item.state} with no reason`);
      if (
        made.error === null &&
        made.item.state === 'working' &&
        !before.some((i) => i.id === made.item.id) &&
        before.filter((i) => i.state === 'working').length >= MAX_WORKING
      )
        assert.fail(`${tag}: create started a sixth working task`);
      if (made.error?.code === 'too_many_active' && before.filter((i) => i.state === 'working').length < MAX_WORKING)
        assert.fail(`${tag}: refused as full with ${before.filter((i) => i.state === 'working').length} working`);
    }
  }
  // end: heal the wires and deliver; every settle has exactly one card, and nothing is owed
  w.wire.sinkFails = false;
  await w.mgr.flushCards();
  const end = await w.items();
  // (a card still owed when the item settles again is replaced by the newer one: only the latest settle is owed)
  for (const i of end)
    if (i.settled > 0)
      assert.equal(
        w.deliveries.get(`${i.id}:${i.settled}`),
        1,
        `seed ${seed}: card ${i.id}:${i.settled} delivered ${w.deliveries.get(`${i.id}:${i.settled}`) ?? 0} times`,
      );
}

const SEQUENCES = 300;
const STEPS = 40;

test(`${SEQUENCES} seeded interleavings keep every task invariant after every step`, async () => {
  for (let seed = 1; seed <= SEQUENCES; seed++) await sequence(seed, STEPS);
});

test('the same seed makes the same sequence (a failure can be replayed)', async () => {
  const trace = async (seed: number): Promise<string> => {
    const w = makeWorld(seed);
    const out: Op[] = [];
    for (let i = 0; i < 25; i++) {
      const o = await w.chooseOp();
      out.push(o);
      await w.run(o);
    }
    return JSON.stringify([out, await w.items()]);
  };
  assert.equal(await trace(77), await trace(77));
  assert.notEqual(await trace(77), await trace(78));
});

test('a quiet world (no wire failures) also stays consistent and eventually delivers every card', async () => {
  for (let seed = 1000; seed < 1100; seed++)
    await sequence(seed, STEPS, (w) => {
      w.wire.chaos = false;
      w.wire.sinkFails = false;
    });
});

test('every state is reached across the seeds (the generator is not vacuous)', async () => {
  const seen = new Set<string>();
  let cardsDelivered = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const w = makeWorld(seed);
    for (let i = 0; i < STEPS; i++) {
      await w.run(await w.chooseOp());
      for (const it of await w.items()) seen.add(it.state);
    }
    cardsDelivered += w.deliveries.size;
  }
  for (const s of ['working', 'needs_you', 'done', 'failed', 'stopped']) assert.ok(seen.has(s), `state ${s} never reached`);
  assert.ok(cardsDelivered > 20);
});
