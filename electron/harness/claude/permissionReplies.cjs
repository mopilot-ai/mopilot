// A native Claude permission reply settles only the live process that still owns its request.
const { clock } = require('../../platform/ports/clock.cjs');
const { planApproval } = require('./sessionOptions.cjs');

/** Capture the request's native lifetime before its callback can restore plan mode or resume the SDK. */
function planPermissionReply({ state, lifetime, s, toolName, options, requestId, finish }) {
  const sent = s.sent;
  return (result) => {
    if (
      toolName === 'ExitPlanMode' &&
      result?.behavior === 'allow' &&
      !options?.agentID &&
      !options?.signal?.aborted &&
      lifetime.active(s) &&
      s.sent === sent
    )
      state.emit({ key: s.key, kind: 'planAccepted', requestId });
    finish(planApproval(toolName, result, s.restoreMode));
  };
}

function replyPermission(state, requestId, result) {
  for (const s of state.sessions.values()) {
    const resolve = s.perms.get(requestId);
    if (!resolve) continue;
    s.perms.delete(requestId);
    s.lastActive = clock.now();
    resolve(result);
    return true;
  }
  return false;
}

module.exports = { replyPermission, planPermissionReply };
