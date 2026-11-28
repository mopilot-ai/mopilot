import type { Look } from './momoHomeSafety.d.mts';
export const FIRST_HOME_VERSION: string;
export const HOME_MIN_HOST_VERSION: string;
export const VERSION_FRESH_MS: number;
export const CLIMB_MAX: number;
export function releaseOf(v: unknown): number[] | null;
export function olderRelease(a: unknown, b: string): boolean;
export type Machine = {
  id: string;
  hasHost: boolean;
  reachable: boolean;
  lookFeature: boolean;
  version: string | null;
  versionFresh: boolean;
  look: undefined | null | Look;
};
export type Step =
  | { call: 'host.momoHomeStart'; host: string; params: { name: string; floor: number; climbTo: number; revive?: boolean } }
  | { call: 'host.momoStandDown'; host: string; params: { homeId: string; leaseEpoch: number | null; name?: string; own?: number } };
export type Answer = {
  kind: 'home' | 'none' | 'retired' | 'unheard' | 'pending';
  id: string;
  homeId?: string;
  leaseEpoch?: number;
  name?: string;
  state?: string;
  movedTo?: { name: string; homeId: string; at: number };
  lastActive?: number;
};
export function answerOf(m: Machine): Answer;
export function decide(
  machines: Machine[],
  memory: { seen: number; chosen?: string | null; freshConfirmed?: boolean },
): {
  homes: string[];
  winner: string | null;
  floor: number;
  steps: Step[];
  replaced: { host: string; name: string; moving: boolean }[];
  blocked: null | { kind: 'move-in-progress'; host: string; name: string };
  picker: 'choose' | 'confirm' | 'fresh' | null;
  older: { host: string; lastActive: number; movedTo: { name: string; homeId: string; at: number } }[];
  offerChoose: boolean;
  offerStartFresh: boolean;
  unheard: string[];
  moved: string[];
};
export function createSteps(d: ReturnType<typeof decide>, host: { id: string; name: string; own?: number }): Step[];
export function reviveSteps(
  d: ReturnType<typeof decide>,
  host: { id: string; name: string; own: number },
  live: { id: string; name: string }[],
): Step[];
export function execute(
  steps: Step[],
  call: (step: Step) => Promise<{ ok: true; leaseEpoch: number; homeId?: string } | { ok: false; code: string }>,
): Promise<{ ok: true; lease: number | null } | { ok: false; code: string; at: Step }>;
