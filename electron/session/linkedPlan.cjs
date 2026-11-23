// A linked chat's initial plan permission restores its saved base when the user or current native session leaves planning.
const { appPermission } = require('../../shared/permissionMenu.mjs');
function leaveLinkedPlan(chats, chatId, nativeMode) {
  const config = chats.records.get(chatId)?.meta?.config;
  if (config?.permission !== 'plan' || nativeMode === 'plan') return false;
  const permission = nativeMode === undefined ? (config.planBasePermission ?? 'default') : appPermission(nativeMode);
  if (!permission) return false;
  // patchMeta-changes: the config leaves plan, so the permission always changes
  if (!chats.patchMeta(chatId, { config: { ...config, permission } }))
    throw new Error('The chat could not save its permission after leaving plan mode');
  return true;
}
module.exports = { leaveLinkedPlan, appPermission };
