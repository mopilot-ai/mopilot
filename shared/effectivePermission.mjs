// Permission displays use the current native restriction before saved choices; pending destinations have no native mode yet.
import { appPermission } from './permissionMenu.mjs';
import { acpCurrentMode } from './acpMode.mjs';

export const PLAN_PERMISSION_HINT = 'Computer use can only look. Your permission choice applies after Plan mode ends.';
const TIER_PERMISSION = { readOnly: 'read-only', ask: 'default', auto: 'auto-review', full: 'full-access' };
const permissionOf = (value) => (value === 'readOnly' ? 'read-only' : typeof value === 'string' ? appPermission(value) : null);

/** The current session's reported restriction, or null before a native mode is known. */
export function reportedPermission(session, basic = false) {
  if (basic) {
    const mode = acpCurrentMode(session?.acp);
    if (mode == null) return null;
    const anchor = session.acp.anchors?.[mode];
    return typeof anchor === 'string' && Object.hasOwn(TIER_PERMISSION, anchor) ? TIER_PERMISSION[anchor] : 'default';
  }
  const value = session?.permission;
  return permissionOf(value) ?? (value == null ? null : 'default');
}

/** A destination picker falls back to its saved choice while a harness switch is pending. */
export function effectivePermission(config, fallback, session = null) {
  return (
    (session?.pendingSwitch ? null : reportedPermission(session)) ?? permissionOf(config?.permission) ?? permissionOf(fallback) ?? 'default'
  );
}
