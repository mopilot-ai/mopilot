// Recovery shared by tool errors and permission UI when macOS rejects an already enabled helper grant.
import { staleGrantHint } from './staleGrant.mjs';

/**
 * An unavailable effective grant does not establish that the switch in System Settings is off.
 * @param {string} permission
 * @param {string} [helperName]
 */
export function computerPermissionRecovery(permission, helperName = 'MoPilot') {
  return `macOS still reports ${permission} unavailable to "${helperName}". ${staleGrantHint(`"${helperName}"`, permission, 'try again')} If access is still unavailable, restart your Mac before trying again.`;
}
