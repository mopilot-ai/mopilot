// Read stable updates from GitHub's static manifest; restricted channels retain MoPilot's authenticated feed.
const { STABLE_FEED_URL, selectStableUpdate, isHttpsUrl } = require('../../shared/stableUpdates.cjs');
const { statusFailure, unreachableFailure } = require('./download.cjs');
const { messageOf } = require('../ignored.cjs');
const { validateRollbackOffer } = require('../../shared/releaseRollback.cjs');

async function readUpdateFeed({ url, channel, version, stagedVersion, platform, arch, installId, headers, fetch }) {
  const stable = channel === 'stable';
  const target = stable ? STABLE_FEED_URL : url;
  const res = await fetch(target, {
    headers: { accept: 'application/json', ...(stable ? {} : headers) },
    cache: 'no-cache',
    signal: AbortSignal.timeout(60_000),
  }).catch((error) => {
    throw new Error(unreachableFailure('Update check', target, error));
  });
  if (!stable && res.status === 204) return null;
  if (!res.ok) throw new Error(statusFailure('Update check', target, res.status));
  const b = await res.json().catch((error) => {
    throw new Error(`Update check failed: ${new URL(target).host} sent an update feed that could not be read (${messageOf(error)}).`);
  });
  if (stable) return selectStableUpdate(b, { version, stagedVersion, platform, arch, installId });
  if (!isHttpsUrl(b?.url)) throw new Error(`The update feed returned no ${platform === 'win32' ? 'installer' : 'update file'}`);
  const update = {
    url: b.url,
    name: String(b.name || ''),
    notes: String(b.notes || ''),
    ...(b.pub_date ? { pub_date: String(b.pub_date) } : {}),
    ...(b.rollback !== undefined && { rollback: b.rollback, sha256: b.sha256, size: b.size }),
  };
  validateRollbackOffer(update, { version, stagedVersion, channel });
  return update;
}
module.exports = { readUpdateFeed };
