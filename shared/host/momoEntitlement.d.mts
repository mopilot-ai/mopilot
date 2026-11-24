export const ENTITLEMENT_TTL_MS: number;
export const ENTITLEMENT_MAX_VALIDITY_MS: number;
export const ENTITLEMENT_GRACE_MS: number;
export const ENTITLEMENT_REQUIRED_GRACE_MS: number;
export const ENTITLEMENT_SKEW_MS: number;
export const ENTITLEMENT_REFRESH_BELOW_MS: number;
export const ENTITLEMENT_MAX_BYTES: number;
export const ENTITLEMENT_FAILURES: Record<string, string>;
export type Entitlement = { kid: string; sub: string; features: string[]; aud: string; iat: number; exp: number };
export type TrustedKey = { id: string; pem: string };
export function signEntitlement(claims: Entitlement, privateKey: import('node:crypto').KeyObject | string): string;
export function verifyEntitlement(
  token: unknown,
  o: { keys: TrustedKey[]; revoked?: string[] },
): { ok: true; claims: Entitlement } | { ok: false; code: 'entitlement_invalid' | 'entitlement_unknown_key' };
export function entitlementKeyId(publicKeyPem: string): string;
