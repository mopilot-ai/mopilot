export type Billing = 'subscription' | 'apiKey' | 'credits';
/** What the switching rules need to know about an instance. */
export interface LaneInstance {
  id: string;
  /** a provider id, or main's ProviderProfile (compared by its id) */
  provider: string | { id: string };
  billing: Billing;
  status: string;
  limited?: boolean;
}
export type Decision<T extends LaneInstance = LaneInstance> = { action: 'switch' | 'confirm' | 'offer'; to: T } | { action: 'none' };
export function sameLane(a: LaneInstance | null | undefined, b: LaneInstance | null | undefined): boolean;
export function onUnavailable<T extends LaneInstance>(o: {
  from: T | null | undefined;
  candidates: T[];
  autoSwitch?: boolean;
  ephemeral?: boolean;
}): Decision<T>;
export function mostLeft<T extends { id: string }>(rows: T[], active: string | undefined, left: (row: T) => number): T[];
export type LimitChoice = 'ask' | 'stop';
export function limitChoice(autoSwitch: boolean, ask: boolean | null | undefined): LimitChoice;
export function payPerUseText(providerLabel: string): string;
export function switchNoteText(o: {
  reason: 'limit' | 'expired' | 'unavailable';
  from?: string | null;
  to?: string | null;
  plan?: string | null;
  carried?: boolean;
}): string;
