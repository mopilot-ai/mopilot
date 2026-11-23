// File search for @ mentions, ⌘P and the Files panel: the bundled ripgrep lists a folder's files @host-portable: loads in the Host process without Electron (host/boundary.json).
// (`rg --files`, honouring .gitignore), and the Rust core's rank crate scores them. Works without any harness.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');
const { isDirectory } = require('./directoryReads.cjs');
const shellEnv = require('./env.cjs');
const { coreCall } = require('./core.cjs');

const MAX_FILES = 100000; // stop listing past this many files (a home folder, say)
const LIST_TIMEOUT_MS = 10000;
const CACHE_MS = 15000; // keystrokes in a row reuse one listing
const DEFAULT_LIMIT = 50;

/**
 * The ripgrep the app ships: Resources/ripgrep (scripts/fetch-vendor.mjs, pinned 15.2.0); in a dev
 * checkout build/vendor/<platform>-<arch>/ripgrep when fetched, else the one in @vscode/ripgrep-<platform>-<arch>;
 * else `rg` on PATH.
 */
function rgPath() {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const own = [
    process.resourcesPath && path.join(process.resourcesPath, 'ripgrep', exe),
    path.join(__dirname, '..', '..', 'build', 'vendor', `${process.platform}-${process.arch}`, 'ripgrep', exe),
  ];
  for (const p of own) if (p && fs.existsSync(p)) return p;
  try {
    const p = require
      .resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${exe}`)
      .replace(/\bapp\.asar\b(?!\.unpacked)/, 'app.asar.unpacked');
    if (fs.existsSync(p)) return p;
  } catch (error) {
    // no bundled ripgrep for this platform (MODULE_NOT_FOUND): use rg from PATH
    noteIgnored('find the bundled ripgrep', error, ['MODULE_NOT_FOUND']);
  }
  return 'rg';
}

/** Relative paths of the files under `cwd` (no dirs), capped at `max`. */
function listFiles(cwd, { max = MAX_FILES, timeoutMs = LIST_TIMEOUT_MS, bin = rgPath() } = {}) {
  return new Promise((resolve, reject) => {
    // Windows: forward slashes, like the paths the rest of the app (and every harness) accepts
    const winArgs = process.platform === 'win32' ? ['--path-separator', '/'] : [];
    const proc = childProcess.spawn(bin, ['--files', '--null', '--hidden', '--glob', '!.git', '--no-messages', ...winArgs], {
      cwd,
      // the login shell's PATH: rg from PATH (no bundled copy) is in Homebrew's folder, not launchd's (#1580)
      env: shellEnv.childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const files = [];
    let rest = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch (error) {
        // the search process already exited
        noteIgnored('stop a file listing', error, ['ESRCH']);
      }
      err ? reject(err) : resolve(files);
    };
    const timer = setTimeout(() => finish(files.length ? undefined : new Error('File listing timed out')), timeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      if (done) return;
      const lines = (rest + chunk).split('\0');
      // split() always returns at least one piece
      rest = /** @type {string} */ (lines.pop());
      for (const l of lines) {
        if (l) files.push(l.startsWith('./') ? l.slice(2) : l);
        if (files.length >= max) return finish();
      }
    });
    proc.on('error', finish);
    // Exit 1 means no files; exit 2 may still yield readable files among unreadable entries.
    proc.on('close', (code, signal) => {
      if (done) return;
      if (rest && files.length < max) files.push(rest);
      if (code === 0 || code === 1 || (code === 2 && files.length)) finish();
      else finish(new Error(`File listing failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

/** What a search says when the core's ranking fails, as the window shows it; the core's error is its cause. @param {unknown} error */
const unavailable = (error) => {
  throw new Error('File search is unavailable.', { cause: error });
};

/** Hold `files` in the Rust core, whose rank crate scores them off the JS thread: the listing's id. @param {string[]} files */
function openListing(files) {
  return /** @type {Promise<number>} */ (coreCall('rank.open', undefined, files.join('\0')).catch(unavailable));
}

/** `text` with any half of a surrogate pair as U+FFFD. @param {string} text */
const wellFormed = (text) => Buffer.from(text).toString();

/**
 * Search a held listing. A query cut in the middle of an emoji (a phone's is cut to its limit) still searches: half a character
 * matches no path either way, and the core takes only well-formed text.
 * @param {number} id @param {string} query
 */
async function searchListing(id, query, { root = '', limit = DEFAULT_LIMIT, dirs = true }) {
  const ask = { id, query: wellFormed(String(query || '')), root: wellFormed(root), limit, dirs };
  return coreCall('rank.search', undefined, JSON.stringify(ask)).catch(unavailable);
}

/** Let a listing go; one the core no longer holds (it was refused, or went with a failed search) is noted. */
const closeListing = (/** @type {number} */ id) =>
  coreCall('rank.close', undefined, String(id)).catch((error) => noteIgnored('close a file listing', error));

/** Rank `files` (and their folders) for `query`, once. An empty query lists the shortest paths first. @param {string[]} files @param {string} query */
async function rank(files, query, o = {}) {
  const id = await openListing(files);
  try {
    return await searchListing(id, query, o);
  } finally {
    void closeListing(id);
  }
}

/**
 * A cached listing's core handle goes once it has left the cache and no search is using it: a keystroke still running
 * when the listing expires keeps it to the end.
 * @param {{ listing: Promise<number>, users: number, retired: boolean }} hit
 */
function letGo(hit) {
  if (hit.retired && hit.users === 0) hit.listing.then(closeListing, () => undefined);
}

const cache = new Map(); // cwd -> {at, listing: Promise<number>, users, retired}

/** Take `hit` out of the cache. */
function retire(cwd, hit) {
  if (cache.get(cwd) === hit) cache.delete(cwd);
  hit.retired = true;
  letGo(hit);
}

/** Fuzzy-search the files (and, with `dirs`, folders) under `cwd`. */
async function searchFiles(cwd, query, { limit = DEFAULT_LIMIT, dirs = true } = {}) {
  if (!cwd || !path.isAbsolute(cwd) || !(await isDirectory(cwd))) return { files: [] };
  let hit = cache.get(cwd);
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    if (hit) retire(cwd, hit);
    hit = { at: Date.now(), listing: listFiles(cwd).then(openListing), users: 0, retired: false };
    cache.set(cwd, hit);
    if (cache.size > 8) {
      const [oldest, entry] = cache.entries().next().value;
      retire(oldest, entry);
    }
  }
  const listed = hit;
  listed.users++;
  // a listing that failed (no ripgrep) is not kept for the next keystrokes, and the caller gets the failure
  // (the Files panel shows it with Retry) rather than an empty result that reads as "No results"
  const failed = (/** @type {unknown} */ error) => {
    retire(cwd, listed);
    throw error;
  };
  try {
    return { files: await listed.listing.then((id) => searchListing(id, query, { root: cwd, limit, dirs })).catch(failed) };
  } finally {
    listed.users--;
    letGo(listed);
  }
}

function register(ipcMain) {
  // the Files pane's `?` filter (searchText.cjs): a window's newer search stops its older one
  const running = new Map();
  ipcMain.handle('platform:search:text', (e, cwd, query, opts) => {
    const owner = e?.sender?.id ?? 0;
    running.get(owner)?.abort();
    const controller = new AbortController();
    running.set(owner, controller);
    const search = require('./searchText.cjs').searchText(String(cwd || ''), String(query ?? ''), {
      limit: Math.min(Math.max(Number(opts?.limit) || 200, 1), 1000),
      signal: controller.signal,
    });
    const done = () => {
      if (running.get(owner) === controller) running.delete(owner);
    };
    search.then(done, done);
    return search;
  });
  ipcMain.handle('platform:search:files', (_e, cwd, query, opts) =>
    searchFiles(String(cwd || ''), String(query ?? ''), {
      limit: Math.min(Math.max(Number(opts?.limit) || DEFAULT_LIMIT, 1), 500),
      dirs: opts?.dirs !== false,
    }),
  );
}

module.exports = { register, searchFiles, listFiles, rank, rgPath };
