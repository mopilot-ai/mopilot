// A path a reply names (in inline code or a local link), resolved to the file or folder that is there: "~" is the home folder, a relative path is in the chat's folder.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { noteIgnored } = require('../ignored.cjs');

/** Longer than any real path: text this long is prose, not a path to stat. */
const MAX_PATH = 4096;
/** A stat that hasn't answered by now (a stalled network mount) reads as nothing there, so no link waits on it. */
const STAT_TIMEOUT_MS = 2000;

/**
 * The absolute path and kind of what `text` names, or null when nothing is there (or it can't be read, or it is
 * neither a file nor a folder). A relative path needs the chat's own absolute folder.
 * @param {unknown} text
 * @param {unknown} cwd
 * @param {string} [home]
 * @param {{ stat?: (p: string) => Promise<import('node:fs').Stats>; timeoutMs?: number }} [deps]
 * @returns {Promise<{ path: string; kind: 'file' | 'dir' } | null>}
 */
async function resolveMessagePath(text, cwd, home = os.homedir(), { stat = fs.promises.stat, timeoutMs = STAT_TIMEOUT_MS } = {}) {
  if (typeof text !== 'string' || !text || text.length > MAX_PATH || text.includes('\0')) return null;
  let p;
  if (/^~(?=$|[\\/])/.test(text)) p = path.join(home, text.slice(1));
  else if (path.isAbsolute(text)) p = text;
  else if (typeof cwd === 'string' && path.isAbsolute(cwd)) p = path.resolve(cwd, text);
  else return null;
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs, null);
  });
  /** @type {import('node:fs').Stats | null} */
  let found = null;
  try {
    found = await Promise.race([stat(p), late]);
  } catch (error) {
    // nothing there for a link to open; a missing path is the normal answer, other failures are recorded
    noteIgnored('look up a path a reply names', error, ['ENOENT', 'ENOTDIR']);
  }
  clearTimeout(timer);
  if (found?.isFile()) return { path: path.normalize(p), kind: 'file' };
  if (found?.isDirectory()) return { path: path.normalize(p).replace(/(.)[\\/]+$/, '$1'), kind: 'dir' };
  return null;
}

module.exports = { resolveMessagePath, MAX_PATH, STAT_TIMEOUT_MS };
