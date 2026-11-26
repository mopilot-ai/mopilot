// The user's remote machines as main lists them (electron/host/machines.cjs): followed only while Host exists for the account, one read and one subscription shared by every window part that shows them.
import { useEffect, useSyncExternalStore } from 'react';
import { machineModels, type MachineModel } from '../../shared/host/models.mjs';
import { loginsOf, type HostLogin } from '../../shared/host/agentReadiness.mjs';
import { native } from './native';
import { ignoring } from './ignored';
import { createLatestLoader } from './latestLoader';
import { useHostAccess } from './host';
import { shareDeep } from './structuralShare';

/** One agent as a machine's row reports it; `state` is null when the row did not say. */
export type MachineAgent = {
  id: string;
  label: string;
  state: 'ready' | 'signin' | 'missing' | null;
  reason: string;
  /** ready only with the key or lease this Mac lends with each message, so it runs only while this Mac is online */
  lent?: boolean;
  unsure?: boolean;
  models?: MachineModel[];
  /** the machine's Host takes Plan for this agent (`chat.permit plan`); an older Host does not say it */
  planMode?: boolean;
  /** what a chat started now would use: the machine's own login, a key this Mac lends, or an organization's access */
  using?: 'own' | 'key' | 'org';
  /** the agent's logins on the machine (Claude Code today): the account, its standing and usage */
  logins?: HostLogin[];
  /** which login the agent runs on there, as its CLI records it (a name and a plan, never a token); an older Host does not say */
  loginAccount?: { name?: string; plan?: string };
};

/** `signin` is the agent on the machine that is installed but signed out (it can be signed in from here), else null. */
export type HostMachineRow = {
  id: string;
  name: string;
  /** the name itself, without the address a second machine of that name adds; Rename starts from it */
  rawName?: string;
  status: 'online' | 'offline' | 'attention';
  note: string;
  signin: string | null;
  capabilities: { iab: boolean; cu: boolean; desktop?: boolean };
  /** each agent's id and label, so a reason that names an agent can say it as the row does; with what it is ready for (`state`, null when the row did not say) and the line that says why not */
  agents: MachineAgent[];
  /** Fingerprint of the paired Host, for cached repository reads. */
  repositoryScope?: string;
  /** the missing agents the machine's Host can install itself (none for an older Host, or one offline) */
  installable: string[];
  /** when the machine last answered (ms), null when it never has */
  lastSeen: number | null;
  /** when the machine last answered, while an ask since then went unanswered and it is not yet called offline (under 90 s): the link is reconnecting */
  linkDroppedAt?: number;
  /** ssh answers and nobody waits to sign in, yet its Host does not: it is not running (the row offers Start Host) */
  hostStopped?: true;
  /** a machine paired by code whose Host removed this Mac: its relay pair is gone, and the row offers Remove (#5747) */
  peerRemoved?: true;
  /** whether the machine's Host may reach its local network (macOS Local Network privacy); 'unknown' while offline or from an older Host */
  localNetwork: 'allowed' | 'denied' | 'unknown';
  /** an offline machine nobody is signed in on: it restarted since it last answered, or was signed out; `locked`: FileVault holds its disk */
  waitingForLogin: 'restarted' | 'signed-out' | 'locked' | null;
  /** where this Mac reaches the machine ('' for this Mac and a machine added by command) and the app version that built its Host ('' when it names none) */
  address?: string;
  hostVersion?: string;
  /** whether the machine's Host starts at boot, before anyone signs in (Keep running after restart; Linux lingering) */
  startsAtBoot: 'yes' | 'no' | 'unknown';
  /** a Mac's FileVault, as its Host last said */
  fileVault: 'on' | 'off' | 'unknown';
  /** the system the machine's Host runs on ('' when it never said) */
  platform: 'darwin' | 'linux' | '';
  /** a cloud machine's provider record (host.cloud), absent on any other */
  cloud?: { provider: string; id: string; region: string; size: string; network: 'full' | 'limited' };
  /** waiting cards its Host last said found no phone linked to push to (it lost its relay link), present only when there are some */
  pushSkipped?: number;
  /** the machine's Host is older than the one this app carries */
  hostStale?: boolean;
  /** the machine's Host is newer than this app: Update would replace it with the app's older build */
  hostNewer?: boolean;
  /** its Host is of another build the same version as this app's, so which is older cannot be told (with `hostStale`) */
  hostDiffers?: boolean;
  /** updating its Host from the app: uploading, restarting once no turn runs, or failed (`updateError` says why) */
  update?: 'none' | 'running' | 'waiting' | 'failed';
  updateError?: string;
  /** Host authentication explicitly requires pairing, not a stale update key or transport failure. */
  updateNeedsPair?: true;
  /** how this Mac reaches it (the machine page's second line): the path in use and the relay's round trip */
  path?: { mode: 'auto' | 'ssh' | 'relay'; path: 'ssh' | 'relay' | null; latencyMs: number | null };
};
/** The provider's record of a cloud machine when main sent a whole one. */
const cloudPart = (v: unknown): Pick<HostMachineRow, 'cloud'> => {
  const c = v as Record<string, unknown> | null;
  if (!c || typeof c.provider !== 'string' || typeof c.id !== 'string') return {};
  const text = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    cloud: {
      provider: c.provider,
      id: c.id,
      region: text(c.region),
      size: text(c.size),
      network: c.network === 'limited' ? 'limited' : 'full',
    },
  };
};
const WAITS = new Set(['restarted', 'signed-out', 'locked']);
/** `v` when it is one of `allowed`, else `fallback`. */
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
export type HostMachineList = { machines: HostMachineRow[]; resolved: boolean; registryUnreadable?: boolean };

/** Before main has answered nothing is resolved; without Host access there is nothing to resolve. */
const PENDING: HostMachineList = { machines: [], resolved: false };
const NONE: HostMachineList = { machines: [], resolved: true };
const STATUSES = new Set(['online', 'offline', 'attention']);
const AGENT_STATES = new Set(['ready', 'signin', 'missing']);

let list = PENDING;
let refs = 0;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();

const publish = (next: HostMachineList) => {
  // a list equal to the held one (main sends it again whenever a machine or a key changes) wakes no reader, and a row that did not change keeps its object
  const shared = shareDeep(list, next);
  if (shared === list) return;
  list = shared;
  for (const l of listeners) l();
};

/** How the machine is reached, when main said: the path mode, the path in use and the relay's round trip. */
function readPath(v: unknown): { path?: NonNullable<HostMachineRow['path']> } {
  const p = v as { mode?: unknown; path?: unknown; latencyMs?: unknown } | null;
  if (!p || !['auto', 'ssh', 'relay'].includes(p.mode as string)) return {};
  return {
    path: {
      mode: p.mode as 'auto' | 'ssh' | 'relay',
      path: p.path === 'ssh' || p.path === 'relay' ? p.path : null,
      latencyMs: typeof p.latencyMs === 'number' && Number.isFinite(p.latencyMs) ? p.latencyMs : null,
    },
  };
}

/** What main sent as a list, or null when it is not one (a row without its fields is never drawn as a machine). */
export function parseMachineList(v: unknown): HostMachineList | null {
  const o = v as { machines?: unknown; resolved?: unknown; registryUnreadable?: unknown } | null;
  if (!o || !Array.isArray(o.machines)) return null;
  const rows: HostMachineRow[] = [];
  for (const r of o.machines) {
    const row = r as Partial<HostMachineRow> | null;
    if (!row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || typeof row.note !== 'string') return null;
    if (!STATUSES.has(row.status as string)) return null;
    const caps = (row as { capabilities?: Record<string, unknown> }).capabilities;
    const agents = (row as { agents?: unknown }).agents;
    const installable = (row as { installable?: unknown }).installable;
    rows.push({
      id: row.id,
      name: row.name,
      ...(typeof row.rawName === 'string' && row.rawName ? { rawName: row.rawName } : {}),
      status: row.status as HostMachineRow['status'],
      note: row.note,
      signin: typeof row.signin === 'string' && row.signin ? row.signin : null,
      capabilities: { iab: caps?.iab === true, cu: caps?.cu === true, desktop: caps?.desktop === true },
      ...(typeof row.repositoryScope === 'string' && row.repositoryScope ? { repositoryScope: row.repositoryScope } : {}),
      agents: Array.isArray(agents)
        ? agents.flatMap((a) =>
            typeof a?.id === 'string' && typeof a?.label === 'string'
              ? [
                  {
                    id: a.id,
                    label: a.label,
                    state: AGENT_STATES.has(a.state) ? a.state : null,
                    reason: typeof a.reason === 'string' ? a.reason : '',
                    ...(a.lent === true ? { lent: true } : {}),
                    ...(a.unsure === true ? { unsure: true } : {}),
                    ...(Array.isArray(a.models) ? { models: machineModels(a.models) } : {}),
                    ...(a.planMode === true ? { planMode: true } : {}),
                    ...(a.using === 'own' || a.using === 'key' || a.using === 'org' ? { using: a.using } : {}),
                    ...(Array.isArray(a.logins) ? { logins: loginsOf(a.logins) } : {}),
                    ...loginAccountOf(a.loginAccount),
                  },
                ]
              : [],
          )
        : [],
      installable: Array.isArray(installable) ? installable.filter((h): h is string => typeof h === 'string' && !!h) : [],
      lastSeen: Number.isFinite(row.lastSeen) ? (row.lastSeen as number) : null,
      ...(Number.isFinite(row.linkDroppedAt) && { linkDroppedAt: row.linkDroppedAt as number }),
      ...(row.hostStopped === true && { hostStopped: true }),
      ...(row.peerRemoved === true && { peerRemoved: true }),
      localNetwork: row.localNetwork === 'allowed' || row.localNetwork === 'denied' ? row.localNetwork : 'unknown',
      waitingForLogin: WAITS.has(row.waitingForLogin as string) ? (row.waitingForLogin as HostMachineRow['waitingForLogin']) : null,
      address: typeof row.address === 'string' ? row.address : '',
      hostVersion: typeof row.hostVersion === 'string' ? row.hostVersion : '',
      startsAtBoot: oneOf(row.startsAtBoot, ['yes', 'no'], 'unknown'),
      fileVault: oneOf(row.fileVault, ['on', 'off'], 'unknown'),
      platform: oneOf(row.platform, ['darwin', 'linux'], ''),
      ...readPath(row.path),
      ...cloudPart(row.cloud),
      // only an old Host or an update under way adds fields
      ...(Number.isInteger(row.pushSkipped) && (row.pushSkipped as number) > 0 && { pushSkipped: row.pushSkipped as number }),
      ...(row.hostStale === true && { hostStale: true }),
      ...(row.hostNewer === true && { hostNewer: true }),
      ...(row.hostDiffers === true && { hostDiffers: true }),
      ...(['running', 'waiting', 'failed'].includes(row.update as string) && {
        update: row.update as HostMachineRow['update'],
        updateError: typeof row.updateError === 'string' ? row.updateError : '',
        ...(row.updateNeedsPair === true ? { updateNeedsPair: true as const } : {}),
      }),
    });
  }
  return { machines: rows, resolved: o.resolved === true, ...(o.registryUnreadable === true && { registryUnreadable: true }) };
}

/** The login line an agent's row carries: its name and plan when they are text, else nothing. */
function loginAccountOf(v: unknown): { loginAccount?: { name?: string; plan?: string } } {
  const a = (v ?? {}) as { name?: unknown; plan?: unknown };
  const name = typeof a.name === 'string' && a.name ? a.name : undefined;
  const plan = typeof a.plan === 'string' && a.plan ? a.plan : undefined;
  return name || plan ? { loginAccount: { ...(name ? { name } : {}), ...(plan ? { plan } : {}) } } : {};
}

function follow() {
  // access is on only when main's bridge answered, so the Host bridge is there
  const h = native.host;
  const loader = createLatestLoader(
    async () => parseMachineList(await h.machines()),
    (next) => next && publish(next),
    ignoring('read the remote machines'),
  );
  const off = h.onMachines((next) => {
    const parsed = parseMachineList(next);
    if (parsed) loader.push(parsed);
  });
  void loader.load();
  stop = () => {
    loader.stop();
    off();
    publish(PENDING);
  };
}

function acquire() {
  if (refs++ === 0) follow();
  return () => {
    if (--refs === 0) {
      stop?.();
      stop = null;
    }
  };
}

/** The remote machines and whether every one has answered once; empty while Host is not available. The first call to need them starts following main. */
export function useHostMachines(): HostMachineList {
  const allowed = useHostAccess();
  useEffect(() => (allowed ? acquire() : undefined), [allowed]);
  const current = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => list,
  );
  return allowed ? current : NONE;
}

/**
 * What the machine's agents are ready for, read when a chat is about to start there: the followed list when every
 * machine has answered, else a read of main's list. Empty when the machine is not listed, Host is not available or the read failed (noted in the log).
 */
export async function readMachineAgents(hostId: string): Promise<MachineAgent[]> {
  return (await readMachineRow(hostId, "read the machine's agents"))?.agents ?? [];
}

/** The machine's row as main lists it now (the followed list when every machine has answered, else a read); undefined when it is not listed, Host is not available or the read failed (noted in the log as `what`). */
export async function readMachineRow(hostId: string, what = "read the machine's row"): Promise<HostMachineRow | undefined> {
  try {
    const known = list.resolved ? list : parseMachineList(await native.host?.machines());
    return known?.machines.find((m) => m.id === hostId);
  } catch (e) {
    // the machine's own refusal at the send still says what it cannot run
    ignoring(what)(e);
    return undefined;
  }
}
