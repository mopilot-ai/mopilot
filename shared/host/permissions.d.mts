// Machine-owned permission choices, distinct from this Mac's new-chat preferences.
import type { PermissionMode } from '../model/store';
export type HostPermissionPick = { hostId: string; harness: string; value: PermissionMode };
export const HOST_PERMISSIONS: PermissionMode[];
export const HOST_PLAN: 'plan';
export function isHostMode(value: unknown): value is PermissionMode | 'plan';
export function isHostPermission(value: unknown): value is PermissionMode;
export function hostPermissionOf(pick: unknown, hostId: string, harness: string): PermissionMode | null;
export function hostPermissionFamily(harness: string): 'claude' | 'codex' | null;
export type StartPolicy = 'inherit' | 'capped' | 'remember';
export const START_POLICY: StartPolicy;
export function startingHostMode(o: {
  pick?: unknown;
  hostId: string;
  harness: string;
  macDefault?: unknown;
  lastChosen?: unknown;
  policy?: StartPolicy;
}): PermissionMode;
