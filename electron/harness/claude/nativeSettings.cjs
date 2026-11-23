// SDK permission and flag mutations serialize per actual Claude process; retired work cannot delay or modify its replacement.
const { permissionMode, restoreMode, flagSettings } = require('./sessionOptions.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { settleIdle } = require('./readOnlyBoundary.cjs');

const queues = new WeakMap();
const RESTORE_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto']);

/** A current root native receipt owns plan restoration even when the control response is lost or arrives late. */
function observeNativeRestoreMode(session, message) {
  settleIdle(session, message);
  if (message.parent_tool_use_id || message.type !== 'system' || !['init', 'status'].includes(message.subtype)) return false;
  // the mode this process last confirmed, whatever it is: a live change counts only once the CLI reports it (readOnlyBoundary.cjs)
  if (typeof message.permissionMode === 'string') session.nativeMode = message.permissionMode;
  if (!RESTORE_MODES.has(message.permissionMode)) return false;
  session.restoreReport = {};
  session.restoreMode = message.permissionMode;
  return true;
}

function mutateNativeSettings(session, current, run) {
  const before = queues.get(session) ?? Promise.resolve();
  const perform = async () => {
    current();
    const result = await run();
    current();
    return result;
  };
  const next = before.then(perform, perform);
  queues.set(session, next);
  return next.finally(() => {
    if (queues.get(session) === next) queues.delete(session);
  });
}

function setNativePermission(session, permission, current) {
  return mutateNativeSettings(session, current, async () => {
    const report = session.restoreReport;
    const result = await session.q.setPermissionMode(permissionMode(permission).permissionMode);
    current();
    if (permission !== 'plan' && session.restoreReport === report) session.restoreMode = restoreMode(permission);
    return result;
  });
}

function applyNativeFlags(session, patch, current, readSettings) {
  return mutateNativeSettings(session, current, async () => {
    const known = 'ultracode' in (patch ?? {}) || session.ultracode !== undefined;
    const applied = !known && patch && 'effortLevel' in patch ? await readSettings(session) : null;
    current();
    await session.q.applyFlagSettings(flagSettings(session, patch, applied));
    current();
    // The mutation is complete; the optional display refresh checks its own native lifetime.
    readSettings(session).catch((error) => noteIgnored("refresh a Claude Code session's settings", error));
    return true;
  });
}

module.exports = { mutateNativeSettings, setNativePermission, applyNativeFlags, observeNativeRestoreMode };
