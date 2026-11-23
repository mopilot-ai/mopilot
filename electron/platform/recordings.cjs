// Dictation recordings (Settings → Voice & dictation): the last 20 clips and what each said, kept on this device by the window's Dictate (ipc/files.cjs) and Chrome's side panel's (app/chromePanelDictate.cjs). Reads don't block the main process; saves go one at a time.
const path = require('node:path');
const fs = require('node:fs');
const { writeAtomic } = require('./fsutil.cjs');
const { parseJsonRecord } = require('../../shared/jsonRecord.mjs');
const { filenameSequence, compareFilenameSequences } = require('../../shared/filenameSequence.mjs');

/** How many clips are kept. */
const KEEP = 20;

/** The callers already selected .json metadata; retain any earlier occurrence in its clip identity. @param {string} file */
const recordingId = (file) => file.slice(0, -'.json'.length);

/** Only an absent recording is empty; failed directory, metadata and clip reads remain visible to callers.
 * @template T
 * @param {() => Promise<T>} read
 * @param {T} missing
 * @returns {Promise<T>}
 */
async function readRecordingIfPresent(read, missing) {
  try {
    return await read();
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return missing;
    throw error;
  }
}

/** @param {() => string} recDir the folder, read when used (the app's user data) */
function createRecordings(recDir) {
  /** Each save picks the next id from the folder, so two at once would pick the same one: they go one at a time. */
  let saving = Promise.resolve();

  async function saveNow(/** @type {Uint8Array} */ bytes, /** @type {string} */ text) {
    await fs.promises.mkdir(recDir(), { recursive: true });
    const at = Date.now();
    let id = BigInt(at);
    for (const name of await fs.promises.readdir(recDir())) {
      if (/\.(?:json|webm)$/.test(name)) {
        const next = filenameSequence(name) + 1n;
        if (next > id) id = next;
      }
    }
    // the audio first, then its entry: an entry the list shows always has its whole clip
    writeAtomic(path.join(recDir(), id + '.webm'), Buffer.from(bytes));
    writeAtomic(path.join(recDir(), id + '.json'), JSON.stringify({ text, at }));
    const all = (await fs.promises.readdir(recDir())).filter((f) => f.endsWith('.json')).sort(compareFilenameSequences);
    for (const f of all.slice(0, Math.max(0, all.length - KEEP))) {
      fs.rmSync(path.join(recDir(), f), { force: true });
      fs.rmSync(path.join(recDir(), recordingId(f) + '.webm'), { force: true });
    }
  }

  return {
    /** A clip (webm) and what it said; the oldest beyond the last 20 go. */
    save(/** @type {Uint8Array} */ bytes, /** @type {unknown} */ text) {
      if (typeof text !== 'string') return Promise.reject(new TypeError('Recording text must be a string'));
      const run = saving.then(() => saveNow(bytes, text));
      saving = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    /** The clips kept, the newest first. */
    async list() {
      const names = (await readRecordingIfPresent(() => fs.promises.readdir(recDir()), /** @type {string[]} */ ([])))
        .filter((f) => f.endsWith('.json'))
        .sort(compareFilenameSequences)
        .reverse();
      const entries = await Promise.all(
        names.map(async (f) => {
          // Malformed legacy JSON hides only its own entry; an I/O failure is not an empty history.
          const text = await readRecordingIfPresent(() => fs.promises.readFile(path.join(recDir(), f), 'utf8'), null);
          if (text === null) return [];
          const parsed = parseJsonRecord(text);
          if (!parsed.ok) return [];
          const entry = parsed.record;
          if (typeof entry.text !== 'string' || typeof entry.at !== 'number' || !Number.isFinite(new Date(entry.at).getTime())) return [];
          // The file owns the clip identity; metadata contributes only validated display fields.
          return [{ id: recordingId(f), text: entry.text, at: entry.at }];
        }),
      );
      return entries.flat();
    },
    /** A clip as a data: URL, or null when it's gone. */
    async read(/** @type {unknown} */ id) {
      const f = path.join(recDir(), path.basename(String(id)) + '.webm');
      const clip = await readRecordingIfPresent(() => fs.promises.readFile(f), null);
      return clip === null ? null : 'data:audio/webm;base64,' + clip.toString('base64');
    },
    clear() {
      fs.rmSync(recDir(), { recursive: true, force: true });
    },
  };
}

module.exports = { createRecordings };
