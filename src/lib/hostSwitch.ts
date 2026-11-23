// What the Switch host dialog decides without drawing: which machines can take the chat and why a row is off, why the menu row is off, the copy for each refusal, and the last folder used per project and machine.
import { noteIgnored } from './ignored';
import { machineReason, type NoteAgent } from './hostNote';
import { CONTINUE_REFUSAL_COPY } from '../../shared/host/continue.mjs';
import { agentLabel } from '../../shared/host/agentReadiness.mjs';
import { refusalWords } from '../../shared/host/refusalWords.mjs';

/** A machine as the dialog needs it (the chip's HostMachine fits). */
export type SwitchMachine = {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'attention';
  note: string;
  /** each agent with what it is ready for and the line that says why not, as the machine's row reports them */
  agents?: (NoteAgent & { state?: 'ready' | 'signin' | 'missing' | null; reason?: string })[];
  /** the agents its Host installs itself (the row's Install offers) */
  installable?: string[];
};
/** A row of the target list: `reason` is why it cannot be picked, null when it can. */
export type SwitchTarget = SwitchMachine & { reason: string | null };

/** Why a machine cannot take the chat's agent, from what its row says of that agent; null when it is ready, or the row does not list it (the Host decides at the press). */
function agentReason(m: SwitchMachine, agent: string | undefined): string | null {
  const a = agent ? m.agents?.find((x) => x.id === agent) : undefined;
  if (a?.state === 'missing') return refusalCopy('agent_missing', m.name, '', agent);
  if (a?.state !== 'signin') return null;
  // the row's own line names the logins it lists ("Sign in on box: login"); the agent is named in front of it
  return a.reason?.startsWith('Sign in on ')
    ? a.reason.replace('Sign in on ', `Sign in to ${a.label} on `)
    : a.reason || refusalCopy('agent_signed_out', m.name, '', agent);
}

/**
 * Every machine but the chat's owner; the owner stays listed once it is lost, because the chat may be taken back to it. A machine whose row says the chat's agent (`agent`, its id) is not installed or signed out shows that on its row, before anything is pressed.
 */
export function targetsFor(machines: SwitchMachine[], ownerId: string, ownerLost: boolean, agent?: string): SwitchTarget[] {
  return machines
    .filter((m) => m.id !== ownerId || ownerLost)
    .map((m) => ({
      ...m,
      reason:
        m.status === 'offline'
          ? 'Offline'
          : (agentReason(m, agent) ?? (m.status === 'online' ? null : machineReason(m.note, m.agents) || 'Needs attention')),
    }));
}

/** What the dialog offers in place of a refusal: install the chat's agent on the machine, or sign it in there. */
export type SwitchFix = { kind: 'install' | 'signin'; machine: SwitchMachine; agent: string; label: string };

/**
 * The one-click fix for a machine that cannot take the chat's agent (`agent`, its id): install when its row says the agent is missing and its Host installs it, sign in when it is installed and signed out. `code` is a refusal the press just got (agent_missing, agent_signed_out, agent_login_refused), for a row the app still read as ready. An offline machine, an agent it cannot install and a machine with nothing wrong have none.
 */
export function fixFor(m: SwitchMachine, agent: string | undefined, code?: string): SwitchFix | null {
  if (!agent || m.status === 'offline') return null;
  const row = m.agents?.find((x) => x.id === agent);
  const label = row?.label ?? agentLabel(agent);
  const state = row?.state === 'missing' || row?.state === 'signin' ? row.state : null;
  const kind =
    state === 'missing' || (!state && code === 'agent_missing')
      ? 'install'
      : state === 'signin' || (!state && (code === 'agent_signed_out' || code === 'agent_login_refused'))
        ? 'signin'
        : null;
  if (!kind || (kind === 'install' && !m.installable?.includes(agent))) return null;
  return { kind, machine: m, agent, label };
}

/** What a chat with a message on its way (or waiting behind a turn) says in place of a turn to stop. */
export const WAIT_FOR_MESSAGE = 'Wait for your message to send';

/** Why the chip's Switch host… row is off, or null when it opens the dialog. */
export function switchHostReason(o: {
  turnRunning: boolean;
  queued?: boolean;
  hasChat: boolean;
  ownerKnown: boolean;
  targets: number;
}): string | null {
  if (o.turnRunning) return 'Stop the chat first';
  // a message the machine has taken whose turn this app has not shown yet (its agent is still starting) holds the chat there as a turn does (#4951)
  if (o.queued) return WAIT_FOR_MESSAGE;
  if (!o.hasChat) return 'Send a message first';
  if (!o.ownerKnown) return 'Checking the host…';
  return o.targets > 0 ? null : 'Add a machine first';
}

const AGAIN = 'Try again, or continue without the changes.';
/** The copy of each refusal; `host` is the machine it concerns. */
const COPY: Record<string, (host: string) => string> = {
  continue_in_flight: () => 'This chat is already being switched.',
  turn_running: () => 'The chat is busy. Wait for it to finish, or stop it, then try again.',
  host_unreachable: (h) => `${h} isn't reachable. Check it's online, then try again.`,
  target_offline: (h) => `${h} isn't reachable. Check it's online, then try again.`,
  commit_unsettled: (h) => `${h} didn't confirm the switch. The chat stays where it was; try again.`,
  prepare_unsettled: (h) => `The switch didn't start on ${h}. Try again.`,
  not_prepared: (h) => `The switch didn't start on ${h}. Try again.`,
  source_may_run: (h) => `${h} still exists at the provider. Wake it, or delete it first.`,
  source_unknown: (h) => `Can't tell whether ${h} still exists. Check the provider key and try again.`,
  same_host: () => 'This chat already runs there.',
  continue_cancelled: () => 'The switch was cancelled.',
  chat_released: () => 'This chat moved to another host meanwhile.',
  owner_changed: () => 'This chat moved to another host meanwhile.',
  target_dirty: (h) => `The folder on ${h} has changes of its own. Clean it up, or continue without the changes.`,
  carry_other_branch: (h) => `The folder on ${h} is on another branch. Switch it first, or continue without the changes.`,
  carry_diverged: (h) => `The folder on ${h} has other commits. Update it, or continue without the changes.`,
  carry_conflict: (h) => `The changes don't apply to the folder on ${h}. ${AGAIN}`,
  carry_no_repository: (h) => `The folder on ${h} isn't a repository. Pick the repository's folder, or continue without the changes.`,
  carry_mismatch: (h) => `The changes that reached ${h} aren't the ones sent. ${AGAIN}`,
  carry_push_failed: () => `The changes couldn't be sent. ${AGAIN}`,
  carry_fetch_failed: (h) => `${h} couldn't fetch the changes. ${AGAIN}`,
  carry_unconfirmed: () => 'Confirm the new files first, or continue without the changes.',
  nothing_to_carry: () => "The changes couldn't be gathered. Check that the folder has a commit and a remote.",
  no_remote: () => "This repository has no remote, so its code can't be cloned.",
  unknown_source: () => "This chat's folder isn't a repository.",
};

/** The refusals by fact (shared with the Host: not installed, signed out, a Host too old for the chat's family) and the one the Mac names: a login the agent itself refused. */
const FACTS: Record<string, string> = {
  ...CONTINUE_REFUSAL_COPY,
  agent_login_refused: "{agent}'s login on {machine} is refused. Sign in again.",
};

/** What a refusal tells the user; `host` is the machine it concerns and `agent` the chat's agent (its id). A code with no copy of its own says `fallback`, the failure as one readable sentence. */
/** What the dialog says when nothing more specific is known. */
const SWITCH_FAILED = "Couldn't switch host.";
export function refusalCopy(code: string | undefined, host: string, fallback = SWITCH_FAILED, agent?: string): string {
  if (code && Object.hasOwn(FACTS, code))
    return FACTS[code].replace('{agent}', agent ? agentLabel(agent) : 'The agent').replace('{machine}', host);
  if (code && Object.hasOwn(COPY, code)) return COPY[code](host);
  // any other Host refusal says its cause in the one table every machine chat reads (shared/host/refusalWords.mjs)
  const said = fallback === SWITCH_FAILED ? undefined : fallback;
  return refusalWords(code, { machine: host, agent, context: 'continue', message: said })?.line ?? fallback;
}

/** The refusals about the chat's current host, not the one it is moving to: a cloud machine that may still run. */
const SOURCE_CODES = new Set(['source_may_run', 'source_unknown']);

/** The machine a refusal concerns: the chat's owner for the source's own refusals, else the target. */
export const refusalMachine = (code: string | undefined, target: string, owner: string): string =>
  code && SOURCE_CODES.has(code) ? owner : target;

/** Where a project's last folder on a machine is remembered in this window's storage. */
const dirKey = (project: string, hostId: string) => `hostDir:${JSON.stringify([hostId, project])}`;

/** The folder last used for `project` on `hostId`, or '' (a storage that cannot be read has none). */
export function lastDirectory(project: string, hostId: string): string {
  try {
    return localStorage.getItem(dirKey(project, hostId)) ?? '';
  } catch {
    return '';
  }
}

/** Remembers the folder a continue just used; a storage that refuses is not an error. */
export function rememberDirectory(project: string, hostId: string, dir: string): void {
  try {
    localStorage.setItem(dirKey(project, hostId), dir);
  } catch (e) {
    // remembering the folder is a convenience
    noteIgnored('remember the folder used on a host', e);
  }
}
