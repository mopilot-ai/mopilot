// Permission anchors accepted by Host first-tier adapters and choices scoped to one machine and harness.
import { hostFamilyOfHarness, isHostFamily } from './chatIds.mjs';
/** @param {string} harness @returns {'claude' | 'codex' | null} */
export const hostPermissionFamily = (harness) =>
  hostFamilyOfHarness(harness) ?? (isHostFamily(harness) ? /** @type {'claude' | 'codex'} */ (harness) : null);
export const HOST_PERMISSIONS = ['default', 'read-only', 'auto-review', 'full-access'];
/** The mode a chat is in while its agent only plans: not a pick of the permission menu, but what a message with Plan on asks a Host that takes it (`planMode` on the agent's row) to hold. */
export const HOST_PLAN = 'plan';
/** Whether a message may carry this mode to a Host: a permission anchor, or Plan. @param {unknown} value */
export const isHostMode = (value) => value === HOST_PLAN || (typeof value === 'string' && HOST_PERMISSIONS.includes(value));
/** @param {unknown} value @returns {value is import('../model/store').PermissionMode} */
export const isHostPermission = (value) => typeof value === 'string' && HOST_PERMISSIONS.includes(value);
/** @param {unknown} pick @param {string} hostId @param {string} harness */
export function hostPermissionOf(pick, hostId, harness) {
  const p = /** @type {any} */ (pick);
  return p?.hostId === hostId && p.harness === harness && isHostPermission(p.value) ? p.value : null;
}
/**
 * How a machine chat with no pick of its own starts, until the owner decides (#5403): `inherit` takes this Mac's default as it is, `capped` takes it but never Full access (Approve for me at most), `remember` takes the last mode chosen on that machine for that agent.
 * @typedef {'inherit' | 'capped' | 'remember'} StartPolicy
 */
/** @type {StartPolicy} */
export const START_POLICY = 'inherit';
/**
 * The mode a chat on a machine starts in for one agent: the pick kept for that machine and agent, else what the policy says from this Mac's default or the last mode chosen there, else the plain "Ask for approval". One function for every start path, so no path has a default of its own.
 * @param {{ pick?: unknown, hostId: string, harness: string, macDefault?: unknown, lastChosen?: unknown, policy?: StartPolicy }} o `macDefault`: this Mac's `prefs.permission`; `lastChosen`: the last mode picked on this machine for this agent
 * @returns {import('../model/store').PermissionMode}
 */
export function startingHostMode({ pick, hostId, harness, macDefault, lastChosen, policy = START_POLICY }) {
  const picked = hostPermissionOf(pick, hostId, harness);
  if (picked) return picked;
  if (policy === 'remember') return isHostPermission(lastChosen) ? lastChosen : 'default';
  if (!isHostPermission(macDefault)) return 'default';
  return policy === 'capped' && macDefault === 'full-access' ? 'auto-review' : macDefault;
}
