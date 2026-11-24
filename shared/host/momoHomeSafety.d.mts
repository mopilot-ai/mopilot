export type HomeRecord = {
  homeId: string | null;
  leaseEpoch: number;
  state: 'none' | 'running' | 'moving';
  name: string;
  movedTo: { name: string; homeId: string; at: number } | null;
};
export const EPOCH_MAX: number;
export const FLOOR_STEP: number;
export function leaseWins(a: { leaseEpoch: number; homeId: string | null }, b: { leaseEpoch: number; homeId: string | null }): boolean;
export function startEpoch(
  own: number,
  floor: unknown,
  known?: number,
): { ok: true; epoch: number } | { ok: false; code: 'floor_invalid' | 'floor_too_high' | 'epoch_limit' };
export type Look =
  | { holds: 'unreadable'; grantLive: boolean }
  | { holds: 'none'; leaseEpoch: number; grantLive: boolean }
  | { holds: 'moved'; leaseEpoch: number; movedTo: { name: string; homeId: string; at: number }; grantLive: boolean }
  | { holds: 'retired'; leaseEpoch: number; movedTo: { name: string; homeId: string; at: number }; lastActive: number; grantLive: boolean }
  | { holds: 'home'; homeId: string | null; leaseEpoch: number; name: string; state: 'running' | 'moving'; grantLive: boolean };
export function lookOf(r: HomeRecord | null, grantLive: boolean): Look;
export function standDownRule(
  r: HomeRecord,
  lease: { homeId: string; leaseEpoch: number; name?: string },
  at: number,
  known?: number,
):
  | { stoodDown: false; leaseEpoch: number }
  | { refused: 'epoch_unproven' }
  | { raise: number }
  | {
      retire: {
        state: 'none';
        homeId: null;
        name: '';
        account: null;
        moveId: null;
        bundleHash: null;
        moveDeadline: null;
        targetSignKey: null;
        leaseEpoch: number;
        movedTo: { name: string; homeId: string; at: number };
      };
    };
export function climbFloor(own: number, target: number): number;
export function adoptRule(
  r: HomeRecord,
  leaseEpoch: number,
  known: number,
): null | { code: 'retired_copy_here' | 'home_exists' | 'home_lease_stale'; message: string; details?: object };
export function startRule(
  r: HomeRecord,
  i: { hostId: string; name: string; floor?: unknown; known: number; revive?: boolean },
): { refuse: { code: string; message: string; details?: object } } | { asis: true } | { set: Record<string, unknown>; epoch: number };
export function resetRule(
  r: HomeRecord | null,
  pre: { ifRetired?: boolean; expectEpoch?: number } | undefined,
): null | { code: 'retired_changed'; message: string };
export function mayWipe(r: HomeRecord | null): boolean;
