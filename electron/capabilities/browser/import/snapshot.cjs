// Reading another browser's files safely: a database is copied (with its -wal/-shm/-journal) into a private temp folder and opened read-only there, so a running browser's file is never locked or changed; the copy is removed afterwards.
const { fs } = require('../../../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { ImportError, classify } = require('./errors.cjs');
const { noteIgnored } = require('../../../ignored.cjs');

/** Largest file copied; a bigger one is refused rather than filling the disk or the memory. */
const MAX_BYTES = 512 * 1024 * 1024;
const SIDECARS = ['-wal', '-shm', '-journal'];

/** @param {import('node:fs').Stats} st */
function checkSize(st) {
  if (st.size > MAX_BYTES) throw new ImportError('too_large', 'The browser data file is too large.');
}

const openDb = (file) => new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });

/**
 * Copies `file` to a private temp folder, opens the copy read-only and passes the database to `fn`; the copy goes
 * when `fn` finishes. A symlink, a missing file, a blocked read or an oversized file reject with an ImportError.
 * @template T
 * @param {string} file
 * @param {(db: import('node:sqlite').DatabaseSync) => T | Promise<T>} fn
 * @param {{ fs?: typeof import('node:fs'), tmpRoot?: string, open?: (file: string) => any }} [o]
 * @returns {Promise<T>}
 */
async function withDatabase(file, fn, o = {}) {
  const f = o.fs ?? fs;
  const open = o.open ?? openDb;
  /** @type {string | null} */
  let dir = null;
  /** @type {import('node:sqlite').DatabaseSync | null} */
  let db = null;
  /** @type {T} */
  let result;
  try {
    const st = f.lstatSync(file);
    if (st.isSymbolicLink()) throw new ImportError('read_failed', 'Symlinked browser data files are not read.');
    checkSize(st);
    dir = f.mkdtempSync(path.join(o.tmpRoot ?? os.tmpdir(), 'mopilot-import-'));
    f.chmodSync(dir, 0o700);
    const copy = path.join(dir, 'db');
    f.copyFileSync(file, copy);
    for (const suffix of SIDECARS) {
      try {
        const sidecar = f.lstatSync(file + suffix);
        if (sidecar.isSymbolicLink()) continue;
        checkSize(sidecar);
        f.copyFileSync(file + suffix, copy + suffix);
      } catch (error) {
        if (error instanceof ImportError) throw error;
        // most databases have no sidecar (ENOENT); an unreadable one only makes the copy older
        noteIgnored('copy a browser database sidecar', error, ['ENOENT']);
      }
    }
    const opened = open(copy);
    db = opened;
    result = await fn(opened);
  } catch (error) {
    throw classify(error);
  } finally {
    try {
      db?.close();
    } catch (error) {
      noteIgnored('close a copied browser database', error);
    }
    if (dir) {
      try {
        f.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        noteIgnored('remove a copied browser database', error);
      }
    }
  }
  return result;
}

/**
 * The text of a file (a bookmarks list), refusing symlinks and oversized files.
 * @param {string} file
 * @param {{ fs?: typeof import('node:fs') }} [o]
 */
async function readTextFile(file, o = {}) {
  const f = o.fs ?? fs;
  try {
    const st = f.lstatSync(file);
    if (st.isSymbolicLink()) throw new ImportError('read_failed', 'Symlinked browser data files are not read.');
    checkSize(st);
    return f.readFileSync(file, 'utf8');
  } catch (error) {
    throw classify(error);
  }
}

module.exports = { MAX_BYTES, withDatabase, readTextFile };
