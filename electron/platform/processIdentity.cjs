// Coherent kernel process identities, for retirement and for telling a recorded pid from one handed out again: the Rust core's reader, with no guessed births.
const { core, coreCall, requiredCore } = require('./core.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { packageExecutionBlock } = require('../../shared/harnessInstall.mjs');

/** Missing or malformed native identities never become an approximate timestamp: a read that fails (noted) is empty. */
async function identityTable({ call = coreCall } = {}) {
  let rows;
  try {
    rows = await call('proc.identities');
  } catch (error) {
    noteIgnored("read the processes' kernel identities", error);
    return [];
  }
  return Array.isArray(rows) &&
    rows.length &&
    rows.every(
      (r) =>
        Array.isArray(r) && r.length === 4 && r.slice(0, 3).every((n) => Number.isSafeInteger(n) && n >= 0) && typeof r[3] === 'string',
    )
    ? rows
    : [];
}

/**
 * When the process with this pid started (ms), as the core reads it for any user's process: null when that can't be told
 * (no such process; one this user can't read, the route's error, noted), so a caller keeps what it does for not knowing.
 * @param {number} pid @param {ReturnType<typeof core> | null} [addon]
 * @returns {Promise<number | null>}
 */
async function processStart(pid, addon = core()) {
  try {
    const at = await coreCall('proc.started', addon, String(pid));
    return Number.isFinite(at) ? at : null;
  } catch (error) {
    noteIgnored('read when a process started', error);
    return null;
  }
}

/** Refuse before launching a command when this platform has no trustworthy retirement monitor.
 * @param {string} [platform] @param {ReturnType<typeof core>} [addon] */
function ensureRetirementMonitor(platform = process.platform, addon = core()) {
  const blocked = packageExecutionBlock(platform);
  if (blocked) throw new Error(blocked);
  // a platform whose core reads no kernel identities (core/crates/proc routes)
  if (!requiredCore(addon).routes().includes('proc.identities'))
    throw new Error('This build cannot verify package installer shutdown. Rebuild or update MoPilot, then retry.');
}

module.exports = { identityTable, processStart, ensureRetirementMonitor };
