// Types for the machine-owned readiness and native model catalog projection.
/** A login an agent has on the machine, as the Host reports it (shared/host/logins.mjs): the account's email, its standing, how it is billed, and the usage windows. */
export type HostLogin = {
  id: string;
  label: string;
  state: 'ok' | 'signedOut' | 'expired';
  limited: boolean;
  limitedUntil?: number;
  billing: 'subscription' | 'apiKey';
  active: boolean;
  usage?: { label: string; usedPercent: number; resetsAt: number | null }[];
};
export type HostAgent = {
  id: string;
  label: string;
  state: 'ready' | 'signin' | 'missing';
  reason: string;
  lent?: true;
  unsure?: true;
  using?: 'own' | 'key' | 'org';
  sources?: { own: boolean; key: boolean; org: boolean };
  loginsSupported?: boolean;
  planMode?: boolean;
  loginAccount?: { name?: string; plan?: string };
  models?: import('./models.mjs').MachineModel[];
  logins?: HostLogin[];
};
export function agentLabel(id: string): string;
export function agentsOf(
  harnesses: {
    id: string;
    detected: boolean;
    signedIn: boolean;
    reason?: string;
    signIn?: string[];
    checking?: boolean;
    unsure?: boolean;
    keyed?: boolean;
    models?: unknown;
    logins?: unknown;
    using?: 'own' | 'key' | 'org';
    sources?: { own: boolean; key: boolean; org: boolean };
    loginsSupported?: boolean;
    planMode?: true;
    loginAccount?: { name?: string; plan?: string };
  }[],
  machine: string,
): HostAgent[];
export function installedIds(harnesses: { id: string; detected: boolean }[]): string;
export function loginsOf(raw: unknown): HostLogin[] | undefined;

/** The line under an agent that is not installed: where to install it (`settings` names this Mac's path page, `machine` the machine). */
export function missingHint(label: string, where: { machine?: string; settings?: string }): string;
