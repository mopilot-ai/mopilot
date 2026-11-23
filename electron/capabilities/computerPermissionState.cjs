// Records native helper permission reports and refreshes cached Accessibility status after a successful request.
const { noteIgnored } = require('../ignored.cjs');
const { missingPermissions } = require('./capabilityHealth.cjs');

/** Keeps the helper's reported booleans, while preserving the response for its caller. */
function notePermissions(helper, report, emit = true) {
  if (!report || typeof report !== 'object') return report;
  const next = Object.fromEntries(Object.entries(report).filter(([, value]) => typeof value === 'boolean'));
  const changed = JSON.stringify(next) !== JSON.stringify(helper.permissions);
  helper.permissions = next;
  if (changed && emit) helper.emit('state');
  return report;
}

/** A successful request refreshes stale required grants, except Screen Recording which needs a new process. */
function recheckPermissions(helper, method, read) {
  const stale = missingPermissions(helper.permissions).filter((key) => key !== 'screenRecording');
  if (method.startsWith('permissions.') || !stale.length) return;
  if (helper.now() - helper.recheckedAt < helper.recheckMs) return;
  helper.recheckedAt = helper.now();
  read().then(
    (report) => notePermissions(helper, report),
    (error) => noteIgnored('read the computer-use permissions again after a request worked', error),
  );
}

module.exports = { notePermissions, recheckPermissions };
