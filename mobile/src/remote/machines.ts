// The machines the Mac runs chats on (this Mac and its Hosts), as the Mac's machine page words them: machines.list, kept current by machines.changed.
import type { MobileRuntime } from '../contracts';
import { reachOf, type Reach } from './reach';
import { sourceWords } from './credentialLine';
import { machineModels, type MachineModel } from '../../../shared/host/models.mjs';

export type MachineTone = 'ok' | 'warn' | 'off';
export type AgentState = 'ready' | 'signin' | 'missing';
export type CredentialSource = 'own' | 'key' | 'org';
export type MachineAgent = {
  id: string;
  label: string;
  state: AgentState;
  via: 'own' | 'key' | 'org' | null;
  /** What a chat started now would use, and what else exists on the machine; absent from a Host that does not report them. */
  using?: CredentialSource;
  sources?: Record<CredentialSource, boolean>;
  /** false: this agent has one sign-in on the machine, so there are no logins to pick (an ACP agent) */
  loginsSupported?: boolean;
  /** The Host's own words for why the agent is not ready ("Sign in on <machine>: <logins>"); absent from a Mac that does not send them. */
  reason?: string;
  /** The agent's models as the Host reports them (resolved names, default effort, fast flag); absent from a Mac that does not send them. */
  models?: MachineModel[];
};
export type Machine = {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'needs-setup';
  /** The Mac's own words for the machine's state (src/lib/machineStatus.ts): shown as given, never re-derived here. */
  line: string;
  tone: MachineTone;
  keepRunning: boolean | null;
  agents: MachineAgent[];
  /** How the phone's Mac reaches the machine; null or absent when the Mac did not say (an older Mac) */
  path?: 'direct' | 'relay' | null;
  /** When the machine last answered, in ms; null when never or unknown */
  lastSeen?: number | null;
  /** An offline machine nobody is signed in on: the person must sign in on the Mac, the phone never does */
  waitingForLogin?: 'restarted' | 'signed-out' | null;
  /** How this phone reaches it (X3); unset until the phone's own paths are known. */
  reach?: Reach;
  /** The phone holds an enrollment with the Host, but its own session to the Host does not open: the Host lost its side of the link (#4721), whatever the Mac lists. */
  directDown?: boolean;
  /** Cards waiting on it, over the phone's own path. */
  waiting?: number;
  /** A cloud machine's own state, as the provider and the Mac report it; absent for a machine that is not a cloud Host. */
  cloud?: 'deleted' | 'creating' | 'setting-up' | 'connecting' | 'waking' | 'asleep' | 'stopping' | null;
};

const CLOUD = ['deleted', 'creating', 'setting-up', 'connecting', 'waking', 'asleep', 'stopping'] as const;
const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

const sourceOf = (v: unknown): CredentialSource | null => (v === 'own' || v === 'key' || v === 'org' ? v : null);

function agent(raw: unknown): MachineAgent | null {
  const a = rec(raw);
  const id = str(a?.id);
  if (!a || !id) return null;
  return {
    id,
    label: str(a.label) ?? id,
    state: oneOf(a.state, ['ready', 'signin', 'missing'] as const, 'missing'),
    via: a.via === 'own' || a.via === 'key' || a.via === 'org' ? a.via : null,
    ...(sourceOf(a.using) && { using: sourceOf(a.using) as CredentialSource }),
    ...(rec(a.sources) && {
      sources: { own: rec(a.sources)?.own === true, key: rec(a.sources)?.key === true, org: rec(a.sources)?.org === true },
    }),
    ...(typeof a.loginsSupported === 'boolean' && { loginsSupported: a.loginsSupported }),
    ...(str(a.reason) && { reason: str(a.reason)!.trim() }),
    ...(Array.isArray(a.models) && a.models.length && { models: machineModels(a.models) }),
  };
}

/** The Mac's list, read defensively: a row without an id or a line is dropped; unknown words fall back to the quiet ones. */
export function parseMachines(raw: unknown): Machine[] {
  const list = rec(raw)?.machines;
  if (!Array.isArray(list)) return [];
  const out: Machine[] = [];
  for (const item of list) {
    const m = rec(item);
    const id = str(m?.id);
    const line = str(m?.line);
    if (!m || !id || !line) continue;
    out.push({
      id,
      name: str(m.name) ?? (id === 'local' ? 'This Mac' : id),
      status: oneOf(m.status, ['online', 'offline', 'needs-setup'] as const, 'offline'),
      line,
      tone: oneOf(m.tone, ['ok', 'warn', 'off'] as const, 'off'),
      keepRunning: typeof m.keepRunning === 'boolean' ? m.keepRunning : null,
      path: m.path === 'direct' || m.path === 'relay' ? m.path : null,
      lastSeen: typeof m.lastSeen === 'number' && Number.isFinite(m.lastSeen) ? m.lastSeen : null,
      ...(CLOUD.includes(m.cloud as never) ? { cloud: m.cloud as (typeof CLOUD)[number] } : {}),
      waitingForLogin: m.waitingForLogin === 'restarted' || m.waitingForLogin === 'signed-out' ? m.waitingForLogin : null,
      agents: (Array.isArray(m.agents) ? m.agents : []).map(agent).filter((a): a is MachineAgent => a !== null),
    });
  }
  return out;
}

/** The Mac's words for a machine it cannot say more about; the reason is then read from what the phone knows (below). */
export const GENERIC_ATTENTION = 'Needs attention';

/**
 * Why a machine "Needs attention", when the Mac's line says only that: no agent on it is ready to take a chat. Null when the line already says
 * more, or an agent is ready and the reason is not one the phone can read.
 */
export function attentionReason(m: Pick<Machine, 'line' | 'tone' | 'agents'>): string | null {
  if (m.line !== GENERIC_ATTENTION || m.tone !== 'warn') return null;
  return m.agents.some((a) => a.state === 'ready') ? null : 'No agent is ready';
}

/** What an agent row says under its name; the phone never signs in, so a missing sign-in points at the Mac. */
export function agentLine(a: MachineAgent, machine = 'this machine'): string {
  // the Host's words name the machine and the logins it lists; without them the phone points at the Mac
  if (a.state === 'signin') return a.reason?.trim() || 'Sign in on your Mac';
  if (a.state === 'missing') return 'Not installed';
  // a Host that says what a chat will use is believed over the guess below (`via` calls a signed-in machine its own even when a lent key outranks it)
  if (a.using) return sourceWords(a.using, machine);
  if (a.via === 'key') return "Uses your Mac's key · new turns need your Mac online";
  if (a.via === 'org') return 'Organization sign-in';
  return 'Ready';
}

/** Where a chat on a Host runs while the Mac is away: the Host keeps it going, the phone sees it again when the Mac is back. */
export function hostOfflineLine(machines: Machine[] | null, hostId: string | null | undefined): string | null {
  if (!hostId) return null;
  const name = machines?.find((m) => m.id === hostId)?.name ?? 'another machine';
  return `Running on ${name} · Your Mac is offline`;
}

/** What a Home row says when a card its machine's Host holds is why the chat waits. */
export const hostCardLine = (machines: Machine[] | null, hostId: string | undefined) =>
  `Needs you on ${machines?.find((m) => m.id === hostId)?.name ?? 'another machine'}`;

/** What a screen shows: the list while the Mac has at least one Host; a list of only this Mac (no Hosts, or Host access just closed) is null. */
export const visibleMachines = (list: Machine[]) => (list.some((m) => m.id !== 'local') ? list : null);

/**
 * Follows the Mac's machines while connected. `onChange` gets null when there is nothing to show: a Mac that does not
 * advertise `capabilities.machines` in machine.hello (no Host access, or an older Mac), a list of only this Mac, or a read
 * that failed. A machines.changed event is newer than any read still in flight. Returns the stop function.
 */
export function followMachines(runtime: MobileRuntime, onChange: (machines: Machine[] | null) => void): () => void {
  let live = true;
  let seq = 0;
  const off = runtime.onEvent((message) => {
    if (message.ev !== 'machines.changed') return;
    seq++;
    onChange(visibleMachines(parseMachines(message)));
  });
  const mine = ++seq;
  const current = () => live && mine === seq;
  void (async () => {
    try {
      const hello = rec(await runtime.request('machine.hello', {}));
      // the Mac's `host.phoneChat` flag, kept for the time it is away, per Mac (a stopped follow tells nothing)
      if (current()) runtime.direct?.chat?.told(rec(hello?.capabilities)?.phoneChat === true, runtime.snapshot().selectedPair ?? '');
      if (rec(hello?.capabilities)?.machines !== true) return current() && onChange(null);
      const raw = await runtime.request('machines.list', {});
      if (current()) onChange(visibleMachines(parseMachines(raw)));
    } catch {
      if (current()) onChange(null);
    }
  })();
  return () => {
    live = false;
    off();
  };
}

/** What the phone knows of its own paths: the machines it is enrolled with, how many cards wait on each, and whether each answered. */
export type DirectFacts = {
  records: { machineId: string; name: string }[];
  waiting: (machineId: string) => number;
  reachable: (machineId: string) => boolean | null;
  /** The agents the machine's own Host last reported (used for a machine the Mac does not list: the Mac's row is the one that knows what it lends); null before it has. */
  agents: (machineId: string) => MachineAgent[] | null;
};

/**
 * The Mac's list with the phone's own paths joined to it: each machine's reach, a machine the phone is enrolled with when the Mac is
 * away or does not list it, and "N waiting" on a machine that is fine otherwise. Null when there is nothing to show.
 */
export function withDirect(list: Machine[] | null, direct: DirectFacts): Machine[] | null {
  const macUp = list !== null;
  const enrolled = new Map(direct.records.map((r) => [r.machineId, r]));
  const shown = (list ?? []).map((m) => {
    if (m.id === 'local') return m;
    const waiting = enrolled.has(m.id) ? direct.waiting(m.id) : 0;
    const reach = reachOf({ enrolled: enrolled.has(m.id), listedByMac: true, macOnline: macUp });
    return {
      ...m,
      reach,
      // the stored record says Direct; the phone's own read of the Host says whether it is true
      ...(enrolled.has(m.id) && direct.reachable(m.id) === false ? { directDown: true } : {}),
      waiting,
      ...(waiting > 0 && m.tone === 'ok' ? { line: `${waiting} waiting`, tone: 'warn' as const } : {}),
    };
  });
  for (const [id, record] of enrolled) {
    if (shown.some((m) => m.id === id)) continue;
    const waiting = direct.waiting(id);
    const up = direct.reachable(id) === true;
    shown.push({
      id,
      name: record.name,
      status: up ? 'online' : 'offline',
      line: waiting > 0 ? `${waiting} waiting` : up ? 'Online' : 'Offline',
      tone: waiting > 0 ? 'warn' : up ? 'ok' : 'off',
      keepRunning: null,
      // known only to the Mac, which does not list this machine
      path: null,
      lastSeen: null,
      waitingForLogin: null,
      agents: direct.agents(id) ?? [],
      reach: 'direct',
      ...(direct.reachable(id) === false ? { directDown: true } : {}),
      waiting,
    });
  }
  return visibleMachines(shown);
}
