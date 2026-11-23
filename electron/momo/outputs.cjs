// MoMo's Outputs (#2139): the text files MoMo saves with momo_save_file, kept in <momo dir>/outputs (owner-only folder, 0600 files, plain so other apps can open them) and listed by a sealed index <momo dir>/outputs.json (sealedFile.cjs). The only file MoMo can create is a new one in that folder: a bare sanitized name (no path, no leading dot, no control characters, NFC, 100 characters), a text type from a short allowlist, UTF-8 content of at most 1 MB, and at most 50 MB and 200 files in all, all checked inside the store's one locked turn so parallel saves cannot jointly pass a cap. A csv or tsv cell that would run as a formula in a spreadsheet is neutralized on write. The index is written with the file (a save whose index write fails removes its file again); sweep() removes only the temporary files an interrupted save leaves, never another file, since the files are plain on purpose and a user may keep their own there; an entry whose file is gone reads as `gone`. Reset MoMo erases both.
const crypto = require('node:crypto');
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { SealedJson } = require('../gateway/sealedFile.cjs');
const { writeDurable } = require('../gateway/durableWrite.cjs');
const { noteIgnored } = require('../ignored.cjs');

const INDEX = 'outputs.json';
const FOLDER = 'outputs';
/** The types MoMo can save: text a model can really write. */
const TEXT_TYPES = Object.freeze(['txt', 'md', 'csv', 'tsv', 'json']);
/** Every type a file in the folder can have: the text types, and xlsx, which only main builds (momo_save_sheet). */
const TYPES = Object.freeze([...TEXT_TYPES, 'xlsx']);
/** The name writeDurable gives a file while it is being written. */
const TEMP = /^\..+-\d+-[0-9a-f-]{36}\.tmp$/;
const MAX_FILE = 1_000_000;
const MAX_TOTAL = 50_000_000;
const MAX_FILES = 200;
const MAX_NAME = 100;
const MAX_NOTE = 120;

/** What a refusal is told to MoMo (the code says why; the text is for the model). */
const TEXT = Object.freeze({
  bad_name:
    'The name must be a plain file name like notes.md or budget.xlsx: no folders, slashes, colons, control or text-direction characters, not starting with a dot, at most 100 characters.',
  bad_type: `momo_save_file saves only these file types: ${TEXT_TYPES.join(', ')}. For a spreadsheet call momo_save_sheet with rows.`,
  bad_content: 'The content must be non-empty text (no binary data).',
  bad_json: 'A .json file must contain valid JSON.',
  too_large: 'The file is larger than 1 MB.',
  full: 'MoMo has no room for more files; tell the user they can delete some in the Outputs list.',
  unavailable: "MoMo's files can't be saved right now (encryption is unavailable).",
});

class OutputError extends Error {
  /** @param {keyof typeof TEXT} code */
  constructor(code) {
    super(TEXT[code]);
    this.code = code;
  }
}

/**
 * @typedef {{ id: string, name: string, type: string, size: number, at: number, chatId: string, note: string, fromPrivate: boolean }} Output
 */

const isOutput = (/** @type {any} */ o) =>
  !!o &&
  typeof o.id === 'string' &&
  typeof o.name === 'string' &&
  nameOf(o.name) === o.name &&
  Number.isFinite(o.size) &&
  Number.isFinite(o.at) &&
  typeof o.chatId === 'string' &&
  typeof o.note === 'string' &&
  typeof o.fromPrivate === 'boolean';

const shapeOf = (/** @type {unknown} */ v) => {
  const all = /** @type {any} */ (v)?.files;
  return { files: /** @type {Output[]} */ ((Array.isArray(all) ? all : []).filter(isOutput).map((o) => ({ ...o, type: extOf(o.name) }))) };
};

const extOf = (/** @type {string} */ name) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
/** The folded form two names are compared by (a case-insensitive disk would treat them as one). */
const fold = (/** @type {string} */ name) => name.normalize('NFC').toLowerCase();

/**
 * The name as it will be stored, or null when it is not a plain file name of an allowed type.
 * @param {unknown} raw
 * @returns {string | null}
 */
function nameOf(raw) {
  const name = plainName(raw);
  return name && TYPES.includes(extOf(name)) ? name : null;
}

/** The name as a plain file name with an extension (any type), NFC and trimmed, or null. @param {unknown} raw @returns {string | null} */
function plainName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim();
  if (
    !name ||
    name.length > MAX_NAME ||
    name.startsWith('.') ||
    /[\\/:\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name) ||
    name.endsWith('.')
  )
    return null;
  return name.lastIndexOf('.') < 1 ? null : name;
}

/** Whether a cell would run as a formula: it starts with = + - @ (or a tab or CR) and is not a plain number. */
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const runs = (/** @type {string} */ v) => /^[=+\-@\t\r]/.test(v) && !NUMBER.test(v);

/**
 * Text of a csv/tsv with every cell that would run as a formula (=HYPERLINK(...), =cmd|..., +, -, @) given a leading '
 * (inside the quotes for a quoted cell), so Excel and Numbers show it as text. Plain numbers like -3.5 are kept.
 * @param {string} text
 * @param {string} delim
 * @returns {{ text: string, changed: number }}
 */
function neutralize(text, delim) {
  let out = '';
  let changed = 0;
  let i = 0;
  const n = text.length;
  const ends = (/** @type {string} */ c) => c === delim || c === '\n' || c === '\r';
  for (;;) {
    const start = i;
    let value = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] !== '"') break;
          value += '"';
          i += 2;
          continue;
        }
        value += text[i++];
      }
      if (i < n) i++;
      while (i < n && !ends(/** @type {string} */ (text[i]))) i++;
    } else {
      while (i < n && !ends(/** @type {string} */ (text[i]))) value += text[i++];
    }
    let raw = text.slice(start, i);
    if (runs(value)) {
      raw = quoted ? `"'${raw.slice(1)}` : `'${raw}`;
      changed++;
    }
    out += raw;
    if (i >= n) break;
    if (text[i] === '\r' && text[i + 1] === '\n') {
      out += '\r\n';
      i += 2;
    } else out += text[i++];
  }
  return { text: out, changed };
}

class OutputsStore {
  /** @param {{ dir: string, safeStorage: any, now?: () => number, newId?: () => string }} o */
  constructor({ dir, safeStorage, now = Date.now, newId = () => crypto.randomUUID() }) {
    this.dir = path.join(dir, FOLDER);
    this.now = now;
    this.newId = newId;
    this.index = new SealedJson({ file: path.join(dir, INDEX), safeStorage, now, shape: shapeOf });
    /** @type {Set<() => void>} */
    this.listeners = new Set();
  }

  /** Calls `fn` after a file is saved, removed or the store erased; returns the unsubscribe. */
  onChange(/** @type {() => void} */ fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #changed() {
    for (const fn of this.listeners) fn();
  }

  #folder() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
  }

  /** Every kept file, newest first, with `gone` when the file is no longer on the disk. Throws when the index can't be read. */
  list() {
    return [...this.index.read().files].reverse().map((o) => ({ ...o, gone: !this.#present(o.name) }));
  }

  #present(/** @type {string} */ name) {
    try {
      return fs.lstatSync(path.join(this.dir, name)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Checks and normalizes a file before anything is written; throws an OutputError when it must be refused.
   * @param {{ name: unknown, content?: unknown, bytes?: Buffer, note?: unknown }} a bytes: a file main built (xlsx), never from the model
   */
  prepare({ name, content, bytes: built, note }) {
    const plain = plainName(name);
    if (!plain) throw new OutputError('bad_name');
    const wanted = nameOf(plain);
    if (!wanted) throw new OutputError('bad_type');
    const type = extOf(wanted);
    const why = (typeof note === 'string' ? note : '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
    if (built !== undefined) {
      if (type !== 'xlsx' || !Buffer.isBuffer(built)) throw new OutputError('bad_content');
      if (built.length > MAX_FILE) throw new OutputError('too_large');
      return { wanted, type, text: built, bytes: built.length, why, changed: 0 };
    }
    if (type === 'xlsx') throw new OutputError('bad_type');
    if (typeof content !== 'string' || !content || content.includes('\u0000') || Buffer.from(content, 'utf8').toString('utf8') !== content)
      throw new OutputError('bad_content');
    if (type === 'json') {
      try {
        JSON.parse(content);
      } catch {
        throw new OutputError('bad_json');
      }
    }
    const fixed = type === 'csv' || type === 'tsv' ? neutralize(content, type === 'tsv' ? '\t' : ',') : { text: content, changed: 0 };
    const bytes = Buffer.byteLength(fixed.text, 'utf8');
    if (bytes > MAX_FILE) throw new OutputError('too_large');
    return { wanted, type, text: fixed.text, bytes, why, changed: fixed.changed };
  }

  /**
   * Saves a new file. Throws an OutputError, nothing written, when it must be refused.
   * @param {{ name: unknown, content?: unknown, bytes?: Buffer, note?: unknown, chatId: string, fromPrivate?: boolean }} a
   * @returns {Promise<Output & { neutralized: number }>}
   */
  async save({ chatId, fromPrivate = false, ...given }) {
    const { wanted, type, text, bytes, why, changed } = this.prepare(given);
    /** the file this save wrote, until its entry is on the disk */
    let made = '';
    return this.index
      .change(async (v) => {
        if (v.files.length >= MAX_FILES || v.files.reduce((sum, o) => sum + o.size, 0) + bytes > MAX_TOTAL) throw new OutputError('full');
        this.#folder();
        const taken = new Set(v.files.map((o) => fold(o.name)));
        const dot = wanted.lastIndexOf('.');
        let stored = wanted;
        for (let n = 2; taken.has(fold(stored)) || this.#exists(stored); n++) {
          const suffix = ` (${n})`;
          stored = `${wanted.slice(0, Math.min(dot, MAX_NAME - suffix.length - (wanted.length - dot)))}${suffix}${wanted.slice(dot)}`;
        }
        await writeDurable(fs.promises, path.join(this.dir, stored), text);
        made = stored;
        /** @type {Output} */
        const entry = { id: this.newId(), name: stored, type, size: bytes, at: this.now(), chatId, note: why, fromPrivate };
        v.files.push(entry);
        return { ...entry, neutralized: changed };
      })
      .then(
        (out) => {
          this.#changed();
          return out;
        },
        async (error) => {
          // the index could not be written (or the store was erased): the file would be an orphan nobody lists
          if (made)
            await fs.promises.rm(path.join(this.dir, made), { force: true }).catch((e) => noteIgnored('remove an unlisted MoMo file', e));
          throw error;
        },
      );
  }

  #exists(/** @type {string} */ name) {
    try {
      fs.lstatSync(path.join(this.dir, name));
      return true;
    } catch {
      return false;
    }
  }

  /** The real path of a kept file for opening or copying, or null when it has no entry, is gone, is not a plain file in the folder. */
  pathOf(/** @type {string} */ id) {
    const o = this.index.read().files.find((f) => f.id === id);
    if (!o) return null;
    try {
      const file = path.join(this.dir, o.name);
      if (!fs.lstatSync(file).isFile()) return null;
      return fs.realpathSync(file);
    } catch {
      return null;
    }
  }

  /** Deletes one kept file and its entry; false when there is no such entry. */
  async remove(/** @type {string} */ id) {
    const done = await this.index.change(async (v) => {
      const at = v.files.findIndex((f) => f.id === id);
      if (at < 0) return false;
      const [o] = v.files.splice(at, 1);
      await fs.promises.rm(path.join(this.dir, /** @type {Output} */ (o).name), { force: true });
      return true;
    });
    if (done) this.#changed();
    return done;
  }

  /**
   * Startup: removes the temporary files a save a quit interrupted left (writeDurable's own `.name-pid-uuid.tmp`), and nothing
   * else: the files are plain, a user may keep their own in the folder, and a damaged index reads as empty, so "not in the
   * index" never means "not wanted".
   */
  async sweep() {
    if (!fs.existsSync(this.dir)) return;
    await this.index.change(async () => {
      for (const name of await fs.promises.readdir(this.dir))
        if (TEMP.test(name)) await fs.promises.rm(path.join(this.dir, name), { force: true });
    });
  }

  /** Reset MoMo: deletes the index and the folder. */
  async erase() {
    await this.index.erase();
    await fs.promises.rm(this.dir, { recursive: true, force: true });
    this.#changed();
  }
}

module.exports = { OutputsStore, OutputError, neutralize, nameOf, TYPES, TEXT_TYPES, MAX_FILE, MAX_TOTAL, MAX_FILES, MAX_NAME, MAX_NOTE };
