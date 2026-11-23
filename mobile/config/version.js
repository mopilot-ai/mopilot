// The phone app's one version record (config/version.json): the marketing version and the build number every store build gets, and the rules both must follow.
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'version.json');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** Google Play rejects a versionCode above this; App Store Connect only needs the build number to rise. */
const MAX_BUILD = 2_100_000_000;

/** @param {string} a @param {string} b @returns {number} negative, zero or positive like a comparator */
function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** @param {unknown} record @returns {{ version: string, buildNumber: number }} the record, or an error that names what is wrong */
function validate(record) {
  const r = /** @type {any} */ (record);
  if (!r || typeof r.version !== 'string' || !SEMVER.test(r.version)) throw new Error(`version must be MAJOR.MINOR.PATCH, got ${JSON.stringify(r?.version)}`);
  if (!Number.isInteger(r.buildNumber) || r.buildNumber < 1 || r.buildNumber > MAX_BUILD) {
    throw new Error(`buildNumber must be an integer from 1 to ${MAX_BUILD}, got ${JSON.stringify(r.buildNumber)}`);
  }
  return { version: r.version, buildNumber: r.buildNumber };
}

/** @param {string} [file] */
function readVersion(file = FILE) {
  return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/**
 * The record after a bump: the build number always rises by one (it never resets, because Play needs one rising versionCode for
 * the app's whole life and App Store Connect one rising build per version), and a new marketing version must not go backwards.
 * `build` names the number explicitly, for a release cut from an older commit: it must be above this commit's and is the caller's
 * promise that it is above every build ever uploaded (docs/mobile-remote/release-checklist.md#d-rollback).
 * @param {{ version: string, buildNumber: number }} current
 * @param {string} [version]
 * @param {number} [build]
 */
function bump(current, version, build) {
  if (version !== undefined && (!SEMVER.test(version) || compareVersions(version, current.version) < 0)) {
    throw new Error(`the new version must be MAJOR.MINOR.PATCH and not below ${current.version}, got ${JSON.stringify(version)}`);
  }
  if (build !== undefined && !(Number.isInteger(build) && build > current.buildNumber)) {
    throw new Error(`the new build number must be an integer above ${current.buildNumber}, got ${JSON.stringify(build)}`);
  }
  return validate({ version: version ?? current.version, buildNumber: build ?? current.buildNumber + 1 });
}

/** Whether `next` may follow `base` (the last uploaded build, or the branch a release builds on): a higher build number and a version that did not go backwards. */
function follows(base, next) {
  return next.buildNumber > base.buildNumber && compareVersions(next.version, base.version) >= 0;
}

module.exports = { FILE, MAX_BUILD, SEMVER, bump, compareVersions, follows, readVersion, validate };
