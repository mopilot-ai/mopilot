// Public stable update manifest selection and deterministic rollout buckets, shared by desktop and web.
const { createHash } = require('node:crypto');
const { parseExactVersion, compareVersionParts } = require('./exactSemver.mjs');
const { rollbackPolicies, rollbackSelection } = require('./releaseRollback.cjs');
const STABLE_FEED_URL = 'https://raw.githubusercontent.com/mopilot-ai/mopilot-code-release/main/updates/stable.json';

function rolloutBucket(installId, salt = '') {
  return createHash('sha256').update(`${salt}:${installId}`).digest().readUInt32BE(0) % 100;
}

/** Validate an actual HTTPS URL before reporting an update as ready on either platform. */
function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}

/** Parse app versions without losing integer precision while comparing their numeric components. */
function versionParts(value) {
  const parts = parseExactVersion(value);
  if (!parts) throw new Error('Invalid version in the stable update manifest');
  return parts;
}

function compareStable(a, b) {
  return compareVersionParts(versionParts(a), versionParts(b));
}

/** Reject a corrupt manifest instead of reporting it as up to date. Only public stable rows belong here. */
function selectStableUpdate(manifest, { version, stagedVersion, platform, arch, installId }) {
  if (
    !manifest ||
    manifest.schema !== 1 ||
    !Array.isArray(manifest.releases) ||
    (manifest.promotions !== undefined && !Array.isArray(manifest.promotions)) ||
    (manifest.linuxReleases !== undefined && !Array.isArray(manifest.linuxReleases))
  )
    throw new Error('Invalid stable update manifest');
  versionParts(version);
  // Older schema-1 readers ignore this additive field and continue receiving their compatible stable baseline.
  const promotions = manifest.promotions ?? [];
  const linuxReleases = manifest.linuxReleases ?? [];
  for (const [rows, allowPre, platforms] of [
    [manifest.releases, false, ['darwin', 'win32']],
    [promotions, true, ['darwin', 'win32']],
    [linuxReleases, true, ['linux']],
  ])
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        (versionParts(row.version).pre.length > 0 && !allowPre) ||
        !platforms.includes(row.platform) ||
        !['arm64', 'x64'].includes(row.arch) ||
        (row.platform === 'win32' && row.arch !== 'x64') ||
        !Number.isInteger(row.rolloutPct) ||
        row.rolloutPct < 0 ||
        row.rolloutPct > 100 ||
        !isHttpsUrl(row.url) ||
        typeof row.notes !== 'string' ||
        typeof row.pub_date !== 'string' ||
        !Number.isFinite(Date.parse(row.pub_date))
      )
        throw new Error('Invalid release in the stable update manifest');
    }
  const rules = rollbackPolicies(manifest.rollbacks);
  if (rules.some((r) => r.channel !== 'stable')) throw new Error('Private rollback rule in the stable update manifest');
  const rows = [...manifest.releases, ...promotions, ...linuxReleases];
  const choice = rollbackSelection(rows, rules, { version, stagedVersion, channel: 'stable', platform, arch });
  if (choice)
    return {
      url: choice.row.url,
      name: choice.row.version,
      notes: choice.row.notes,
      pub_date: choice.row.pub_date,
      rollback: choice.rollback,
      sha256: choice.row.sha256,
      size: choice.row.size,
    };
  const blocked = new Set(rules.map((r) => r.version));
  const candidates = rows
    .filter((row) => row.platform === platform && row.arch === arch && !blocked.has(row.version) && compareStable(row.version, version) > 0)
    .sort((a, b) => compareStable(b.version, a.version));
  const row = candidates.find((r) => rolloutBucket(installId, r.version) < r.rolloutPct);
  return row ? { url: row.url, name: row.version, notes: row.notes, pub_date: row.pub_date } : null;
}

module.exports = { STABLE_FEED_URL, rolloutBucket, selectStableUpdate, isHttpsUrl };
