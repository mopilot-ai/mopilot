// One text file of a chat's project folder, read for a phone the way MoMo's Files source reads: relative to the folder, never hidden (bar the allowlist in visible.cjs), never reached through a link that leaves it, size-bounded, text only, and never written.
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { RemoteError } = require('../serviceErrors.cjs');
const { visible } = require('./visible.cjs');

/** A NUL in the first bytes means a binary file. */
const SNIFF = 8 * 1024;
const OUTSIDE = "That file isn't in the project folder.";
const CHANGED = 'That file changed while it was read.';

/** `child` relative to `root`, compared exactly (both are real paths, so the disk's own case), or null when it is outside. */
const relIn = (/** @type {string} */ root, /** @type {string} */ child) => {
  const rel = path.relative(root, child);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
};

/** Bytes a text may take once encoded in a reply (a frame to a phone is 256 KB sealed). */
const REPLY_BUDGET = 100_000;
/** A read is never shortened below this many bytes. */
const SNIFF_MIN = 4;

/** The bytes up to the last whole UTF-8 character, so a read cut short never splits one. */
function wholeChars(/** @type {Buffer} */ buf) {
  let i = buf.length - 1;
  while (i > 0 && i > buf.length - 4 && (buf[i] & 0xc0) === 0x80) i--;
  const lead = buf[i];
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return i + size > buf.length ? buf.subarray(0, i) : buf;
}

/**
 * The real path of `rel` inside `folder`: written without a hidden or climbing name, and still inside the folder, with
 * no hidden name, once links are resolved.
 * @param {string} folder
 * @param {string} rel
 */
async function resolveInside(folder, rel) {
  const written = path.normalize(rel);
  if (!written || written === '.' || path.isAbsolute(written) || written.split(path.sep).includes('..') || !visible(written))
    throw new RemoteError('invalid', OUTSIDE);
  const root = await fs.promises.realpath(folder).catch(() => {
    throw new RemoteError('gone', "This chat's folder isn't there.");
  });
  const target = await fs.promises.realpath(path.join(root, written)).catch(() => {
    throw new RemoteError('gone', "That file isn't there.");
  });
  const inside = relIn(root, target);
  if (inside === null || inside === '' || !visible(inside)) throw new RemoteError('invalid', OUTSIDE);
  return { root, target };
}

/**
 * A text file's contents from `offset`, at most `maxBytes`, ending on a whole character.
 * @param {{ folder: string, path: string, offset: number, maxBytes: number }} q
 */
async function readFileInside({ folder, path: rel, offset, maxBytes }) {
  const { root, target } = await resolveInside(folder, rel);
  const st = await fs.promises.lstat(target);
  if (!st.isFile()) throw new RemoteError('invalid', 'That is a folder, not a file.');
  // no link is followed at the end, and the file opened must be the one checked, still reached by its path
  const fh = await fs.promises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => {
    throw new RemoteError('stale', CHANGED);
  });
  let buf;
  let size;
  try {
    const opened = await fh.stat();
    if (opened.ino !== st.ino || opened.dev !== st.dev) throw new RemoteError('stale', CHANGED);
    if ((await resolveInside(root, rel)).target !== target) throw new RemoteError('stale', CHANGED);
    size = opened.size;
    const sniff = Buffer.alloc(Math.min(SNIFF, size));
    await fh.read(sniff, 0, sniff.length, 0);
    const chunk = Buffer.alloc(Math.max(0, Math.min(maxBytes, size - offset)));
    await fh.read(chunk, 0, chunk.length, offset);
    if (sniff.includes(0) || chunk.includes(0)) throw new RemoteError('invalid', "That isn't a text file, so it wasn't read.");
    buf = offset + chunk.length < size && chunk.length ? wholeChars(chunk) : chunk;
    // escapes and replacement characters can make the text larger than its bytes: shorten it until the reply fits
    while (buf.length > SNIFF_MIN && Buffer.byteLength(JSON.stringify(buf.toString('utf8'))) > REPLY_BUDGET)
      buf = wholeChars(buf.subarray(0, Math.floor(buf.length * 0.7)));
  } finally {
    await fh.close();
  }
  return {
    path: path.relative(root, target).split(path.sep).join('/'),
    text: buf.toString('utf8'),
    size,
    offset,
    bytes: buf.length,
    truncated: offset + buf.length < size,
  };
}

module.exports = { readFileInside, wholeChars, MAX_SNIFF: SNIFF };
