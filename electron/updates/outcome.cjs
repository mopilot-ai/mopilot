// Whether updates land, as usage data: the first run of a new version reports it, and each failed update stage once per run.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { parseJsonRecord } = require('../../shared/jsonRecord.mjs');
const { parseExactVersion } = require('../../shared/exactSemver.mjs');

const ACTIVATION_FILE = 'pending-mac-update.json';

/** An accepted helper command survives the app exit, so a subsequent launch of the old app can report the failure. */
function recordActivation(userData, version, channel) {
  try {
    writePrivate(path.join(userData, ACTIVATION_FILE), JSON.stringify({ version, channel }));
  } catch (error) {
    noteIgnored('record the accepted update activation', error);
  }
}

function takeActivationFailure(userData, installed) {
  const file = path.join(userData, ACTIVATION_FILE);
  try {
    const value = parseJsonRecord(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file);
    if (!value.ok) return null;
    const { version, channel } = value.record;
    if (version === installed || typeof version !== 'string' || !parseExactVersion(version)) return null;
    if (typeof channel !== 'string' || !['stable', 'beta', 'dogfood'].includes(channel)) return null;
    return { stage: 'install', version, channel };
  } catch (error) {
    noteIgnored('read the accepted update activation', error, ['ENOENT']);
    return null;
  }
}

/** The version the last run recorded, or null on an install's first run or an unreadable record. */
function recordedVersion(/** @type {string} */ file) {
  try {
    const parsed = parseJsonRecord(fs.readFileSync(file, 'utf8'));
    return parsed.ok && typeof parsed.record.version === 'string' ? parsed.record.version : null;
  } catch (error) {
    noteIgnored('read the installed version', error, ['ENOENT']);
    return null;
  }
}

/**
 * Report `update_installed` on the first run of a new version. A first install has nothing to report, and the record is
 * written before reporting, so a record that cannot be written never reports the same update at every start.
 * @param {{ userData: string, version: string, channel: string, track: (name: string, props: object) => void }} o
 */
function reportInstalledVersion({ userData, version, channel, track }) {
  const file = path.join(userData, 'installed-version');
  const previous = recordedVersion(file);
  if (previous === version) return;
  try {
    writePrivate(file, JSON.stringify({ version }));
  } catch (error) {
    noteIgnored('record the installed version', error);
    return;
  }
  if (previous) track('update_installed', { from: previous, version, channel });
}

/**
 * What failed between two updater states, or null. An update that stopped at the download, in Squirrel's preparation or
 * at the restart ends with a new error on the way out of that status; an update check that fails is not one of these.
 * @param {{ status?: string, error?: string | null, preparing?: boolean, progress?: { version: string }, available?: { version: string } | null }} before
 * @param {{ status?: string, error?: string | null, available?: { version: string } | null }} after
 * @returns {{ stage: 'download' | 'prepare' | 'install', version: string | undefined } | null}
 */
function updateFailure(before, after) {
  if (!after.error || after.error === before.error || after.status === before.status) return null;
  if (before.status === 'downloading') return { stage: before.preparing ? 'prepare' : 'download', version: before.progress?.version };
  return before.status === 'installing' ? { stage: 'install', version: after.available?.version ?? before.available?.version } : null;
}

/**
 * Follows the updater's state broadcasts. A stage that keeps failing on the schedule counts once per version and run.
 * @param {(failure: { stage: string, version: string }) => void} report
 */
function failureWatcher(report) {
  const seen = new Set();
  let before = {};
  return (/** @type {object} */ state) => {
    const failure = updateFailure(before, state);
    before = state;
    if (!failure?.version || seen.has(`${failure.stage}:${failure.version}`)) return;
    seen.add(`${failure.stage}:${failure.version}`);
    report({ stage: failure.stage, version: failure.version });
  };
}

module.exports = { recordActivation, reportInstalledVersion, takeActivationFailure, updateFailure, failureWatcher };
