// Types for shared/host/orgAccess.mjs, for the renderer's TypeScript.
export const ORG_FEATURE: 'orgCredentials';
export const LEASE_HOURS: Readonly<{ min: number; max: number; default: number }>;
export const RENEW_AT: number;
export const CLOCK_SKEW_MS: number;
export const ORG_HARNESSES: Readonly<Record<'claude' | 'codex' | 'acp', Readonly<{ gateways: readonly ('anthropic' | 'openai')[] }>>>;
export const CODEX_TOKEN_ENV: 'MOPILOT_ORG_TOKEN';
export const CODEX_PROVIDER: 'mopilot_org';
export function isLeaseToken(v: unknown): boolean;
export function isIdentity(v: unknown): boolean;
export function baseUrlOf(v: unknown): string | null;
export function leaseOf(
  p: unknown,
  now: number,
):
  | {
      harness: 'claude' | 'codex' | 'acp';
      identity: string;
      token: string;
      gateways: Partial<Record<'anthropic' | 'openai', string>>;
      expiresAt: number;
    }
  | { harness: 'claude' | 'codex' | 'acp'; identity: string; token: null };
export function leaseHoursOf(v: unknown): number;
