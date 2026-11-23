// What a Claude turn runs with, the part main decides when it starts a turn (electron/harness/claude/adapter.cjs)
// and main's translator shares.

/** "Approve for me" needs a model that supports auto mode (D-67); otherwise the chat asks as usual. */
export function claudePermissionFor(permission, model) {
  return permission === 'auto-review' && model?.autoMode === false ? 'default' : permission;
}

/**
 * Settings to bring a live CLI in line with a turn's, or null when the session has to restart
 * (another account: the process is replaced, so its old settings mustn't be applied or kept, D-84).
 */
export function liveControls(cur, want) {
  if (!cur || cur.account !== want.account) return null;
  const out = [];
  if (cur.model !== want.model) out.push(['setModel', want.model]);
  if (cur.effort !== want.effort || cur.fast !== want.fast)
    out.push(['applyFlagSettings', { effortLevel: want.effort, fastMode: want.fast }]);
  if (cur.permission !== want.permission) out.push(['setPermissionMode', want.permission]);
  return out;
}
