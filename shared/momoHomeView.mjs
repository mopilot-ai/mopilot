// The home's data in the shape of the view contract (shared/momoView.ts, design 1 "Always there"): the home view (state, machine, move, machines, agent problem, update), a message's delivery and a move's view, derived in one place from what the Host answered (`host.momoStatus`, `host.momoTurn`), the app's machine records and the device's own outbox. Pure: the Mac's IPC and the phone's transport call these, so the two never disagree.
import { homeStateOf } from './momoHomeState.mjs';
import { MOVE_STEPS, reclaimWords } from './momoMove.mjs';

/** @typedef {{ id?: string, name: string, installed: boolean, signedIn: boolean }} AgentRecord `id` is what a fix names (the app's own id for the agent); the name is what a screen shows */
/** @typedef {{ id: string, hostId?: string, name: string, isThisDevice: boolean, reachable: boolean, current: boolean, stays: 'on' | 'sleeps' | 'cloud', setUp: boolean, agents: AgentRecord[], hostBuild?: string, needBuild?: string }} MachineRecord what the app's machine list knows of one machine; `hostId` is the id its Host named itself with when it was paired (the home record names the home by it; the machine's own `id` when absent); `hostBuild` and `needBuild` are what it runs and what MoMo needs, for "needs an update" */
/** @typedef {import('./momoMove.mjs').MoveResult} MoveResult */

/** The plain cost of picking a machine, as the card says it; null when there is none. @type {Record<MachineRecord['stays'], string | null>} */
const NOTE = { on: null, sleeps: 'Stops when the lid closes', cloud: 'Wakes when MoMo has work, stops when idle' };

/** One machine as the Where-MoMo-runs list shows it. @param {MachineRecord} m @param {string | null} homeId @param {string | null} recommended */
export function machineView(m, homeId, recommended) {
  const status = !m.setUp ? 'not-set-up' : !m.reachable ? 'offline' : !m.current ? 'needs-update' : 'online';
  return {
    machineId: m.id,
    name: m.name,
    isThisDevice: m.isThisDevice,
    isHome: (m.hostId ?? m.id) === homeId,
    status,
    note: NOTE[m.stays],
    recommended: m.id === recommended,
    agentsSignedIn: m.agents.filter((a) => a.signedIn).map((a) => a.name),
  };
}

/**
 * The machine to recommend at first run (decision D11): one that stays on, is up to date and reachable, with an agent signed in, and
 * not this device (a laptop is the fallback, never the pick). Null when none qualifies. @param {MachineRecord[]} machines
 */
export function recommendedMachine(machines) {
  return (
    machines.find((m) => m.stays === 'on' && m.setUp && m.reachable && m.current && !m.isThisDevice && m.agents.some((a) => a.signedIn))
      ?.id ?? null
  );
}

/**
 * What is wrong with the agent MoMo thinks with on the home, with the one fix for it, and nothing when it can think: none installed,
 * or none signed in. The fix ids are what a client sends back (`{ kind: 'fix', id }`, shared/momoHomeApi.mjs).
 * @param {MachineRecord | undefined} home
 */
export function agentProblem(home) {
  if (!home) return null;
  const installed = home.agents.filter((a) => a.installed);
  if (installed.length === 0) {
    const first = home.agents[0];
    return {
      kind: /** @type {const} */ ('not-installed'),
      agent: first?.name ?? '',
      fix: { id: `install-agent:${home.id}:${first?.id ?? first?.name ?? ''}`, label: `Install on ${home.name}` },
    };
  }
  if (installed.some((a) => a.signedIn)) return null;
  const first = installed[0];
  return {
    kind: /** @type {const} */ ('signed-out'),
    agent: first.name,
    fix: { id: `sign-in-agent:${home.id}:${first.id ?? first.name}`, label: `Sign in on ${home.name}` },
  };
}

/**
 * The fix of a machine that is out of date: one tap updates it, then the move or the home goes on. @param {MachineRecord} m
 */
export const updateFix = (m) => ({ id: `update-machine:${m.id}`, label: `Update ${m.name}` });

/**
 * A move as the sheet shows it: the step it is at, how it ended, the real cause when it did not finish, and whether the old machine still
 * holds a copy.
 * @param {{ moveId: string, from: { machineId: string, name: string }, to: { machineId: string, name: string }, step: string, result?: MoveResult | null, finishedAt?: number | null }} p
 */
export function moveView({ moveId, from, to, step, result = null, finishedAt = null }) {
  const failed = result && !result.ok ? result : null;
  const at = failed ? failed.step : step;
  const known = (/** @type {string} */ s) =>
    /** @type {(typeof MOVE_STEPS)[number]} */ (MOVE_STEPS.includes(/** @type {any} */ (s)) ? s : MOVE_STEPS[0]);
  return {
    moveId,
    from,
    to,
    step: known(at),
    outcome: /** @type {'running' | 'moved' | 'failed' | 'cancelled'} */ (
      !result ? 'running' : result.ok ? 'moved' : result.code === 'cancelled' ? 'cancelled' : 'failed'
    ),
    finishedAt: result ? finishedAt : null,
    failure: failed ? { cause: failed.message, failedAt: known(failed.step) } : null,
    oldMachineOffline: !!result && result.ok && result.oldHome === 'offline',
    // a move that failed with the old home still paused (its Cancel or the target's answer was lost, or the target is gone): the owner may run MoMo
    // here again; the words are the confirmation shown before the tap (intent `{ kind: 'reclaim' }`)
    reclaim: failed && failed.rolledBack === false ? reclaimWords(to.name, from.name) : null,
  };
}

/**
 * The home view. `status` is the Host's `host.momoStatus` answer (null when it could not be asked), `heardAt` when the client last heard
 * from that Host, `machines` the app's machine list, `move` a move in flight or just ended.
 * @param {object} o
 * @param {{ home: { homeId: string | null, leaseEpoch?: number, state: 'none' | 'running' | 'moving', stateSince: number, lastSeenAt: number, name: string, movedTo?: { name: string, homeId: string, at: number } | null } | null } | null} o.status
 * @param {number | null} o.heardAt @param {number} o.now @param {MachineRecord[]} o.machines
 * @param {ReturnType<typeof moveView> | null} [o.move] @param {any[]} [o.sources]
 * @param {{ accept: (stamp: unknown) => { ok: boolean } } | null} [o.sink] the receiver's stamp sink (shared/momoStamp.mjs): a Host that says it is the home at an older lease than the newest seen (a home that was moved away from and still answers) is not believed
 */
export function homeView({ status, heardAt, now, machines, move = null, sources = [], sink = null }) {
  const kept = status?.home ?? null;
  const homeId = kept?.homeId ?? null;
  const machine = machines.find((m) => (m.hostId ?? m.id) === homeId);
  const recommended = homeId ? null : recommendedMachine(machines);
  const problem = agentProblem(machine);
  const fenced = !!sink && !!kept?.homeId && !!kept.leaseEpoch && !sink.accept({ homeId: kept.homeId, leaseEpoch: kept.leaseEpoch }).ok;
  const state = kept
    ? homeStateOf({
        kept: kept.state,
        heardAt,
        now,
        reachable: !!machine?.reachable && status !== null && !fenced,
        current: machine?.current ?? true,
        signedIn: problem === null,
      })
    : null;
  return {
    // before the first-run choice there is no home: the clients show the choice instead of a state
    state: /** @type {'running' | 'moving' | 'asleep' | 'needs-update' | 'needs-sign-in' | null} */ (state),
    homeMachineId: homeId,
    leaseEpoch: kept?.leaseEpoch ?? null,
    machineName: kept?.name || machine?.name || null,
    stateSince: kept?.stateSince ?? null,
    lastSeenAt: kept?.lastSeenAt ?? null,
    movedAway: kept?.movedTo ? { machine: { machineId: kept.movedTo.homeId, name: kept.movedTo.name }, at: kept.movedTo.at } : null,
    move,
    update:
      state === 'needs-update' && machine?.hostBuild && machine.needBuild ? { have: machine.hostBuild, need: machine.needBuild } : null,
    agentProblem: problem,
    machines: machines.map((m) => machineView(m, homeId, recommended)),
    sources,
  };
}

/**
 * How far a message the person sent got (W1.7), from the device's outbox entry and what the home said of the turn: what the home kept
 * (accepted, completed, failed, cancelled, interrupted) is told as it is; a turn it never saw, after a send in doubt, never arrived; a home
 * that could not be asked with a send in doubt is "not sure". Nothing resends on its own.
 * @param {{ outbox: 'not-sent' | 'sent-uncertain', ledger: 'unknown' | 'accepted' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | null }} p
 * @returns {'queued' | 'accepted' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'never-got-it' | 'not-sure'}
 */
export function deliveryOf({ outbox, ledger }) {
  if (ledger && ledger !== 'unknown') return ledger;
  if (outbox === 'not-sent') return 'queued';
  return ledger === 'unknown' ? 'never-got-it' : 'not-sure';
}

/** Whether the person may be offered "Send now": a message that was never sent, or that the home says it never got. Never after a doubt. @param {ReturnType<typeof deliveryOf>} d */
export const canResend = (d) => d === 'queued' || d === 'never-got-it';

/**
 * What a device is told when it asks whether the home has a message (`check-turn`), from what `host.momoTurn` answered and whether the home
 * runs: `has` for any id it accepted or settled (a Reset keeps the ids it deleted as settled); `missing` when it has not accepted it, which
 * is safe to act on because the id is the turn: the device sends it again under the same id, the home accepts one copy and answers the other as
 * a duplicate, so an original still on its way cannot run as well; `unknown` when it cannot say (it could not be asked, or it is moving, away
 * or not the home).
 * @param {{ ledger: string | null, homeRunning: boolean }} p
 * @returns {'has' | 'missing' | 'unknown'}
 */
export function turnAnswer({ ledger, homeRunning }) {
  if (ledger === null || !homeRunning) return 'unknown';
  return ledger === 'unknown' ? 'missing' : 'has';
}
