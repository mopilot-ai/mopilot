// Runs one scripted fault through a whole move and reports what each invariant said before and after the machines come back and the move is recovered.
import { twoMachines, drive, violations, sealedHashes, recover, healthy, observe, type Fault, type World } from './world.ts';
import { mulberry32, pick } from './rng.ts';
// @ts-ignore: plain ESM without declarations
import { moveHome } from '../../../shared/momoMove.mjs';

export type Outcome = {
  id: string;
  result: any;
  instant: string[];
  afterRestart: string[];
  afterRecovery: string[];
  unhealthy: string[];
  honest: string[];
  world: World;
};

export const describeFault = (f: Fault) => `${f.machine}.${f.op}#${f.nth ?? 1}:${f.kind}${f.k ? `@${f.k}` : ''}`;

/** Count the state changes each machine makes in an undisturbed move, per step, so kill points can be enumerated. */
export async function killPoints(): Promise<{ machine: 'A' | 'B'; op: string; n: number }[]> {
  const w = await twoMachines();
  const out: { machine: 'A' | 'B'; op: string; n: number }[] = [];
  const side = { A: w.net.side('A'), B: w.net.side('B') };
  for (const key of ['A', 'B'] as const) {
    const real = side[key].call;
    side[key].call = async (op: string, p?: object) => {
      const before = w.m[key]!.v.mutations;
      const r = await real(op, p);
      out.push({ machine: key, op, n: w.m[key]!.v.mutations - before });
      return r;
    };
  }
  await (moveHome as any)({
    moveId: 'move-0001',
    from: side.A,
    to: side.B,
    target: { homeId: 'home-bbbb-2222', name: 'Mac mini' },
    fromName: 'Studio',
  });
  w.dispose();
  return out;
}

/** @param faults the script; @param prep optional change to the world before the move starts */
export async function runFault(
  faults: Fault[],
  o: { cancelled?: () => boolean; moveId?: string; prep?: (w: World) => Promise<void> | void } = {},
): Promise<Outcome> {
  const w = await twoMachines();
  await o.prep?.(w);
  w.net.faults = faults;
  const moveId = o.moveId ?? 'move-0001';
  const result = await drive(w, { moveId, cancelled: o.cancelled });
  const instant = await violations(w, sealedHashes(w));
  const honest: string[] = [];
  const a = w.m.A!;
  const b = w.m.B!;
  if (result.ok && !(b.alive && b.acts() && b.record().leaseEpoch === 2)) honest.push('reported moved but B does not run at epoch 2');
  // rolled back: A runs again, or (a lost begin answer) holds only an unsealed move that ends by itself
  if (
    !result.ok &&
    result.rolledBack &&
    !(a.record().leaseEpoch === 1 && (a.record().state === 'running' || (a.record().state === 'moving' && a.record().bundleHash === null)))
  )
    honest.push('reported rolled back but A does not run at epoch 1');
  await w.net.deliverHeld();
  for (const m of w.all()) if (!m.alive) m.restart();
  const afterRestart = await violations(w, sealedHashes(w));
  await recover(w, [moveId]);
  const afterRecovery = await violations(w, sealedHashes(w));
  const unhealthy = await healthy(w, { strays: false });
  return { id: faults.map(describeFault).join('+') || 'none', result, instant, afterRestart, afterRecovery, unhealthy, honest, world: w };
}

export type Case = { faults: Fault[]; cancelAt?: number };

/** The faults of one step: the frame lost on the way in, its answer lost, the frame delivered twice, the machine killed before it, and killed at each of its own state changes. */
export function stepFaults(machine: 'A' | 'B', op: string, mutations: number): Case[] {
  const out: Case[] = (['drop-req', 'drop-resp', 'dup', 'kill-before'] as const).map((kind) => ({ faults: [{ machine, op, kind }] }));
  for (let k = 1; k <= mutations; k++) out.push({ faults: [{ machine, op, kind: 'kill-at', k }] });
  return out;
}

/** Every case of the given steps, discovered from an undisturbed move so a new state change in the code is a new kill point. */
export async function casesFor(ops: string[]): Promise<Case[]> {
  const points = await killPoints();
  return points.filter((p) => ops.includes(p.op)).flatMap((p) => stepFaults(p.machine, p.op, p.n));
}

/** Run each case and collect what broke: one line per case, empty when every invariant held. */
export async function failures(cases: Case[], o: { moveId?: string } = {}): Promise<string[]> {
  const out: string[] = [];
  for (const c of cases) {
    const r = await runFault(c.faults, { cancelled: c.cancelAt ? counter(c.cancelAt) : undefined, moveId: o.moveId });
    const bad = [
      ...r.instant.map((x) => `instant: ${x}`),
      ...r.afterRestart.map((x) => `restarted: ${x}`),
      ...r.afterRecovery.map((x) => `recovered: ${x}`),
      ...r.unhealthy.map((x) => `unhealthy: ${x}`),
      ...r.honest.map((x) => `dishonest: ${x}`),
    ];
    if (bad.length) out.push(`${r.id}${c.cancelAt ? ` cancel#${c.cancelAt}` : ''} -> ${bad.join('; ')}`);
    r.world.dispose();
  }
  return out;
}
/** A Cancel button pressed at the n-th time the move looks. */
const counter = (n: number) => {
  let calls = 0;
  return () => ++calls === n;
};

const POOL: ['A' | 'B', string][] = [
  ['A', 'begin'],
  ['B', 'offer'],
  ['A', 'seal'],
  ['B', 'receive'],
  ['B', 'commit'],
  ['A', 'finish'],
  ['A', 'cancel'],
  ['B', 'discard'],
];
const KINDS = ['drop-req', 'drop-resp', 'dup', 'kill-before', 'kill-at'] as const;
const STEPS = ['paused', 'sealed', 'copied', 'switching', 'resuming', 'cleaning-up'];

export type Schedule = { seed: number; faults: Fault[]; skewB: number; turns: { at: string; to: 'A' | 'B' }[]; cancelAt: number | null };

/** The whole fault schedule of a seed: one to three faults, a clock offset of the target, turns sent while the move runs and maybe a Cancel. */
export function schedule(seed: number): Schedule {
  const rand = mulberry32(seed);
  const faults: Fault[] = [];
  for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n; i++) {
    const [machine, op] = pick(rand, POOL);
    const kind = pick(rand, KINDS);
    faults.push({ machine, op, kind, nth: 1 + Math.floor(rand() * 2), k: kind === 'kill-at' ? 1 + Math.floor(rand() * 4) : undefined });
  }
  const turns = Array.from({ length: Math.floor(rand() * 3) }, () => ({ at: pick(rand, STEPS), to: pick(rand, ['A', 'B'] as const) }));
  return { seed, faults, skewB: Math.round((rand() - 0.5) * 600_000), turns, cancelAt: rand() < 0.25 ? 1 + Math.floor(rand() * 3) : null };
}

/** Run one seed through two move attempts with recovery between, checking the invariants after every stage; returns what went wrong and a trace for replay. */
export async function runSeed(seed: number): Promise<{ problems: string[]; trace: string }> {
  const s = schedule(seed);
  const w = await twoMachines({ skewB: s.skewB });
  w.net.faults = s.faults;
  const problems: string[] = [];
  const trace: string[] = [];
  const check = async (stage: string, extra: string[] = []) => {
    for (const v of [...(await violations(w, sealedHashes(w))), ...extra]) problems.push(`seed ${seed} ${stage}: ${v}`);
  };
  let n = 0;
  const sent: Promise<unknown>[] = [];
  const first = await drive(w, {
    cancelled: s.cancelAt ? counter(s.cancelAt) : undefined,
    step: (at: string) => {
      for (const t of s.turns.filter((x) => x.at === at))
        sent.push(w.sendTurn(t.to, `key-seed-${seed}-${n}`, `claude:seed${seed}-${n++}`).then((r) => trace.push(`turn ${t.to} ${r}`)));
    },
  });
  await Promise.all(sent);
  trace.push(`move1 ${first.ok ? 'ok' : `${first.step}/${first.code}/${first.rolledBack}`}`);
  await check('after the first move');
  await w.net.deliverHeld();
  for (const m of w.all()) if (!m.alive) m.restart();
  await check('after the restart');
  await recover(w, ['move-0001']);
  await check('after the recovery', await healthy(w, { strays: false }));
  w.net.faults = [];
  const second = await drive(w, {
    moveId: 'move-0002',
    from: observe(w).find((o) => o.acts)?.key === 'B' ? 'B' : 'A',
    to: observe(w).find((o) => o.acts)?.key === 'B' ? 'A' : 'B',
  });
  trace.push(`move2 ${second.ok ? 'ok' : `${second.step}/${second.code}`}`);
  await check('after the second move');
  await recover(w, ['move-0001', 'move-0002']);
  await check('after the second recovery', await healthy(w, { strays: false }));
  trace.push(...w.net.log.map((l) => `${l.machine}.${l.op}:${l.ok ? 'ok' : l.code}`));
  w.dispose();
  return { problems, trace: trace.join(' ') };
}

const RECOVERY_POOL: ['A' | 'B', string][] = [
  ['B', 'discard'],
  ['A', 'cancel'],
  ['A', 'finish'],
];

/**
 * A harder seed: exactly `faults` faults in the first move, then up to three more attempts to the same target, each with its own seeded fault and a
 * fresh move id and no settling in between (a Retry pressed again and again), then a recovery that is itself cut (kill, lost frame) and a clean one.
 * The invariants are checked after every stage.
 */
export async function runDeep(seed: number, o: { faults?: number } = {}): Promise<{ problems: string[]; trace: string }> {
  const rand = mulberry32(seed * 7919 + 13);
  const s = schedule(seed);
  const faults = s.faults.slice(0, o.faults ?? 2);
  while (faults.length < (o.faults ?? 2)) faults.push({ machine: 'B', op: 'commit', kind: 'drop-resp' });
  const w = await twoMachines({ skewB: s.skewB });
  const problems: string[] = [];
  const trace: string[] = [];
  const check = async (stage: string, extra: string[] = []) => {
    for (const v of [...(await violations(w, sealedHashes(w))), ...extra]) problems.push(`seed ${seed} ${stage}: ${v}`);
  };
  const ids = ['move-0001'];
  w.net.faults = faults;
  const first = await drive(w, { moveId: 'move-0001' });
  trace.push(`m1 ${first.ok ? 'ok' : `${first.step}/${first.code}`}`);
  await check('after the first move');
  for (let i = 2, n = Math.floor(rand() * 4); i <= n + 1; i++) {
    const [machine, op] = pick(rand, POOL);
    w.net.faults = [{ machine, op, kind: pick(rand, KINDS), nth: w.net.nextNth(machine, op), k: 1 + Math.floor(rand() * 3) }];
    const id = `move-000${i}`;
    ids.push(id);
    // a retry goes from wherever the home is now (it may have moved after all)
    const home = observe(w).find((x) => x.acts)?.key;
    const r = await drive(w, home === 'B' ? { moveId: id, from: 'B', to: 'A' } : { moveId: id });
    trace.push(`m${i} ${r.ok ? 'ok' : `${r.step}/${r.code}`}`);
    await check(`after attempt ${i}`);
  }
  await w.net.deliverHeld();
  w.net.faults = [];
  const [machine, op] = pick(rand, RECOVERY_POOL);
  await recover(w, ids, { faults: [{ machine, op, kind: pick(rand, KINDS), nth: 1, k: 1 + Math.floor(rand() * 2) }] });
  await check('after a cut recovery');
  await recover(w, ids);
  await check('after the recovery', await healthy(w, { strays: false }));
  trace.push(...w.net.log.map((l) => `${l.machine}.${l.op}:${l.ok ? 'ok' : l.code}`));
  w.dispose();
  return { problems, trace: trace.join(' ') };
}
