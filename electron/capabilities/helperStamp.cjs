// The computer-use helper's build stamp (#4320): a digest of the helper's sources that the build writes into its Info.plist and its hello returns, and the digest this app expects, so an older binary is reported as out of date instead of dropping clicks silently.
const crypto = require('node:crypto');
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');

/** What a packaged app expects when it has no record of its helper's build: nothing matches it, so no helper runs (a missing record is never a pass). */
const UNKNOWN = 'unknown';

/** Where a packaged app keeps the digest its helper was built from (scripts/package.mjs writes it beside the app's code). */
const DIGEST_FILE = 'helper-source-digest';

/** The helper's source files, repo-relative and sorted: its package manifest and every Swift file under Sources. */
function sourceFiles(root) {
  const dir = path.join(root, 'native/helper');
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.swift')) out.push(path.relative(dir, p));
    }
  };
  walk(path.join(dir, 'Sources'));
  if (fs.existsSync(path.join(dir, 'Package.resolved'))) out.push('Package.resolved');
  return out.sort();
}

/**
 * A short digest of what the helper is built from: the same sources give the same digest on every machine, any edit changes it.
 * Null when the tree has no helper sources (a packaged app).
 * @param {string} root the repository root
 */
function sourceDigest(root) {
  const dir = path.join(root, 'native/helper');
  if (!fs.existsSync(path.join(dir, 'Package.swift'))) return null;
  const h = crypto.createHash('sha256');
  for (const f of ['Package.swift', ...sourceFiles(root)])
    h.update(`${f}\0`)
      .update(fs.readFileSync(path.join(dir, f)))
      .update('\0');
  return h.digest('hex').slice(0, 16);
}

/**
 * The digest this app expects its helper to carry: the one beside a packaged app's code (UNKNOWN when that is missing), or the
 * checkout's own sources (null without them, which checks nothing).
 * @param {{ packaged?: boolean, repoRoot: string }} o
 */
function expectedDigest({ packaged = false, repoRoot }) {
  try {
    if (packaged) return fs.readFileSync(path.join(repoRoot, DIGEST_FILE), 'utf8').trim() || UNKNOWN;
    return sourceDigest(repoRoot);
  } catch {
    return packaged ? UNKNOWN : null;
  }
}

/**
 * What is wrong with a helper's hello against the expected digest, or null when it matches (or nothing is expected). A hello
 * without a stamp is an older helper and counts as out of date, never as a match.
 * @param {{ sourceDigest?: unknown } | null | undefined} info @param {string | null | undefined} expected
 */
function stampProblem(info, expected) {
  if (!expected) return null;
  if (expected === UNKNOWN) return 'cannot be matched: this app has no record of the helper it ships with';
  if (typeof info?.sourceDigest !== 'string' || !info.sourceDigest) return 'carries no build stamp';
  return info.sourceDigest === expected ? null : 'was built from other sources than this app';
}

module.exports = { UNKNOWN, DIGEST_FILE, sourceDigest, expectedDigest, stampProblem };
