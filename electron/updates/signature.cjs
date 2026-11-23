// Whether this app bundle can take a Squirrel.Mac update: only a Developer ID signature, read with codesign.
const { proc } = require('../platform/ports/proc.cjs');
const path = require('node:path');

/**
 * The team of a `codesign -dvv` report whose leaf certificate is Developer ID Application; null otherwise (ad-hoc,
 * unsigned, or a dev build signed with Apple Development, whose designated requirement no release can satisfy).
 */
function developerIdTeamOf(codesignOutput) {
  const out = String(codesignOutput);
  if (!/^Authority=Developer ID Application: /.test(/^Authority=.*$/m.exec(out)?.[0] ?? '')) return null;
  const t = /^TeamIdentifier=(.+)$/m.exec(out)?.[1]?.trim();
  return t && t !== 'not set' ? t : null;
}

/**
 * The .app bundle that holds an executable: its nearest ancestor named *.app, found by name rather than by counting
 * `..` from the executable (a count that a file move once rewrote, so codesign read /Applications), or null.
 */
function appBundleOf(execPath) {
  for (let dir = path.dirname(execPath); dir !== path.dirname(dir); dir = path.dirname(dir)) if (dir.endsWith('.app')) return dir;
  return null;
}

/**
 * The app bundle's Developer ID team, read from its signature (-dvv lists the certificate chain): null when the bundle
 * has none. Rejects when codesign couldn't read the bundle at all (a timeout, or no bundle), which says nothing about
 * its signature, so the caller can ask again instead of turning updates off for the run.
 */
function bundleTeam({ execPath = process.execPath, run = proc.execFile } = {}) {
  const bundle = appBundleOf(execPath);
  if (!bundle) return Promise.reject(new Error(`${execPath} is not inside an app bundle`));
  return new Promise((resolve, reject) =>
    run('codesign', ['-dvv', bundle], { timeout: 5000 }, (err, _out, report) => {
      const text = String(report);
      if (err && !/not signed at all/.test(text))
        return reject(new Error(`codesign couldn't read ${bundle}: ${text.trim() || err.message}`));
      resolve(developerIdTeamOf(text));
    }),
  );
}

/** What the updater shows while codesign can't read the bundle; a later read that succeeds clears it. */
const UNREAD_SIGNATURE = "Couldn't read MoPilot's signature. Check for updates to try again.";

/**
 * The updater's reading of the signature: null when Squirrel can update the bundle, else the update state it leaves.
 * Squirrel can't install into a build without a Developer ID signature (dev, ad-hoc packages), so that answer is kept
 * and turns updates off; a signature codesign couldn't read is an error, and the next read asks codesign again.
 * @param {(() => Promise<string | null>) | undefined} team defaults to bundleTeam
 * @param {(context: string, error: unknown) => void} note logs why codesign couldn't read the bundle
 * @returns {() => Promise<{ status: string, error?: string } | null>}
 */
function signatureReader(team, note) {
  /** @type {Promise<{ status: string, error?: string } | null> | null} */
  let answer = null;
  return () =>
    // started from a resolved promise, so a reader that throws instead of rejecting is read again too
    (answer ??= Promise.resolve()
      .then(() => (team ?? bundleTeam)())
      .then(
        (t) => (t ? null : { status: 'unsupported' }),
        (err) => {
          note('read the app signature for updates', err);
          answer = null;
          return { status: 'error', error: UNREAD_SIGNATURE };
        },
      ));
}

module.exports = { developerIdTeamOf, appBundleOf, bundleTeam, signatureReader, UNREAD_SIGNATURE };
