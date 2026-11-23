// A second model of moving MoMo's home over the pure rules (shared/host/momoMovePhases.mjs): two targets, wrong-epoch and replayed-receipt finishes, and the invariants the first model leaves out (distinct leases among running machines, a lease that never goes back, closed ids stay closed, a wipe only after a switch, stamps fenced by the real sink).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { oldHome, target, MOVE_TTL_MS, MOVE_GRACE_MS } from '../shared/host/momoMovePhases.mjs';
// @ts-ignore
import { createStampSink } from '../shared/momoStamp.mjs';

const MOVES: [string, 'B' | 'C'][] = [
  ['m1', 'B'],
  ['m2', 'C'],
];
const DEPTH = 7;

type Tgt = {
  phase: 'offered' | 'received' | 'committed' | 'discarded';
  expiresAt: number;
  key: string;
  epoch: number | null;
  hash: string | null;
};
type Machine = { state: 'none' | 'running'; leaseEpoch: number; moves: Record<string, Tgt> };
type World = {
  t: number;
  a: any;
  b: Machine;
  c: Machine;
  begun: Record<string, number>;
  sealed: Record<string, true>;
  maxA: number; // the highest lease the old home ever held
  keys: number;
  seals: number;
  sealedHash: Record<string, string>; // the hash of the bundle the old home last sealed for a move
  ended: string[]; // move ids the old home ended (cancel, expiry, reclaim)
  heldAtWipe: number; // the lease the old home held when it wiped its copy
};
const fresh = (): World => ({
  t: 0,
  a: {
    state: 'running',
    leaseEpoch: 1,
    moveId: null,
    bundleHash: null,
    moveDeadline: null,
    targetSignKey: null,
    closedMoves: [],
    movedTo: null,
  },
  b: { state: 'none', leaseEpoch: 0, moves: {} },
  c: { state: 'none', leaseEpoch: 0, moves: {} },
  begun: {},
  sealed: {},
  maxA: 1,
  keys: 0,
  seals: 0,
  sealedHash: {},
  ended: [],
  heldAtWipe: 0,
});
const clone = (w: World): World => JSON.parse(JSON.stringify(w));
const machine = (w: World, k: 'B' | 'C') => (k === 'B' ? w.b : w.c);

function applyOld(w: World, o: any, leaseEpoch?: number) {
  if (o.set) {
    if (w.a.state === 'moving' && o.set.state === 'running' && w.a.moveId) w.ended.push(w.a.moveId);
    Object.assign(w.a, o.set);
    if (typeof o.epoch === 'number') w.a.leaseEpoch = o.epoch;
  } else if (o.wipe) {
    w.heldAtWipe = w.a.leaseEpoch;
    Object.assign(w.a, { state: 'none', moveId: null, bundleHash: null, moveDeadline: null, targetSignKey: null, movedTo: true });
    if (leaseEpoch !== undefined) w.a.leaseEpoch = leaseEpoch; // the tombstone is at the lease the target gave
  }
  if (w.a.state !== 'none') w.maxA = Math.max(w.maxA, w.a.leaseEpoch);
}

function steps(w: World, skew: number): { label: string; next: World }[] {
  const out: { label: string; next: World }[] = [];
  const add = (label: string, f: (n: World) => void) => {
    const n = clone(w);
    f(n);
    out.push({ label, next: n });
  };
  const nowA = w.t;
  const nowB = w.t + skew;
  add('tick past every deadline', (n) => void (n.t += MOVE_TTL_MS + MOVE_GRACE_MS + 1000));
  add('expire A', (n) => applyOld(n, oldHome.expire(n.a, { now: nowA })));
  for (const k of ['B'] as const)
    add(`crash ${k}`, (n) => {
      for (const [id, m] of Object.entries(machine(n, k).moves))
        if (m.phase === 'offered' || m.phase === 'received') delete machine(n, k).moves[id];
    });
  for (const [m, k] of MOVES) {
    add(`begin ${m}`, (n) => {
      const o: any = oldHome.begin(n.a, { moveId: m, now: nowA });
      applyOld(n, o);
      if (o.set) n.begun[m] = n.a.leaseEpoch;
    });
    add(`offer ${m}`, (n) => {
      const t = machine(n, k);
      const o: any = target.offer(t.moves[m], { homeState: t.state, now: nowB });
      if (o.error || t.moves[m]?.phase === o.phase) return;
      t.moves[m] = { phase: 'offered', expiresAt: nowB + MOVE_TTL_MS, key: `k${m}${++n.keys}`, epoch: null, hash: null };
    });
    add(`seal ${m}`, (n) => {
      const hash = `h${m}-${++n.seals}`;
      const o: any = oldHome.seal(n.a, { moveId: m, signKey: machine(n, k).moves[m]?.key ?? `k${m}0`, hash, now: nowA });
      applyOld(n, o);
      if (o.set) {
        n.sealed[m] = true;
        n.sealedHash[m] = hash;
      }
    });
    add(`receive ${m}`, (n) => {
      if (!n.sealed[m]) return;
      const t = machine(n, k);
      const o: any = target.receive(t.moves[m], { now: nowB });
      if (!o.error) {
        t.moves[m]!.phase = 'received';
        t.moves[m]!.hash = n.sealedHash[m] ?? null;
      }
    });
    add(`commit ${m}`, (n) => {
      const t = machine(n, k);
      const mv = t.moves[m];
      const o: any = target.commit(mv, { now: nowB, stageOwned: mv?.phase === 'received' });
      if (o.error || o.answer || t.state !== 'none' || n.begun[m] === undefined) return;
      mv!.phase = 'committed';
      mv!.epoch = n.begun[m]! + 1;
      t.state = 'running';
      t.leaseEpoch = mv!.epoch;
    });
    // a client that asks the target to switch at the old home's own lease (a bug in the client): the target cannot know, the old home must refuse the receipt
    add(`commit ${m} at the old lease`, (n) => {
      const t = machine(n, k);
      const mv = t.moves[m];
      const o: any = target.commit(mv, { now: nowB, stageOwned: mv?.phase === 'received' });
      if (o.error || o.answer || t.state !== 'none' || n.a.state !== 'moving' || n.a.moveId !== m) return;
      mv!.phase = 'committed';
      mv!.epoch = n.a.leaseEpoch;
      t.state = 'running';
      t.leaseEpoch = n.a.leaseEpoch;
    });
    add(`discard ${m}`, (n) => {
      const mv = machine(n, k).moves[m];
      if ((target.discard(mv) as any).ok)
        machine(n, k).moves[m] = { phase: 'discarded', expiresAt: mv?.expiresAt ?? 0, key: mv?.key ?? '', epoch: null, hash: null };
    });
    add(`cancel ${m}`, (n) => {
      const mv = machine(n, k).moves[m];
      applyOld(n, oldHome.cancel(n.a, { moveId: m, proofOk: mv?.phase === 'discarded' && mv.key === n.a.targetSignKey }));
    });
    add(`reclaim ${m}`, (n) => applyOld(n, oldHome.reclaim(n.a, { moveId: m })));
    add(`finish ${m}`, (n) => {
      const mv = machine(n, k).moves[m];
      const ok = mv?.phase === 'committed' && mv.key === n.a.targetSignKey && mv.epoch !== null && mv.hash === n.a.bundleHash;
      const lease = mv?.epoch ?? n.a.leaseEpoch + 1;
      applyOld(n, oldHome.finish(n.a, { moveId: m, leaseEpoch: lease, receiptOk: ok }), lease);
    });
  }
  return out;
}

function violation(w: World): string | null {
  const running = [
    w.a.state === 'running' ? { key: 'A', epoch: w.a.leaseEpoch } : null,
    w.b.state === 'running' ? { key: 'B', epoch: w.b.leaseEpoch } : null,
    w.c.state === 'running' ? { key: 'C', epoch: w.c.leaseEpoch } : null,
  ].filter(Boolean) as { key: string; epoch: number }[];
  const epochs = running.map((r) => r.epoch);
  if (new Set(epochs).size !== epochs.length) return `two running machines hold the same lease: ${JSON.stringify(running)}`;
  if (w.a.leaseEpoch < w.maxA) return "the old home's lease went back";
  if (running.length === 0 && w.a.state !== 'moving') return 'the home is lost';
  if (w.a.state === 'none' && !running.some((r) => r.key !== 'A' && r.epoch >= w.a.leaseEpoch && r.epoch > w.heldAtWipe))
    return 'the old home wiped with no target running at a lease above the one it held';
  if (w.a.state === 'running' && w.a.moveId !== null) return 'a running home still holds a move id';
  // the old home that runs beside a target must be the newer lease (the reclaimed one), never the older
  for (const r of running)
    if (r.key !== 'A' && w.a.state === 'running' && !(w.a.leaseEpoch > r.epoch))
      return `the old home runs at ${w.a.leaseEpoch}, not above ${r.key}@${r.epoch}`;
  // a switch the old home is still waiting on can be finished: the receipt names the bundle the old home sealed last
  for (const [m, k] of MOVES) {
    const mv = (k === 'B' ? w.b : w.c).moves[m];
    if (mv?.phase === 'committed' && w.a.state === 'moving' && w.a.moveId === m && mv.hash !== w.a.bundleHash)
      return `the target switched on a bundle the old home no longer holds (${m})`;
  }
  for (const id of w.ended)
    if (!(oldHome.begin(clone(w).a, { moveId: id, now: w.t }) as any).error) return `an ended move (${id}) is not refused by begin`;
  for (const id of w.a.closedMoves) {
    if (w.a.state === 'none') break;
    const o: any = oldHome.begin(clone(w).a, { moveId: id, now: w.t });
    if (!o.error) return `an ended move (${id}) could pause the home again`;
  }
  // every stamp receiver, in either order, refuses all but the newest lease
  if (running.length > 1) {
    const top = Math.max(...epochs);
    for (const order of [[...running].sort((x, y) => x.epoch - y.epoch), [...running].sort((x, y) => y.epoch - x.epoch)]) {
      let newest: any = null;
      const sink = createStampSink({ read: () => newest, write: (n: any) => void (newest = n) });
      for (const r of order) sink.accept({ homeId: r.key, leaseEpoch: r.epoch });
      for (const r of running)
        if (r.epoch < top && sink.accept({ homeId: r.key, leaseEpoch: r.epoch }).ok)
          return `a receiver believes the older home ${r.key}@${r.epoch}`;
    }
  }
  if (w.a.state === 'moving') {
    const o: any = oldHome.reclaim(clone(w).a, { moveId: w.a.moveId });
    if (!o.set || !(o.epoch > Math.max(0, ...epochs.filter((_, i) => running[i].key !== 'A'))))
      return 'the owner cannot end the move above the targets';
  }
  return null;
}

for (const skew of [-(MOVE_TTL_MS + MOVE_GRACE_MS), 0]) {
  test(`two targets, wrong receipts and every older stamp: every interleaving to depth ${DEPTH} keeps distinct leases, a monotonic lease, closed ids closed and the newest lease alone believed (target clocks ${skew / 60_000} min off)`, () => {
    let frontier = [fresh()];
    const seen = new Set([JSON.stringify(frontier[0])]);
    const reached = new Set<string>();
    for (let depth = 0; depth < DEPTH; depth++) {
      const next: World[] = [];
      for (const w of frontier)
        for (const s of steps(w, skew)) {
          const key = JSON.stringify(s.next);
          if (seen.has(key)) continue;
          seen.add(key);
          const bad = violation(s.next);
          assert.equal(bad, null, `${bad} after "${s.label}" from ${JSON.stringify(w)}`);
          if (s.next.a.state === 'none') reached.add('moved');
          if (s.next.a.leaseEpoch > 2 && s.next.a.state === 'running') reached.add('reclaimed');
          if (s.next.a.state === 'running' && (s.next.b.state === 'running' || s.next.c.state === 'running')) reached.add('fenced twin');
          if (s.next.b.state === 'running' && s.next.c.state === 'running') reached.add('two targets');
          next.push(s.next);
        }
      frontier = next;
    }
    assert.ok(seen.size > 1000, `explored ${seen.size} worlds`);
    for (const r of ['moved', 'reclaimed', 'fenced twin']) assert.ok(reached.has(r), r);
  });
}
