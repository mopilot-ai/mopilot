// Types for the native permission projection shared by main and renderer surfaces.
export type EffectivePermission = 'plan' | 'read-only' | 'default' | 'auto-review' | 'full-access';
export interface PermissionSession {
  plan?: boolean;
  permission?: string | null;
  pendingSwitch?: unknown;
  acp?: { modes?: unknown; configOptions?: unknown; anchors?: Record<string, string> | null } | null;
}
export const PLAN_PERMISSION_HINT: string;
export function reportedPermission(session?: PermissionSession | null, basic?: boolean): EffectivePermission | null;
export function effectivePermission(
  config?: { permission?: string | null } | null,
  fallback?: string | null,
  session?: PermissionSession | null,
): EffectivePermission;
