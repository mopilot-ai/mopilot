// Explicit rollback rules bind an older package to one withdrawn version and one install update channel.
const { parseExactVersion, compareVersionParts } = require('./exactSemver.mjs');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const older = (target, source) => {
  const a = parseExactVersion(target),
    b = parseExactVersion(source);
  return !!a && !!b && compareVersionParts(a, b) < 0;
};
const checkedPackage = (row) =>
  typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/.test(row.sha256) && Number.isSafeInteger(row.size) && row.size > 0;

/** Reject malformed or ambiguous authority instead of treating it as an empty rollback policy. */
function rollbackPolicies(value = []) {
  if (!Array.isArray(value)) throw new Error('Invalid rollback rules');
  const identities = new Set();
  for (const rule of value) {
    if (
      !rule ||
      !['stable', 'beta', 'dogfood'].includes(rule.channel) ||
      typeof rule.enabled !== 'boolean' ||
      typeof rule.requestId !== 'string' ||
      !UUID.test(rule.requestId) ||
      !older(rule.targetVersion, rule.version)
    )
      throw new Error('Invalid rollback rule');
    const key = JSON.stringify([rule.version, rule.channel]);
    if (identities.has(key)) throw new Error('Duplicate rollback rule');
    identities.add(key);
  }
  return value;
}

/** Running affected installs take priority; replacing a withdrawn staged copy also uses its explicit rule. */
function rollbackSelection(rows, policies, { version, stagedVersion, channel, platform, arch }) {
  const scoped = policies.filter((p) => p.channel === channel);
  const rule = scoped.find((p) => p.enabled && p.version === version) ?? scoped.find((p) => p.version === stagedVersion);
  if (!rule) return null;
  const row = rows.find((r) => r.version === rule.targetVersion && r.platform === platform && r.arch === arch && r.rolloutPct === 100);
  if (!row || !checkedPackage(row) || scoped.some((p) => p.version === row.version))
    throw new Error(`Rollback target ${rule.targetVersion} is unavailable for ${channel}. Contact support or check again later.`);
  return { row, rollback: { fromVersion: rule.version, channel, requestId: rule.requestId } };
}

/** A lower-version reply is accepted only with intent tied to the current install or its staged artifact. */
function validateRollbackOffer(update, { version, stagedVersion, channel }) {
  const intent = update.rollback;
  if (intent === undefined) {
    if (older(update.name, version)) throw new Error('The update feed offered an older version without rollback authorization');
    return;
  }
  if (
    !intent ||
    intent.channel !== channel ||
    typeof intent.requestId !== 'string' ||
    !UUID.test(intent.requestId) ||
    (intent.fromVersion !== version && intent.fromVersion !== stagedVersion) ||
    !older(update.name, intent.fromVersion) ||
    !checkedPackage(update)
  )
    throw new Error('Invalid rollback authorization in the update feed');
}

module.exports = { rollbackPolicies, rollbackSelection, validateRollbackOffer };
