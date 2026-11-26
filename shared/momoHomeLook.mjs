// What MoMo's real home makes of the Hosts' answers (shared/momoHomeReal.mjs): one look at every machine that can be the home, and from it which one is, whether two claim it, which answer below the lease on record, where MoMo moved to, and what the view says of each. No state of its own: the caller keeps what it remembers and which Hosts are quiet.
import { answerOf, decide, VERSION_FRESH_MS } from './host/momoHomeClient.mjs';
import { TRANSPORT, unknownRequest } from './momoHomeAsk.mjs';
import { moveView } from './momoHomeView.mjs';

/** The homes one MoMo has lived on that a held message may still go to (a move keeps the chat's ledger). */
export const LINEAGE_MAX = 8;
/** Whether the call may have reached the Host: the tunnel dropped or the wait ran out, as against a Host that answered "no". @param {unknown} error */
export const mayHaveArrived = (error) => {
  const code = /** @type {any} */ (error)?.code;
  return typeof code !== 'string' || TRANSPORT.has(code);
};

/**
 * @typedef {import('./momoHomeView.mjs').MachineRecord} MachineRecord
 * @typedef {{ machineId: string | null, homeId: string, leaseEpoch: number, name: string, lineage: string[], at?: number }} HomeNote where MoMo was last seen to live, and when it was last seen there
 * @typedef {ReturnType<typeof decide>} Decision
 * @typedef {{ at: number, machines: MachineRecord[], home: { machine: MachineRecord, status: any } | null, status: any, heardAt: number | null, tombstone: any, decision: Decision, note: HomeNote | null, lost: boolean, unheard: MachineRecord[], live: { id: string, homeId: string, leaseEpoch: number, name: string }[], older: { machine: MachineRecord, lastActive: number, leaseEpoch: number, movedTo: { name: string, homeId: string } }[] }} Read one look at the Hosts and what the shared rules (shared/host/momoHomeClient.mjs) make of it; `note` is what to remember when one of them is the home; `lost`: MoMo was seen on a machine that is gone from the list or that says it holds no home
 */

/**
 * Asks every machine that can be MoMo's home what it keeps (`host.momoHomeLook`) and lets the shared `decide` say which one is the home, who stands down and
 * whether a new one may be offered. A machine that has no Host holds none; one that is unreachable, quiet, refuses or does not answer has not been heard, and
 * a home that cannot be asked is its remembered self (asleep). A Host that does not know the look is a build without the feature.
 * @param {object} o
 * @param {{ machines: () => MachineRecord[], heardAt?: (id: string) => number | null }} o.hosts
 * @param {(id: string) => Promise<any>} o.look one machine's `host.momoHomeLook`, within its time
 * @param {(id: string) => Promise<any>} o.status one machine's `host.momoStatus` (the whole of what a home holds), within its time
 * @param {() => number} o.seen the highest lease this account has seen on any Host
 * @param {() => boolean} o.fresh the owner confirmed Start fresh and is picking the machine
 * @param {HomeNote | null} o.remembered
 * @param {Map<string, { fails: number, until: number, noLook?: boolean }>} o.quiet Hosts that did not answer, and when they are asked again
 * @param {() => number} o.now
 * @param {boolean} o.force ask the quiet ones too
 * @param {(error: unknown) => void} o.report told of a status that could not be had
 * @returns {Promise<Read>}
 */
export async function lookAtHosts({ hosts, look: lookOf, status: statusOf, seen, fresh, remembered, quiet, now, force, report }) {
  const machines = hosts.machines();
  const asked = await Promise.all(
    machines.map(async (m) => {
      /** @type {import('./host/momoHomeClient.mjs').Machine} */
      const base = {
        id: m.id,
        hasHost: m.hasHost !== false,
        reachable: m.reachable,
        lookFeature: true,
        // only a release version reported within the last minutes says a Host is too old to hold a home (a build id has no order)
        version: m.hostAppVersion ?? null,
        versionFresh: m.hostVersionAt != null && now() - m.hostVersionAt <= VERSION_FRESH_MS,
        look: null,
      };
      if (!base.hasHost || !m.reachable) return base;
      const q = quiet.get(m.id);
      if (!force && q && q.until > now()) return q.noLook ? { ...base, lookFeature: false, look: undefined } : base;
      try {
        const look = await lookOf(m.id);
        quiet.delete(m.id);
        return { ...base, look };
      } catch (error) {
        // told, so "couldn’t reach" has its cause in the diagnostics; a Host that does not know the request is a build without the feature, and is read by its build
        report(error);
        // a Host that does not know the look is a build without it, and is not asked again at every heartbeat
        const noLook = unknownRequest(error);
        if (noLook || mayHaveArrived(error)) {
          const fails = (q?.fails ?? 0) + 1;
          quiet.set(m.id, { fails, noLook, until: now() + Math.min(300_000, noLook ? 30_000 * 2 ** (fails - 1) : 5_000 * 2 ** fails) });
        }
        return noLook ? { ...base, lookFeature: false, look: undefined } : base;
      }
    }),
  );
  const decision = decide(asked, { seen: seen(), chosen: null, freshConfirmed: fresh() });
  const answers = new Map(asked.map((a) => [a.id, answerOf(a)]));
  const holders = asked.filter((a) => a.look?.holds === 'home' && String(a.look.homeId) === decision.winner);
  const top = holders.sort((a, b) => /** @type {any} */ (b.look).leaseEpoch - /** @type {any} */ (a.look).leaseEpoch)[0];
  const winnerMachine = top ? machines.find((m) => m.id === top.id) : undefined;
  const winnerLook = /** @type {any} */ (top?.look);
  /** @type {any} */
  let winnerStatus = null;
  if (winnerMachine) {
    // the whole of what it holds (moves, times) comes with the status; when that is still veiled, what the look said is enough to know it holds a home
    try {
      winnerStatus = await statusOf(winnerMachine.id);
    } catch (error) {
      // the look already said it holds a home: that is what is shown when the whole status cannot be had
      report(error);
    }
    if (!winnerStatus?.home?.homeId)
      winnerStatus = {
        home: {
          homeId: winnerLook.homeId,
          leaseEpoch: winnerLook.leaseEpoch,
          state: winnerLook.state ?? 'running',
          stateSince: 0,
          lastSeenAt: 0,
          name: winnerLook.name ?? '',
        },
      };
  }
  const movedFrom = asked.find((a) => a.look?.holds === 'moved');
  const tombstone = movedFrom
    ? {
        homeId: null,
        leaseEpoch: /** @type {any} */ (movedFrom.look).leaseEpoch,
        state: 'none',
        name: '',
        movedTo: /** @type {any} */ (movedFrom.look).movedTo,
      }
    : null;
  /** @type {HomeNote | null} */
  let note = null;
  if (winnerMachine && winnerStatus) {
    const h = winnerStatus.home;
    // a home continues the line of the one before only when MoMo was MOVED to it (the old Host says so): one that merely won a lease, or was started on its own, is
    // another MoMo, and what was held for the old one waits for the owner's word
    const was = remembered?.machineId ? answers.get(remembered.machineId) : null;
    // (a home that was stood down by a newer lease also names the one that replaced it, but it is `retired`, not moved: that is a lease, not the owner's move)
    const movedOn = was?.kind === 'none' && was.movedTo?.homeId === h.homeId;
    const lineage =
      !remembered?.homeId || remembered.homeId === h.homeId
        ? (remembered?.lineage ?? [])
        : movedOn
          ? [...remembered.lineage, remembered.homeId]
          : [];
    note = {
      machineId: winnerMachine.id,
      homeId: h.homeId,
      leaseEpoch: h.leaseEpoch,
      name: h.name,
      lineage: [...new Set(lineage)].slice(-LINEAGE_MAX),
    };
  }
  const known = note ?? remembered;
  // seen on a machine that is gone from the list, or that holds none and moved none: the way back is the owner's, with a confirmation
  const there = known?.machineId ? answers.get(known.machineId) : null;
  const lost = !winnerMachine && !!known?.machineId && (!there || (there.kind === 'none' && !('movedTo' in there && there.movedTo)));
  /** @type {any} */
  let status = null;
  if (winnerStatus) status = winnerStatus;
  else if (known)
    status = {
      home: { homeId: known.homeId, leaseEpoch: known.leaseEpoch, state: 'running', stateSince: 0, lastSeenAt: 0, name: known.name },
    };
  else if (tombstone && decision.picker !== 'fresh') status = { home: tombstone };
  // before every machine has said it holds none, nothing says there is no home: asleep, never the first-run choice
  else if (decision.picker !== 'choose' && decision.picker !== 'fresh')
    status = { home: { homeId: null, leaseEpoch: 0, state: 'running', stateSince: 0, lastSeenAt: 0, name: '' } };
  return {
    at: now(),
    machines: machines.map((m) => (winnerMachine && m.id === winnerMachine.id ? { ...m, hostId: winnerStatus.home.homeId } : m)),
    home: winnerMachine ? { machine: winnerMachine, status: winnerStatus } : null,
    status,
    heardAt: winnerMachine ? now() : known?.machineId ? (hosts.heardAt?.(known.machineId) ?? null) : null,
    tombstone,
    decision,
    note,
    lost,
    unheard: machines.filter((m) => decision.unheard.includes(m.id)),
    live: asked
      .flatMap((a) => (answerOf(a).kind === 'home' ? [{ id: a.id, .../** @type {any} */ (answerOf(a)) }] : []))
      .map((h) => ({ id: h.id, homeId: h.homeId, leaseEpoch: h.leaseEpoch, name: h.name })),
    // `decision.older` comes from `asked`, which is one entry per machine of the single `hosts.machines()` read above: each has its machine and its answer
    older: decision.older.map((o) => ({
      machine: /** @type {MachineRecord} */ (machines.find((m) => m.id === o.host)),
      lastActive: o.lastActive,
      leaseEpoch: /** @type {any} */ (answers.get(o.host)).leaseEpoch,
      movedTo: o.movedTo,
    })),
  };
}

/** The move the home Host says is under way when this device did not start it (another device did, or the app restarted): its own words and the way back. @param {Read} r */
export function moveOfStatus(r) {
  const h = r.home?.status.home;
  if (!h || h.state !== 'moving' || !h.moveId || !r.home) return null;
  const from = { machineId: r.home.machine.id, name: r.home.machine.name };
  const to = { machineId: '', name: 'the other machine' };
  if (!h.moveExpired) return moveView({ moveId: h.moveId, from, to, step: 'sealed' });
  // sealed and past its time: the old home stays paused until the target is asked, so the owner may reclaim it
  return moveView({
    moveId: h.moveId,
    from,
    to,
    step: 'sealed',
    result: {
      ok: false,
      step: 'sealed',
      code: 'timeout',
      message: `The move did not finish, and MoMo is paused on ${from.name}.`,
      rolledBack: false,
    },
    finishedAt: h.stateSince ?? null,
  });
}

/** The problems the view tells that are not the Host's: a step of the shared rules the Host refused, and the ways to start over. @param {Read & { failure?: string | null }} r */
export function leaseProblems(r) {
  /** @type {any[]} */
  const out = [];
  if (r.failure)
    out.push({ id: 'lease:steps', code: 'lease_steps', cause: r.failure, fix: { id: 'check-again', label: 'Check again' }, since: null });
  if (r.decision.blocked)
    out.push({
      id: 'home:moving',
      code: 'move_in_progress',
      cause: 'MoMo is being moved; nothing was changed until it ends.',
      fix: { id: 'check-again', label: 'Check again' },
      since: null,
    });
  // the owner confirmed Start fresh and is choosing the machine: nothing else is asked
  if (r.home || r.decision.winner || r.decision.picker === 'fresh') return out;
  const names = r.unheard.map((m) => m.name).join(' and ');
  const fix = { id: 'start-fresh', label: 'Start fresh' };
  if (r.lost)
    out.push({
      id: 'home:lost',
      code: 'home_lost',
      cause: `MoMo’s home on ${r.status?.home?.name || 'its machine'} can’t be found. If that machine is gone for good, start fresh: MoMo starts over, and what it knew there is not copied.`,
      fix,
      since: null,
    });
  // nothing is known of where MoMo lives and some machines have not said they hold none: the owner may start fresh, once told what that risks
  else if (r.decision.offerStartFresh && !r.note && r.unheard.length > 0)
    out.push({
      id: 'home:unheard',
      code: 'home_unheard',
      cause: `Couldn’t reach ${names}. If MoMo already lives there, starting here makes a second one.`,
      fix,
      since: null,
    });
  else if (r.decision.offerStartFresh && r.tombstone && !r.note)
    out.push({
      id: 'home:moved',
      code: 'home_moved',
      cause: `MoMo moved to ${r.tombstone.movedTo?.name ?? 'another machine'}, and that machine doesn’t hold it. If it is gone for good, start fresh.`,
      fix,
      since: null,
    });
  return out;
}
