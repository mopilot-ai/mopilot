// A free name for a download, the way Chromium picks one: "report.pdf" → "report (1).pdf", "report (2).pdf"…
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');

/**
 * A file name's extension as Chromium counts it (base::FilePath::Extension): a compression suffix it knows after a
 * short extension is one extension, so "archive.tar.gz" becomes "archive (1).tar.gz", not "archive.tar (1).gz".
 */
function extensionOf(file) {
  const last = path.extname(file);
  if (!/^\.(?:gz|xz|bz2|z|bz)$/i.test(last)) return last;
  const before = path.extname(file.slice(0, -last.length));
  return /^\.[^.]{1,4}$/.test(before) && file.length > before.length + last.length ? before + last : last;
}

/** `taken(p)`: whether a path is in use (on disk, or by a download still running). */
function uniqueDownloadPath(dir, name, taken) {
  const file = path.basename(name || '') || 'download';
  const ext = extensionOf(file);
  const stem = ext ? file.slice(0, -ext.length) : file;
  let p = path.join(dir, file);
  for (let i = 1; taken(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}

// paths of downloads still running, in every folder: their files may not exist yet
const saving = new Set();

const inUse = (p) => saving.has(p) || fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;

/** A free path for a download, not held: what a save sheet proposes (the user may pick another, or cancel). */
function freeDownloadPath(dir, name) {
  return uniqueDownloadPath(dir, name, inUse);
}

/**
 * A free path for a download starting now, held until `item` (an Electron DownloadItem) is done, so two
 * downloads of one name at once get two files.
 */
function reserveDownloadPath(dir, name, item) {
  const file = uniqueDownloadPath(dir, name, inUse);
  saving.add(file);
  item.once('done', () => saving.delete(file));
  return file;
}

module.exports = { uniqueDownloadPath, freeDownloadPath, reserveDownloadPath };
