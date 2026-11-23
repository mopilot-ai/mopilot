// Per-install identity, and the MoPilot service origin where this build has one (electron/platform/mopilotEndpoints.cjs).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writePrivate } = require('./fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { endpoints } = require('./mopilotEndpoints.cjs');

/** The MoPilot service's origin, without a trailing slash; null in a build without the service (the open-source edition). */
const API_BASE = endpoints?.API_BASE ?? null;

/** The release workflow marks the builds it ships (scripts/package.mjs); one packaged anywhere else is a local build. */
const RELEASE_BUILD = /** @type {{ mopilotBuild?: string }} */ (require('../../package.json')).mopilotBuild === 'release';

/**
 * A test instance: a release's smoke launch (MOPILOT_SMOKE_RESULT), an E2E or virtual-machine instance
 * (SAGE_E2E_BACKGROUND=1) or a release run (MOPILOT_TEST_RUN). Each starts on scratch user data, so a new install id.
 * @param {NodeJS.ProcessEnv} env
 */
const testInstance = (env) => env.SAGE_E2E_BACKGROUND === '1' || !!env.MOPILOT_SMOKE_RESULT || !!env.MOPILOT_TEST_RUN;

/** Whether `url` is a web app on this computer (a test's fake service), not mopilot.ai under any of its names. */
function loopback(url) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);
  } catch {
    // not a URL: nothing to report to
    return false;
  }
}

/**
 * Whether this build reports usage data, install pings and crashes: released builds do; a dev or local build only
 * when MOPILOT_API points it at a web app on purpose, so neither `npm run dev` nor a locally packaged app counts as
 * an install. A test instance reports only to a web app on this computer, never to mopilot.ai, even when MOPILOT_API
 * names it (the release workflow exports it to every step): each of its launches would count as a new install.
 * @param {boolean} packaged app.isPackaged
 */
const reportsToService = (packaged, env = process.env, release = RELEASE_BUILD) => {
  if (testInstance(env)) return !!env.MOPILOT_API && loopback(env.MOPILOT_API);
  return (packaged && release) || !!env.MOPILOT_API;
};

/**
 * Whether this install is test tooling's (bench and cloned VMs, a developer's installed build) rather than a user's: only
 * an explicit signal says so, MOPILOT_INSTALL_ORIGIN=test or a file `install-origin` holding `test` in the data folder
 * (an app opened from Finder has no env). Anything else, an unreadable file included, is a user. Read at each send, so
 * adding or removing the marker needs no restart. The one value that reports; nothing is inferred.
 * @param {string} userData @param {NodeJS.ProcessEnv} [env]
 * @returns {'user' | 'test'}
 */
function installOrigin(userData, env = process.env) {
  if (env.MOPILOT_INSTALL_ORIGIN === 'test') return 'test';
  try {
    return fs.readFileSync(path.join(userData, 'install-origin'), 'utf8').trim() === 'test' ? 'test' : 'user';
  } catch (error) {
    // no marker (ENOENT) is the normal case: a user's install
    noteIgnored('read the install origin marker', error, ['ENOENT']);
    return 'user';
  }
}

/** @type {string | null} */
let cached = null;
/**
 * A random id for this installation (not tied to the user); created on first use.
 * @returns {string}
 */
function installId(userData) {
  if (cached) return cached;
  const file = path.join(userData, 'install-id');
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(v)) return (cached = v);
  } catch (error) {
    // missing (ENOENT): mint one below
    // one that can't be read is replaced, so the id stays the same from the next launch on
    noteIgnored('read the install id', error, ['ENOENT']);
  }
  cached = crypto.randomUUID();
  try {
    writePrivate(file, cached);
  } catch (error) {
    // the id stays cached for this run even if it cannot be saved
    noteIgnored('save the install id', error);
  }
  return cached;
}

/**
 * When this install was set up: the time its install id was saved (null when it can't be read). Sent with the
 * ping so an install that never reported before is not counted as new on the day it first does.
 * @param {string} userData
 */
function installedAt(userData) {
  try {
    return Math.floor(fs.statSync(path.join(userData, 'install-id')).mtimeMs);
  } catch (error) {
    noteIgnored('read when the install id was saved', error);
    return null;
  }
}

module.exports = { API_BASE, installId, installOrigin, installedAt, reportsToService };
