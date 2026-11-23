// Types for machineLine.mjs: a machine's status words shared by the Mac's rows and the phone.
export type LineAgent = { id: string; label: string; state?: 'ready' | 'signin' | 'missing' | null; reason?: string };
export type LineMachine = {
  status: 'online' | 'offline' | 'attention';
  note: string;
  agents: LineAgent[];
  installable: string[];
  lastSeen: number | null;
  localNetwork: string;
  waitingForLogin: 'restarted' | 'signed-out' | 'locked' | null;
  id?: string;
  platform?: string;
  startsAtBoot?: string;
  cloud?: 'deleted' | 'creating' | 'setting-up' | 'connecting' | 'waking' | 'asleep' | 'stopping' | null;
  canWake?: boolean;
  linkDroppedAt?: number | null;
  limit?: { usd: number } | null;
  paused?: boolean;
  waiting?: number;
  pushSkipped?: number;
};
export type LineContext = { now: number; client?: 'mac' | 'phone' };
export type Line = {
  dot: 'ok' | 'warn' | 'off';
  text: string;
  title?: string;
  /** a machine that does not answer: ask it again now */
  check?: { label: string };
  action?:
    | { kind: 'signin' | 'install'; agent: LineAgent; label: string }
    | { kind: 'cancel' | 'remove' | 'wake' | 'raise-limit'; label: string };
};
export type State = {
  id: string;
  match: (m: LineMachine, c: LineContext) => boolean;
  line: (m: LineMachine, c: LineContext) => Line;
};
export function machineReason(note: string, agents?: readonly { id: string; label: string }[]): string;
export const CORE_AGENTS: readonly string[];
export function shownAgents<T extends LineAgent>(agents: readonly T[]): T[];
/** `shownAgents` plus the wanted agent when the machine lacks it (reported missing, or not named at all). */
export function shownWithWanted<T extends LineAgent>(agents: readonly T[], wanted: { id: string; label: string } | null | undefined): T[];
export function signinAgents<T extends LineAgent>(agents: readonly T[]): T[];
export function needsSignin(agent: LineAgent): boolean;
export function missingAgents<T extends LineAgent>(agents: readonly T[]): T[];
export function installableAgents<T extends LineAgent>(m: { agents: readonly T[]; installable: readonly string[] }): T[];
export function installOffers<T extends LineAgent>(m: { agents: readonly T[]; installable: readonly string[] }): T[];
export function offlineCause(note: string, platform?: string): { cause: string; hint: string };
export function seenAgo(at: number, now: number): string;
export const LOCAL_NETWORK_HINT: string;
export const KEEP_RUNNING_HINT: string;
export const LINGER_HINT: string;
export const PUSH_OFF_HINT: string;
export const LEAD_STATES: readonly State[];
export const TAIL_STATES: readonly State[];
export const RECONNECT_MS: number;
export function usdText(usd: number): string;
export function machineLine(m: LineMachine, now: number, client?: 'mac' | 'phone'): { dot: 'ok' | 'warn' | 'off'; text: string };
