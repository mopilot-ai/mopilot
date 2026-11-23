// MoMo's Files source (#2139 P2): only folders the user added in Settings, each inside their home folder (never home itself, ~/Library or a hidden folder); MoMo lists a folder and reads a text file in one, size-bounded, never a hidden name and never outside an added folder (symbolic links are resolved first). Files are current state, so the connect date floors nothing here. Each read is decided and audited by the hub; nothing is ever written.
const { fs: nodeFs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { SourceError } = require('./hub.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** The most entries one listing returns. */
const MAX_ENTRIES = 500;
/** The most bytes one read returns, and how many it returns unless asked. */
const MAX_READ = 256 * 1024;
const DEFAULT_READ = 64 * 1024;
/** A NUL in the first bytes means a binary file, which is not read. */
const SNIFF = 8 * 1024;

const hidden = (/** @type {string} */ rel) => rel.split(path.sep).some((seg) => seg.startsWith('.'));
/** `child` relative to `root`, compared without case (macOS volumes ignore it by default), or null when it is outside. */
const relIn = (/** @type {string} */ root, /** @type {string} */ child) => {
  const rel = path.relative(root.toLowerCase(), child.toLowerCase());
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
};
const changed = (/** @type {string} */ p) => new SourceError(`${p} changed while it was read, so it wasn't read`, 'outside');

/**
 * The bytes of `buf` up to the last whole UTF-8 character, so a read cut short never splits one (the next read starts
 * where this one ends).
 * @param {Buffer} buf
 */
function wholeChars(buf) {
  let i = buf.length - 1;
  // step back over continuation bytes (10xxxxxx) to the start of the last character
  while (i > 0 && i > buf.length - 4 && (buf[i] & 0xc0) === 0x80) i--;
  const lead = buf[i];
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return i + size > buf.length ? buf.subarray(0, i) : buf;
}

/**
 * @param {{ hub: InstanceType<typeof import('./hub.cjs').SourcesHub>, home?: string, fs?: typeof nodeFs }} o
 */
function filesSource({ hub, home = os.homedir(), fs = nodeFs }) {
  /** @type {string | null} */
  let homeCache = null;
  /** The home folder's real path, in the case the disk has it. */
  const realHome = () => (homeCache ??= fs.realpathSync.native(home));
  /** `p` with a leading ~ expanded and normalized; anything not absolute is a bad argument. */
  const expand = (/** @type {unknown} */ p) => {
    if (typeof p !== 'string' || !p.trim()) throw new SourceError('A path is needed', 'bad_args');
    const s = p.trim();
    const abs = s === '~' || s.startsWith('~/') ? path.join(home, s.slice(1)) : s;
    if (!path.isAbsolute(abs)) throw new SourceError(`${p} is not an absolute path; use one from momo_files_list`, 'bad_args');
    return path.resolve(abs);
  };
  /** `p` as the model and Settings see it: under home as ~/… */
  const shown = (/** @type {string} */ p) => {
    const rel = path.relative(realHome(), p);
    return rel.startsWith('..') ? p : path.join('~', rel);
  };

  /** Why `dir` (a real path) can't be a Files folder, or null when it can. */
  const folderRefusal = (/** @type {string} */ dir) => {
    const rel = relIn(realHome(), dir);
    if (rel === '') return 'Pick a folder inside your home folder, not the home folder itself';
    if (rel === null) return 'Only folders inside your home folder can be added';
    if (hidden(rel)) return 'Hidden folders can’t be added';
    if (rel.split(path.sep)[0] === 'library') return 'System folders (~/Library) can’t be added';
    return null;
  };

  const folders = () => hub.get('files')?.folders ?? [];

  /**
   * The real path of `p` when it is an added folder or inside one; a refusal otherwise. The path is first checked as
   * written, so nothing about a path outside the folders (not even whether it exists) is revealed; then its real path
   * (links resolved, the disk's case) must still be inside a folder that passes the folder rules, with no hidden name
   * on the way. Refusals name the path as it was given.
   * @param {unknown} p
   */
  const resolveInside = async (p) => {
    const given = expand(p);
    const asGiven = String(p).trim();
    const roots = folders();
    // the folders as stored (real paths) and as written under ~ (the home folder may itself be reached through a link)
    const lexical = roots.flatMap((r) => [r, path.join(home, path.relative(realHome(), r))]);
    const near = lexical.map((r) => relIn(r, given)).filter((rel) => rel !== null);
    if (!near.length) throw new SourceError(`${asGiven} isn't in a folder the user added to MoMo`, 'outside');
    if (near.every((rel) => hidden(/** @type {string} */ (rel))))
      throw new SourceError(`${asGiven} is hidden; MoMo doesn't read hidden files`, 'outside');
    let target;
    try {
      target = await fs.promises.realpath(given);
    } catch {
      throw new SourceError(`${asGiven} doesn't exist`, 'bad_args');
    }
    for (const folder of roots) {
      let root;
      try {
        root = await fs.promises.realpath(folder);
      } catch (error) {
        // a folder deleted since it was added reads nothing; anything else is recorded
        noteIgnored('resolve a MoMo Files folder', error, ['ENOENT']);
        continue;
      }
      const rel = relIn(root, target);
      if (rel === null || folderRefusal(root)) continue;
      if (hidden(rel)) throw new SourceError(`${asGiven} is hidden; MoMo doesn't read hidden files`, 'outside');
      return target;
    }
    throw new SourceError(`${asGiven} isn't in a folder the user added to MoMo`, 'outside');
  };

  /** After a folder or file was opened by its checked path: the path must still lead there, else it changed meanwhile. */
  const stillThere = async (/** @type {unknown} */ p, /** @type {string} */ target, /** @type {{ dev: number, ino: number }} */ held) => {
    /** @type {import("node:fs").Stats | null} */
    let now = null;
    try {
      if ((await resolveInside(p)) === target) now = await fs.promises.lstat(target);
    } catch {
      // the path no longer resolves inside a folder, or no longer exists: it changed
      throw changed(String(p).trim());
    }
    if (!now || now.dev !== held.dev || now.ino !== held.ino) throw changed(String(p).trim());
  };

  return {
    id: 'files',
    /** Files needs no macOS grant: connecting starts it with no folders. */
    connect: async () => ({ connected: hub.connect('files'), grant: 'granted' }),
    /** The folders, for Settings. */
    detail: async () => folders().map(shown),
    /** Adds a folder the user picked in main's folder dialog; returns the folders. */
    addFolder(/** @type {unknown} */ p) {
      let dir;
      try {
        dir = fs.realpathSync.native(expand(p));
      } catch (e) {
        if (e instanceof SourceError) throw e;
        throw new SourceError(`${String(p)} doesn't exist`, 'bad_args');
      }
      if (!fs.statSync(dir).isDirectory()) throw new SourceError(`${shown(dir)} is not a folder`, 'bad_args');
      const why = folderRefusal(dir);
      if (why) throw new SourceError(why, 'outside');
      hub.setFolders([...folders(), dir]);
      return folders().map(shown);
    },
    /** Removes a folder (as stored, or as shown); returns the folders. */
    removeFolder(/** @type {string} */ p) {
      hub.setFolders(folders().filter((f) => f !== p && shown(f) !== p));
      return folders().map(shown);
    },
    /**
     * The added folders (no path), or one folder's entries: names, kinds, sizes and times, hidden names left out.
     * @param {{ path?: string, match?: string }} args
     * @param {string} chatId
     */
    async list(args, chatId) {
      const summary = args.path ? 'list one folder' : 'list the added folders';
      // what the read names, for the audit log's digest (#2284)
      const named = { path: args.path, match: args.match };
      return hub.read({ source: 'files', action: 'files.list', chatId, summary, args: named }, async () => {
        if (!args.path) {
          const entries = folders().map((f) => ({ path: shown(f), kind: 'folder' }));
          return { count: entries.length, folder: null, entries, truncated: false };
        }
        const target = await resolveInside(args.path);
        const st = await fs.promises.lstat(target);
        if (!st.isDirectory()) throw new SourceError(`${shown(target)} is a file; read it with momo_files_read`, 'bad_args');
        const match = typeof args.match === 'string' ? args.match.trim().toLowerCase() : '';
        const all = await fs.promises.readdir(target);
        // the folder listed must still be the one checked: a folder on the way swapped for a link lists nothing
        await stillThere(args.path, target, st);
        const names = all.filter((n) => !n.startsWith('.') && (!match || n.toLowerCase().includes(match)));
        names.sort((a, b) => a.localeCompare(b));
        const entries = [];
        for (const name of names.slice(0, MAX_ENTRIES)) {
          const e = await fs.promises.lstat(path.join(target, name));
          const kind = e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'folder' : 'file';
          entries.push({ path: shown(path.join(target, name)), kind, ...(kind === 'file' && { size: e.size }), modified: e.mtimeMs });
        }
        return { count: entries.length, folder: shown(target), entries, truncated: names.length > MAX_ENTRIES };
      });
    },
    /**
     * A text file's contents from `offset`, at most `maxBytes` (default 64 KB, at most 256 KB), ending on a whole
     * character; binary files aren't read.
     * @param {{ path: string, offset?: number, maxBytes?: number }} args
     * @param {string} chatId
     */
    async read(args, chatId) {
      const named = { path: args.path, offset: args.offset, maxBytes: args.maxBytes };
      return hub.read({ source: 'files', action: 'files.read', chatId, summary: 'read one file', args: named }, async () => {
        const target = await resolveInside(args.path);
        const st = await fs.promises.lstat(target);
        if (!st.isFile()) throw new SourceError(`${shown(target)} is a folder; list it with momo_files_list`, 'bad_args');
        const offset = Math.max(0, Math.trunc(Number(args.offset) || 0));
        const want = Math.min(Math.max(Math.trunc(Number(args.maxBytes) || DEFAULT_READ), 1), MAX_READ);
        // no symbolic link is followed at the end, and the file opened must be the one checked, still reached by its path
        const fh = await fs.promises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => {
          throw changed(String(args.path).trim());
        });
        let buf;
        try {
          const opened = await fh.stat();
          if (opened.ino !== st.ino || opened.dev !== st.dev) throw changed(String(args.path).trim());
          await stillThere(args.path, target, opened);
          const sniff = Buffer.alloc(Math.min(SNIFF, opened.size));
          await fh.read(sniff, 0, sniff.length, 0);
          const chunk = Buffer.alloc(Math.max(0, Math.min(want, opened.size - offset)));
          await fh.read(chunk, 0, chunk.length, offset);
          // a NUL at the start or in the part asked for means a binary file
          if (sniff.includes(0) || chunk.includes(0))
            throw new SourceError(`${shown(target)} is not a text file, so it wasn't read`, 'bad_args');
          buf = offset + chunk.length < opened.size && chunk.length ? wholeChars(chunk) : chunk;
        } finally {
          await fh.close();
        }
        return {
          count: 1,
          path: shown(target),
          text: buf.toString('utf8'),
          size: st.size,
          offset,
          bytes: buf.length,
          truncated: offset + buf.length < st.size,
        };
      });
    },
  };
}

module.exports = { filesSource, wholeChars, MAX_ENTRIES, MAX_READ, DEFAULT_READ };
