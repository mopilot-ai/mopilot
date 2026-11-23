// Small filesystem helpers shared by the main-process modules.
const fs = require('node:fs');
const path = require('node:path');
const { syncFolder } = require('./folderSync.cjs');
const { withCleanup, withAsyncCleanup } = require('./cleanup.cjs');
const crypto = require('node:crypto');
const { noteIgnored } = require('../ignored.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { isPrivatePath, ownerOnly, PRIVATE_DIR, PRIVATE_FILE } = require('./privateFiles.cjs');

/** A short sibling name keeps valid destination basenames below the filesystem component limit. */
function temporarySibling(file) {
  return path.join(path.dirname(file), `.mopilot-${process.pid}-${crypto.randomUUID()}.tmp`);
}

/**
 * Atomically write a file only the current user can read (0600).
 * @param {string} file @param {string | Buffer} data
 * @param {typeof fs} [fileFs] the fs to write with (tests pass a fake)
 * @param {{ durable?: boolean }} [opts] durable: synced to the disk, with its folder, before this returns
 */
function writePrivate(file, data, fileFs = fs, opts = {}) {
  const durable = opts.durable === true;
  const tmp = temporarySibling(file);
  const fd = fileFs.openSync(tmp, 'wx', 0o600);
  return withCleanup(
    () => {
      withCleanup(
        () => {
          fileFs.writeFileSync(fd, data);
          if (durable) fileFs.fsyncSync(fd);
        },
        () => fileFs.closeSync(fd),
      );
      fileFs.renameSync(tmp, file);
      if (durable) syncFolder(path.dirname(file));
    },
    () => fileFs.rmSync(tmp, { force: true }),
  );
}

/** Write via a temp file and rename, preserving an existing file's permissions and whole contents. In the data
 * folder (privateFiles.cjs keepPrivate) the file and the folders made for it are owner-only, whatever they were.
 * @param {number | undefined} [newMode] permission bits for a newly restored file; existing files keep theirs
 */
function writeAtomic(file, data, fileFs = fs, newMode = undefined) {
  const owned = isPrivatePath(file);
  const kept = fileFs.statSync(file, { throwIfNoEntry: false })?.mode ?? newMode ?? (owned ? PRIVATE_FILE : undefined);
  const mode = owned && kept !== undefined ? ownerOnly(kept) : kept;
  fileFs.mkdirSync(path.dirname(file), { recursive: true, ...(owned ? { mode: PRIVATE_DIR } : {}) });
  const tmp = temporarySibling(file);
  try {
    fileFs.writeFileSync(tmp, data, { mode: mode === undefined ? 0o666 : mode & 0o777 });
    // Creation applies umask; restore the original access bits before publishing the replacement.
    if (mode !== undefined) fileFs.chmodSync(tmp, mode & 0o777);
    fileFs.renameSync(tmp, file);
  } catch (e) {
    try {
      fileFs.rmSync(tmp, { force: true });
    } catch (error) {
      // the write or rename error is the one the caller gets
      noteIgnored('remove a temporary file after a failed write', error);
    }
    throw e;
  }
}

/**
 * writeAtomic with the bytes written off the main thread: the temporary file is written asynchronously, then published by a
 * synchronous rename, and only while `stillCurrent()` holds, so a newer synchronous write (a quit flush) is never replaced
 * by this older one. Returns whether the file was published.
 * @param {string} file @param {string | Buffer} data
 * @param {() => boolean} [stillCurrent]
 * @param {number | undefined} [newMode] permission bits for a file that is new (as for writeAtomic)
 */
async function writeAtomicAsync(file, data, stillCurrent = () => true, newMode = undefined) {
  const owned = isPrivatePath(file);
  const info = await fs.promises.stat(file).catch((error) => {
    // a file that is not there yet takes the mode asked for
    noteIgnored('read the mode of a state file', error, ['ENOENT']);
    return null;
  });
  const kept = info?.mode ?? newMode ?? (owned ? PRIVATE_FILE : undefined);
  const mode = owned && kept !== undefined ? ownerOnly(kept) : kept;
  await fs.promises.mkdir(path.dirname(file), { recursive: true, ...(owned ? { mode: PRIVATE_DIR } : {}) });
  const tmp = temporarySibling(file);
  try {
    await fs.promises.writeFile(tmp, data, { mode: mode === undefined ? 0o666 : mode & 0o777 });
    if (mode !== undefined) await fs.promises.chmod(tmp, mode & 0o777);
    if (!stillCurrent()) {
      fs.rmSync(tmp, { force: true });
      return false;
    }
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (error) {
      // the write or rename error is the one the caller gets
      noteIgnored('remove a temporary file after a failed write', error);
    }
    throw e;
  }
}

/**
 * The parsed JSON in `file`, or `fallback` when it is missing or unreadable.
 * @param {string} file
 * @param {any} [fallback]
 * @returns {any}
 */
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * readJson without blocking: the parsed JSON in `file`, or `fallback` when it is missing or unreadable.
 * @param {string} file
 * @param {any} [fallback]
 * @returns {Promise<any>}
 */
async function readJsonAsync(file, fallback = null) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** A JSON object record, or the explicit fallback for missing, malformed or non-record roots.
 * @param {string} file
 * @param {any} [fallback]
 * @returns {any}
 */
function readJsonRecord(file, fallback = null) {
  const value = readJson(file);
  return isJsonRecord(value) ? value : fallback;
}

/** A retained recovery copy must be a regular file, never a directory or symbolic link. */
function hasSavedCopy(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch (error) {
    noteIgnored('check a retained recovery copy', error);
    return false;
  }
}

/**
 * A state file the app writes back (accounts, projects): the parsed JSON, or null when there is none yet
 * (ENOENT) or it can't be read. The caller then starts from its defaults and saves over the file, so an
 * unreadable one is first copied to `<file>.unreadable` (what it held is not lost) and the failure recorded.
 * A copy already there is kept: it is the oldest, from before the defaults were saved over the file.
 * @param {string} file
 * @param {string} what what the file holds, for the record, e.g. 'the Codex accounts'
 * @param {((data: any) => boolean) | null} [valid] reject unusable parsed shapes through the same backup path
 * @returns {any}
 */
function readStateFile(file, what, valid = isJsonRecord) {
  const { data, error } = readStoreFile(file, what, valid);
  // Default-writing callers need a verified recovery copy; read-only stores retain their error instead.
  if (error && !hasSavedCopy(`${file}.unreadable`)) throw error;
  return data;
}

/**
 * readStateFile for a store that must not save over what it couldn't read (saved logins, bookmarks): `data` is the
 * parsed JSON or null, and `error` is set when the file is there but couldn't be read or parsed (it is copied to
 * `<file>.unreadable` and recorded as readStateFile does). A missing file is no error: there is nothing to keep.
 * @param {string} file
 * @param {string} what
 * @param {((data: any) => boolean) | null} [valid]
 * @returns {{ data: any, error: Error | null }}
 */
function readStoreFile(file, what, valid = null) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (valid && !valid(data)) throw new Error(`Invalid saved state for ${what}`);
    return { data, error: null };
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return { data: null, error: null };
    noteIgnored(`read ${what}`, error);
    try {
      fs.copyFileSync(file, `${file}.unreadable`, fs.constants.COPYFILE_EXCL);
    } catch (copyError) {
      // EEXIST: an earlier copy is kept
      noteIgnored(`keep a copy of ${what} that could not be read`, copyError, ['EEXIST']);
    }
    // Filesystem, parse and validation failures are reported to the caller.
    return { data: null, error: /** @type {Error} */ (error) };
  }
}

/** A file's time and size as one string ('none' when it is not there): equal stamps mean a reader need not read it again. @param {string} file */
function fileStamp(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  return stat ? `${stat.mtimeMs}:${stat.size}` : 'none';
}

/** Removes files that may not exist. @param {...string} files */
function removeFiles(...files) {
  for (const f of files) fs.rmSync(f, { force: true });
}

module.exports = {
  temporarySibling,
  removeFiles,
  fileStamp,
  writePrivate,
  writeAtomic,
  writeAtomicAsync,
  readJson,
  readJsonAsync,
  readJsonRecord,
  readStateFile,
  readStoreFile,
  withAsyncCleanup,
};
