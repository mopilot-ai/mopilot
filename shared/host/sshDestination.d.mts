// Types for sshDestination.mjs: a machine's ssh address as typed and as ssh takes it.
export function parseSshAddress(raw: unknown): { user: string; host: string; port: number; destination: string } | null;
export function sshTarget(destination: string): { target: string; args: string[] };
export function knownHostsName(destination: string): string;
export function normalAddress(raw: unknown): string;
