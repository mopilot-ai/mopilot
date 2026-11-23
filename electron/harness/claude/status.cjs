// Validate Claude Code authentication status before detection or account refresh trusts it.
const { parseJsonRecord } = require('../../../shared/jsonRecord.mjs');

/** @typedef {{loggedIn: boolean, email?: string|null, authMethod?: string|null, subscriptionType?: string|null, apiProvider?: string|null}} ClaudeStatus */

/** Unknown status is a failed read, never an inferred sign-out. @param {string} text @returns {ClaudeStatus} */
function parseClaudeStatus(text) {
  const parsed = parseJsonRecord(text);
  if (
    !parsed.ok ||
    typeof parsed.record.loggedIn !== 'boolean' ||
    !['email', 'authMethod', 'subscriptionType', 'apiProvider'].every(
      (key) => parsed.record[key] == null || typeof parsed.record[key] === 'string',
    )
  )
    throw new TypeError('Invalid Claude Code authentication status JSON');
  return /** @type {ClaudeStatus} */ (parsed.record);
}

module.exports = { parseClaudeStatus };
