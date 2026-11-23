// Native Claude settings changes serialize with turn starts and reconcile latest permissions within one process lifetime.
const { matchesSource } = require('../../session/contract/route.cjs');
const { appPermission } = require('../../../shared/permissionMenu.mjs');
const { noteIgnored } = require('../../ignored.cjs');

const lifetime = (adapter, key) => adapter.nativeSettingsLifetimes?.get(key) ?? 0;

/** A closed process cannot keep an old queue in front of its replacement or overwrite the replacement's settings. */
function retireNativeSettings(adapter, key) {
  const epochs = (adapter.nativeSettingsLifetimes ??= new Map());
  epochs.set(key, lifetime(adapter, key) + 1);
  adapter.permissionJobs?.delete(key);
  adapter.nativePermissionReports?.delete(key);
}

const permissionReportVersion = (adapter, key) => adapter.nativePermissionReports?.get(key)?.version ?? 0;

/** Native EnterPlanMode/ExitPlanMode and control acknowledgments own the current mode, not a start-time cache. */
function observeNativePermission(adapter, key, message) {
  if (message.parent_tool_use_id || message.type !== 'system' || !['init', 'status'].includes(message.subtype)) return false;
  const permission = appPermission(message.permissionMode);
  if (!permission || !ownsNative(adapter, key)) return false;
  const reports = (adapter.nativePermissionReports ??= new Map());
  const before = reports.get(key);
  const cur = adapter.live.get(key);
  const prior = cur?.permission ?? before?.permission;
  const snapshot = cur ? (cur.permission === permission ? cur : { ...cur, permission }) : null;
  if (snapshot) adapter.live.set(key, snapshot);
  reports.set(key, { version: (before?.version ?? 0) + 1, permission, snapshot });
  // a host (the Host's chat state) is told when the CLI enters or leaves Plan on its own
  if (prior !== permission) adapter.modeChanged?.(adapter.chatOf(key), prior, permission);
  return prior === 'plan' && permission !== 'plan';
}

/** A native mode reported during a turn's awaited send wins over the settings captured before it started. */
function reportedSettings(adapter, key, settings, beforeVersion) {
  const report = adapter.nativePermissionReports?.get(key);
  return report && report.version > beforeVersion ? { ...settings, permission: report.permission } : settings;
}

/** Turn starts and live controls share this queue; failed work does not drop the next independent request. */
function serializeNativeSettings(adapter, key, run) {
  const queues = (adapter.nativeSettingsQueues ??= new Map());
  const generation = lifetime(adapter, key);
  const current = () => lifetime(adapter, key) === generation;
  const before = queues.get(key);
  const earlier = before?.generation === generation ? before.promise : Promise.resolve();
  const invoke = () => run(current);
  const promise = earlier.then(invoke, invoke).finally(() => {
    if (queues.get(key) === entry) queues.delete(key);
  });
  const entry = { generation, promise };
  queues.set(key, entry);
  return promise;
}

/** A live setting belongs only to the chat still routed to this native session. */
function ownsNative(adapter, key) {
  try {
    return matchesSource(adapter.refOf(adapter.chatOf(key)), { kind: 'claude', key });
  } catch {
    return false;
  }
}

/** Repeated requests combine; each awaited control is followed by a fresh read of durable desired settings. */
function reconcilePermission(adapter, key) {
  const jobs = (adapter.permissionJobs ??= new Map());
  const generation = lifetime(adapter, key);
  const prior = jobs.get(key);
  if (prior?.generation === generation) {
    prior.request.version++;
    return prior.promise;
  }
  const request = { version: 1 };
  const promise = serializeNativeSettings(adapter, key, async (current) => {
    let changed = false;
    while (current() && ownsNative(adapter, key) && adapter.api.isLive(key)) {
      const cur = adapter.live.get(key);
      if (!cur || cur.permission === 'plan') break;
      const desired = () => adapter.settings(adapter.chatOf(key), {}).permission;
      const permission = desired();
      if (permission === cur.permission || permission === 'read-only' || cur.permission === 'read-only') break;
      const version = request.version;
      const reportVersion = permissionReportVersion(adapter, key);
      try {
        await adapter.api.control(key, 'setPermissionMode', permission);
      } catch (error) {
        if (!current() || !ownsNative(adapter, key) || !adapter.api.isLive(key)) break;
        const report = adapter.nativePermissionReports?.get(key);
        if (
          report?.snapshot === adapter.live.get(key) &&
          report.version > reportVersion &&
          (report.permission === permission || report.permission !== cur.permission)
        ) {
          changed ||= report.permission === permission;
          continue;
        }
        if (request.version !== version || desired() !== permission) continue;
        noteIgnored('apply a live Claude Code permission mode', error);
        adapter.emit(
          {
            kind: 'toast',
            level: 'error',
            text: "Couldn't change this session's permissions. Its previous mode is still active; try again or stop the session.",
          },
          'any',
        );
        break;
      }
      if (!current() || !ownsNative(adapter, key) || !adapter.api.isLive(key)) break;
      if (adapter.live.get(key) !== cur) {
        const report = adapter.nativePermissionReports?.get(key);
        if (report?.snapshot === adapter.live.get(key) && report.version > reportVersion) {
          changed ||= report.permission === permission;
          continue;
        }
        break;
      }
      adapter.live.set(key, { ...cur, permission });
      changed = true;
    }
    return changed;
  }).finally(() => {
    if (jobs.get(key) === job) jobs.delete(key);
  });
  const job = { generation, request, promise };
  jobs.set(key, job);
  return promise;
}

module.exports = {
  serializeNativeSettings,
  reconcilePermission,
  retireNativeSettings,
  ownsNative,
  observeNativePermission,
  permissionReportVersion,
  reportedSettings,
};
