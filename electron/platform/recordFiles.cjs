// The chat store's record files (threads/*.v2) through the Rust core: read at once at startup (store.readRecords, the files in parallel and one reply to parse) and each written whole when committed (store.writeRecord), docs/architecture/rust-core.md §6 step 2.
const { core, requiredCore } = require('./core.cjs');
const { temporarySibling } = require('./fsutil.cjs');
const { isPrivatePath } = require('./privateFiles.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

/**
 * The files in `dir` whose names end in `ext`, sorted as fs.readdirSync lists them, each with its parsed JSON or null
 * when it can't be read or parsed. `error` is set instead when the folder can't be listed.
 * @param {string} dir @param {string} ext
 * @param {{ addon?: ReturnType<typeof core> }} [o]
 * @returns {{ entries: { name: string, record: any }[], error?: undefined } | { entries?: undefined, error: unknown }}
 */
function readRecordFiles(dir, ext, { addon = core() } = {}) {
  try {
    return fromCore(dir, ext, addon);
  } catch (error) {
    return { error };
  }
}

/**
 * The core's reply as entries: `[name, 0, value]` parsed already, `[name, 1, text]` parsed here, `[name, 2]` unread. A
 * reply of null says the folder doesn't exist, which a first start has not made yet.
 */
function fromCore(dir, ext, addon) {
  /** @type {[string, number, any?][] | null} */
  const rows = JSON.parse(String(requiredCore(addon).dispatchSync('store.readRecords', Buffer.from(`${dir}\n${ext}`))));
  if (rows === null) return { error: Object.assign(new Error(`ENOENT: no such folder, scandir '${dir}'`), { code: 'ENOENT' }) };
  return { entries: rows.map(([name, kind, value]) => ({ name, record: kind === 0 ? value : kind === 1 ? parsed(value) : null })) };
}

/** JSON.parse of `text`, or null: an unreadable record is the chat store's to keep as it is. */
function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `text` (a record's JSON) as the whole of `file`, on the disk before this returns: the core writes it to a temporary
 * sibling and renames that over the file, as fsutil's writeAtomic does, so a reader or a crash sees the old file or the
 * new one. The file keeps its permissions, and under the data folder it is owner-only. A failure throws Node's error for
 * the step that failed (`EACCES: permission denied, open '…'`, with its `code`, `syscall` and `path`), and nothing is
 * left behind.
 * @param {string} file @param {string} text
 * @param {{ addon?: ReturnType<typeof core> }} [o]
 */
function writeRecordFile(file, text, { addon = core() } = {}) {
  // no core is the error every core call throws, `coreProblem`'s: nothing else can write the record
  const present = requiredCore(addon);
  const head = JSON.stringify({ file, temp: temporarySibling(file), private: isPrivatePath(file) });
  // encoded once into one buffer: joining the strings first would copy a large record before encoding it
  const at = Buffer.byteLength(head);
  const payload = Buffer.allocUnsafe(at + 1 + Buffer.byteLength(text));
  payload.write(head);
  payload[at] = 0x0a;
  payload.write(text, at + 1);
  try {
    present.dispatchSync('store.writeRecord', payload);
  } catch (error) {
    throw nodeError(error);
  }
}

/**
 * The core's failure as the Error Node's fs threw for it. A core built before the route (a checkout's stale build) says
 * how to rebuild it; any other failure (a panic) comes as it came.
 */
function nodeError(/** @type {unknown} */ error) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'no core route store.writeRecord')
    return new Error(
      'The Rust core predates store.writeRecord, so the chat could not be saved: rebuild it (cargo build --release -p node in core/)',
    );
  const failure = parsed(message);
  if (!isJsonRecord(failure) || typeof failure.message !== 'string') return error;
  // the write's error is the one the caller gets
  if (typeof failure.cleanup === 'string') noteIgnored('remove a temporary file after a failed write', new Error(failure.cleanup));
  const { code, syscall, path, dest } = failure;
  return Object.assign(new Error(failure.message), { code, syscall }, path ? { path } : {}, dest ? { dest } : {});
}

module.exports = { readRecordFiles, writeRecordFile };
