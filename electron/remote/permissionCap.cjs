// What a phone may set a permission to: never full access (bypass), and never above the Mac's ceiling.
const { appPermission, PERMISSION_ORDER } = require('../../shared/permissionMenu.mjs');
const { RemoteError } = require('./serviceErrors.cjs');

/** Throws a forbidden error when `value` (an app permission or a harness's native mode) is one a phone may not set. */
function capPermission(/** @type {string} */ value, /** @type {string} */ ceiling) {
  const app = /** @type {string | null} */ (appPermission(value));
  if (app === null) throw new RemoteError('forbidden', 'Set this on your Mac.');
  if (app === 'full-access') throw new RemoteError('forbidden', 'Full access can only be set on your Mac.');
  if (/** @type {string[]} */ (PERMISSION_ORDER).indexOf(app) > /** @type {string[]} */ (PERMISSION_ORDER).indexOf(ceiling))
    throw new RemoteError('forbidden', 'That permission is above what this Mac allows from a phone.');
}

module.exports = { capPermission };
