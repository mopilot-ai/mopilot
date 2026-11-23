// The Node a Host runs on: one pinned official build per platform, its SHA-256 taken from nodejs.org's signed SHASUMS256.txt.asc, fetched once into the app's cache and checked before it is uploaded to a machine.
const crypto = require('node:crypto');
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { writeAtomic } = require('../platform/fsutil.cjs');

/**
 * The pinned release. To move it: download `https://nodejs.org/dist/<version>/SHASUMS256.txt.asc`, verify its signature against
 * the keys in github.com/nodejs/release-keys (`gpgv --keyring <kbx> SHASUMS256.txt.asc`), and copy the four `.tar.gz` lines below.
 */
const NODE_VERSION = 'v24.22.2';
/** @type {Record<string, string>} */
const SHA256 = {
  'darwin-arm64': 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
  'darwin-x64': 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
  'linux-arm64': '95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2',
  'linux-x64': '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9',
};
/** `uname -s` and `uname -m` to the name Node's builds use. */
const PLATFORMS = /** @type {Record<string, string>} */ ({
  'Darwin arm64': 'darwin-arm64',
  'Darwin x86_64': 'darwin-x64',
  'Linux x86_64': 'linux-x64',
  'Linux aarch64': 'linux-arm64',
  'Linux arm64': 'linux-arm64',
});

/** The build for what `uname -sm` printed, or null for a system Node publishes no build of. @param {string} uname */
function nodeBuild(uname) {
  const key = PLATFORMS[uname.trim().split(/\s+/).slice(0, 2).join(' ')];
  if (!key) return null;
  const name = `node-${NODE_VERSION}-${key}`;
  const file = `${name}.tar.gz`;
  return { version: NODE_VERSION, key, name, file, sha256: SHA256[key], url: `https://nodejs.org/dist/${NODE_VERSION}/${file}` };
}

/** @param {string} url @returns {Promise<Buffer>} */
async function fetchBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`nodejs.org answered ${res.status}.`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The app's copy of each build, fetched on first use; a file is used only while its bytes match the pinned checksum.
 * @param {object} o
 * @param {string} o.dir where the builds are kept
 * @param {(url: string) => Promise<Buffer>} [o.download]
 */
function createRuntimeCache({ dir, download = fetchBytes }) {
  /** One fetch per build at a time: a second request joins it. @type {Map<string, Promise<Buffer>>} */
  const inflight = new Map();
  const matches = (/** @type {Buffer} */ bytes, /** @type {string} */ sha) =>
    crypto.createHash('sha256').update(bytes).digest('hex') === sha;

  /** @param {NonNullable<ReturnType<typeof nodeBuild>>} build */
  async function fetchBuild(build) {
    const file = path.join(dir, build.file);
    if (fs.existsSync(file)) {
      const kept = fs.readFileSync(file);
      if (matches(kept, build.sha256)) return kept;
    }
    const bytes = await download(build.url);
    if (!matches(bytes, build.sha256)) throw new Error(`The Node download does not match its checksum (${build.file}).`);
    writeAtomic(file, bytes, fs, 0o600);
    return bytes;
  }

  return {
    /** The build's bytes, checked; rejects when it cannot be had. @param {NonNullable<ReturnType<typeof nodeBuild>>} build @returns {Promise<Buffer>} */
    get(build) {
      const running = inflight.get(build.key);
      if (running) return running;
      const done = fetchBuild(build).finally(() => inflight.delete(build.key));
      inflight.set(build.key, done);
      return done;
    },
  };
}

module.exports = { nodeBuild, createRuntimeCache, NODE_VERSION };
