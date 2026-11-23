// Types for shared/permissionMenu.mjs: what the permissions menu says.
import type { PermissionMode } from './model/store';
import type { HarnessId } from './model/harness';

export const PERMISSION_ORDER: PermissionMode[];
export const PERMISSION_LABEL: Record<PermissionMode, string>;
export interface PermissionRow {
  id: PermissionMode;
  label: string;
  /** native name and the one-line difference */
  detail: string;
}
export function permissionMenu(h: HarnessId): { title: string; learnMore: string; rows: PermissionRow[] };
export function fullAccessBannerText(h: HarnessId): string;
export function permissionLearnMore(h: HarnessId): string;

/** Normalize the current native permission without guessing an unknown scope. */
export function appPermission(mode: unknown): PermissionMode | 'plan' | null;
