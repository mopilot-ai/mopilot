// Types of the relay's refusals as the Mac and the phone read them (relayRefusal.mjs).
export type RelayRefusal = 'capacity' | 'account_limit' | 'disabled';
export function refusalOf(code: unknown): RelayRefusal | null;
export const RELAY_DISABLED_ERROR: 'relay_disabled';
export const REFUSAL_TEXT: Readonly<Record<RelayRefusal, string>>;
export const REFUSAL_BASE_MS: number;
export const REFUSAL_CAP_MS: number;
export function refusalWait(refusals: number, random: number): number;
export class RelayRefused extends Error {
  refusal: RelayRefusal;
  constructor(refusal: RelayRefusal);
}
