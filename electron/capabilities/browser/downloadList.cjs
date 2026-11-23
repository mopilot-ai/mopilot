// The browser pane's Downloads list (#1523), kept in main so every window shows the same list whether or not the page
// that started a download is still open or shown: each download from a panel session (the shared profile or a chat's
// own), the user's or one saved for an agent, from Starting to Downloaded, Stopped or Download failed. It lives for the
// app's run, newest first, and keeps MAX entries as the Codex app's popover does.
//
// IPC: browser:downloads (the list, with the finished downloads the user hasn't looked at), browser:downloadAct (open,
// show, cancel, resume or remove one), browser:downloadsSeen, browser:openDownloadsFolder.
// Push: browser:downloadsChanged (the list), browser:downloadDone (one download ended: the pane's peek).
const crypto = require('node:crypto');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');

/** How many downloads the list keeps (the Codex app's popover keeps 200); the oldest finished ones drop off. */
const MAX = 200;
/** Progress reaches the windows at most this often; a start, a pause or an end goes at once. */
const PROGRESS_MS = 250;
const ACTIONS = new Set(['open', 'show', 'cancel', 'resume', 'remove']);

/**
 * @typedef {'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'} DownloadState
 * @typedef {{ id: string, name: string, path: string, url: string, state: DownloadState, received: number, total: number,
 *   startedAt: number, endedAt: number | null, agent: boolean, pageId: number | null, exists: boolean | null,
 *   stopping: boolean, canResume: boolean }} DownloadEntry
 *   exists: whether a finished download's file is still there (null until it finished); stopping: Cancel was asked
 * @typedef {{ entry: DownloadEntry, item: any }} Row item: the live DownloadItem, null once it ended
 * @typedef {{ ok: true } | { ok: false, reason: 'missing' | 'not-active' | 'not-resumable' | 'active' | 'open-failed', message?: string }} ActResult
 */

const count = (/** @type {unknown} */ n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

class DownloadList {
  /**
   * @param {object} o
   * @param {(channel: string, payload: any) => void} o.broadcast to every window
   * @param {{ openPath: (p: string) => Promise<string>, showItemInFolder: (p: string) => void }} o.shell
   * @param {() => string} o.folder where the user's downloads go (Settings → Browser → Downloads)
   * @param {() => number} [o.now]
   * @param {(p: string) => boolean} [o.exists]
   * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, setImmediate: (fn: () => void) => any }} [o.timers]
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.exists = o.exists ?? ((/** @type {string} */ p) => !!p && fs.existsSync(p));
    this.timers = o.timers ?? { setTimeout, clearTimeout, setImmediate };
    /** @type {Row[]} newest first */
    this.rows = [];
    /** finished downloads (Downloaded or failed) the user hasn't looked at: the Downloads button's dot */
    this.unseen = new Set();
    /** @type {any} a progress push waiting */
    this.timer = null;
    this.soon = false;
  }

  /**
   * A download from a panel session, once where it goes is decided. Returns its id.
   * @param {any} item Electron's DownloadItem
   * @param {{ pageId?: number | null, agent?: boolean }} [from] the page it started from (the pane matches its peek by it); agent: saved for an agent
   */
  track(item, from = {}) {
    /** @type {DownloadEntry} */
    const entry = {
      id: crypto.randomUUID(),
      name: '',
      path: '',
      url: String(item.getURL?.() ?? ''),
      state: 'progressing',
      received: 0,
      total: 0,
      startedAt: this.now(),
      endedAt: null,
      agent: !!from.agent,
      pageId: Number.isSafeInteger(from.pageId) ? /** @type {number} */ (from.pageId) : null,
      exists: null,
      stopping: false,
      canResume: false,
    };
    /** @type {Row} */
    const row = { entry, item };
    this.read(row);
    this.rows.unshift(row);
    this.trim();
    this.changed(true);
    item.on('updated', (/** @type {unknown} */ _e, /** @type {string} */ state) => {
      if (!row.item) return;
      this.read(row);
      const was = entry.state;
      if (state === 'interrupted') {
        // a break the download can come back from is a pause; one it can't is its end, as the Codex app has it
        if (!item.canResume?.()) return this.end(row, 'interrupted');
        entry.state = 'paused';
      } else entry.state = item.isPaused?.() ? 'paused' : 'progressing';
      this.changed(entry.state !== was);
    });
    item.once('done', (/** @type {unknown} */ _e, /** @type {string} */ state) =>
      this.end(row, state === 'completed' || state === 'cancelled' ? state : 'interrupted'),
    );
    return entry.id;
  }

  /** The item's name, file and progress (the save sheet names the file only once the user answers it). */
  read(/** @type {Row} */ { entry, item }) {
    const saved = String(item.getSavePath?.() ?? '');
    entry.path = saved;
    entry.name = saved ? path.basename(saved) : String(item.getFilename?.() ?? '') || 'download';
    entry.received = count(item.getReceivedBytes?.());
    entry.total = count(item.getTotalBytes?.());
    entry.canResume = !!item.canResume?.();
  }

  /** The download ended; only its first end counts. */
  end(/** @type {Row} */ row, /** @type {DownloadState} */ state) {
    if (!row.item) return;
    const { entry } = row;
    this.read(row);
    row.item = null;
    Object.assign(entry, { state, endedAt: this.now(), stopping: false, canResume: false });
    entry.exists = state === 'completed' ? this.exists(entry.path) : null;
    // the user stopped it (or the site did): nothing to call them back for
    if (state !== 'cancelled') this.unseen.add(entry.id);
    this.changed(true);
    this.o.broadcast('browser:downloadDone', { ...entry });
  }

  /** Over MAX, the oldest finished downloads drop off; one still downloading never does. */
  trim() {
    for (let i = this.rows.length - 1; this.rows.length > MAX && i >= 0; i--) {
      if (this.rows[i].item) continue;
      this.unseen.delete(this.rows[i].entry.id);
      this.rows.splice(i, 1);
    }
  }

  /** The list changed: a start, pause or end reaches the windows on the next turn of the loop, progress within PROGRESS_MS. */
  changed(now = true) {
    if (now) {
      if (this.timer) this.timers.clearTimeout(this.timer);
      this.timer = null;
      if (!this.soon) this.timers.setImmediate(() => this.flush());
      this.soon = true;
    } else if (!this.timer && !this.soon) this.timer = this.timers.setTimeout(() => this.flush(), PROGRESS_MS);
  }

  flush() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.soon = false;
    this.o.broadcast('browser:downloadsChanged', this.view());
  }

  view() {
    return { downloads: this.rows.map((r) => ({ ...r.entry })), unseen: [...this.unseen] };
  }

  /** The list as the panel opens: whether each Downloaded file is still there is read again. */
  snapshot() {
    for (const { entry } of this.rows) if (entry.state === 'completed') entry.exists = this.exists(entry.path);
    return this.view();
  }

  /**
   * One download's action from the panel or the peek. Main resolves the file from the id: a window never names a path.
   * @returns {Promise<ActResult>}
   */
  async act(/** @type {unknown} */ id, /** @type {unknown} */ action) {
    const row = this.rows.find((r) => r.entry.id === id);
    if (!row || typeof action !== 'string' || !ACTIONS.has(action)) return { ok: false, reason: 'missing' };
    const { entry, item } = row;
    if (action === 'cancel') {
      if (!item || entry.stopping) return { ok: false, reason: 'not-active' };
      // the item's done event says how it ended: a download that completed first stays Downloaded
      entry.stopping = true;
      item.cancel();
      this.changed(true);
      return { ok: true };
    }
    if (action === 'resume') {
      if (!item || entry.state !== 'paused' || !item.canResume?.()) return { ok: false, reason: 'not-resumable' };
      item.resume();
      entry.state = 'progressing';
      this.changed(true);
      return { ok: true };
    }
    if (action === 'remove') {
      if (item) return { ok: false, reason: 'active' };
      this.rows = this.rows.filter((r) => r !== row);
      this.unseen.delete(entry.id);
      this.changed(true);
      return { ok: true };
    }
    // open or show: a Downloaded file that is still there
    const there = entry.state === 'completed' && this.exists(entry.path);
    if (!there) {
      // a Downloaded file that went: the row says so
      if (entry.state === 'completed' && entry.exists !== false) {
        entry.exists = false;
        this.changed(true);
      }
      return { ok: false, reason: 'missing' };
    }
    entry.exists = true;
    this.unseen.delete(entry.id);
    this.changed(true);
    if (action === 'show') {
      this.o.shell.showItemInFolder(entry.path);
      return { ok: true };
    }
    const message = await this.o.shell.openPath(entry.path);
    return message ? { ok: false, reason: 'open-failed', message } : { ok: true };
  }

  /** The user looked at these finished downloads (the panel opened: all of them). */
  seen(/** @type {unknown} */ ids) {
    const size = this.unseen.size;
    if (Array.isArray(ids)) for (const id of ids) this.unseen.delete(id);
    else this.unseen.clear();
    if (this.unseen.size !== size) this.changed(true);
    return true;
  }

  /** @returns {Promise<ActResult>} */
  async openFolder() {
    let message;
    try {
      message = await this.o.shell.openPath(this.o.folder());
    } catch (error) {
      // no folder to open (electron/app/browserDownloads.cjs userDownloads): said, not an IPC failure
      message = String(/** @type {Error} */ (error)?.message ?? error);
    }
    return message ? { ok: false, reason: 'open-failed', message } : { ok: true };
  }

  register(/** @type {Pick<Electron.IpcMain, 'handle'>} */ ipcMain) {
    ipcMain.handle('browser:downloads', () => this.snapshot());
    ipcMain.handle('browser:downloadAct', (_e, id, action) => this.act(id, action));
    ipcMain.handle('browser:downloadsSeen', (_e, ids) => this.seen(ids));
    ipcMain.handle('browser:openDownloadsFolder', () => this.openFolder());
  }
}

module.exports = { DownloadList, MAX, PROGRESS_MS };
