// The "working in" stack's pictures of a desktop app, on any path (MoPilot's desktop tools or a vendor's own computer use): a window thumbnail at most once a second through MoPilot's helper, only when it already has Screen Recording (never asking for it), and bringing the app to the front (its name and icon: appIdentity.cjs).
const { identityKey } = require('../../shared/identityKey.mjs');
const { AppIdentity } = require('./appIdentity.cjs');
const { AGENT_FALLBACK } = require('./computerPresentation.cjs');

const { proc } = require('../platform/ports/proc.cjs');

const THUMB_EVERY_MS = 1000;
/** how long a Screen Recording answer is trusted before the helper is asked again */
const PERMISSION_TTL_MS = 10000;
/** the longest side of a capture: the card's thumbnail, or the larger live view a person opened on the card */
const THUMB_SIDES = { card: 360, large: 1024 };

/**
 * /usr/bin/open with these arguments (LaunchServices: no permission needed).
 * @param {string[]} args
 * @param {(file: string, args: string[], cb: (err: Error | null) => void) => void} [run]
 */
function openWith(args, run = proc.execFile) {
  return /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => run('/usr/bin/open', args, (err) => (err ? reject(err) : resolve(undefined))))
  );
}

class WorkingInViews {
  /**
   * @param {object} o
   * @param {{ call(method: string, params?: object, opts?: object): Promise<any>, permissionStatus(): Promise<any>, resolveApps(q: string[]): Promise<any> }} o.helper
   * @param {() => boolean} o.enabled computer use is on (the helper may run)
   * @param {any} [o.images] Electron's nativeImage, for app icons
   * @param {(args: string[]) => Promise<void>} [o.open] runs /usr/bin/open with these arguments
   * @param {() => number} [o.now]
   */
  constructor(o) {
    this.helper = o.helper;
    this.enabled = o.enabled;
    /** every CU surface names an app by its display name and icon, never a bundle id */
    this.identity = new AppIdentity({ images: o.images ?? null });
    this.open = o.open || openWith;
    this.now = o.now || Date.now;
    /** Structured chat/app tuple -> {chatId, at, turnId, view: Promise<{thumbnail, bundleId}>} */
    this.thumbs = new Map();
    /** Capture promises still awaiting the helper; polling shares them even after the cache TTL. */
    this.captures = new Set();
    /** {at, granted} */
    this.screen = null;
    this.screenRead = null;
  }

  /** Whether MoPilot's helper already has Screen Recording: asked without a prompt, answered from cache for a while. */
  screenGranted() {
    const t = this.now();
    if (this.screen && t - this.screen.at < PERMISSION_TTL_MS) return Promise.resolve(this.screen.granted);
    if (this.screenRead) return this.screenRead;
    const read = Promise.resolve()
      .then(() => (this.screenRead === read ? this.helper.permissionStatus() : null))
      .then(
        (p) => {
          if (this.screenRead !== read) return false;
          const granted = p?.screenRecording === true;
          this.screen = { at: this.now(), granted };
          return granted;
        },
        // a read that failed decides nothing: it is not kept, so the next thumbnail asks again (#1531)
        () => false,
      )
      .finally(() => {
        if (this.screenRead === read) this.screenRead = null;
      });
    this.screenRead = read;
    return read;
  }

  /**
   * A small JPEG of the app's front window as a data: URL ({thumbnail, bundleId}), or no thumbnail when
   * computer use is off, Screen Recording isn't granted, the app isn't running or the capture failed.
   * At most one capture a second per chat, app, turn and size: a call sooner gets the last answer.
   * size 'large' is the card's opened live view; anything else is the card's thumbnail.
   */
  thumbnail(chatId, app, turnId = null, size = 'card') {
    const kind = size === 'large' ? 'large' : 'card';
    const side = THUMB_SIDES[kind];
    if (!this.enabled()) {
      this.forget(chatId);
      return Promise.resolve({ thumbnail: null, bundleId: null });
    }
    const k = identityKey(chatId, String(app).toLowerCase(), kind);
    const t = this.now();
    const prev = this.thumbs.get(k);
    if (prev && prev.turnId === turnId && (this.captures.has(prev.view) || t - prev.at < THUMB_EVERY_MS)) return prev.view;
    const current = () => this.enabled() && this.thumbs.get(k)?.view === view;
    const view = Promise.resolve()
      .then(() => this.#capture(app, current, side))
      .finally(() => this.captures.delete(view));
    this.captures.add(view);
    this.thumbs.set(k, { chatId, at: t, view, turnId });
    return view;
  }

  async #capture(app, current, side) {
    const none = { thumbnail: null, bundleId: null };
    if (typeof app !== 'string' || !app || !current()) return none;
    if (!(await this.screenGranted()) || !current()) return none;
    try {
      const found = (await this.helper.resolveApps([app]))?.apps?.[0]?.app;
      if (!current()) return none;
      if (!found?.running || !found.pid) return { ...none, bundleId: found?.bundleId ?? null };
      const shot = await this.helper.call(
        'app.screenshot',
        {
          pid: found.pid,
          bundleIds: [found.bundleId],
          maxSide: side,
          maxPixels: side * side,
          scale: 1,
          format: 'jpeg',
          quality: 0.6,
          tree: false,
        },
        { timeoutMs: 8000 },
      );
      if (!current()) return none;
      const data = shot?.jpeg || shot?.thumb;
      return { thumbnail: data ? `data:${shot.mimeType || 'image/jpeg'};base64,${data}` : null, bundleId: found.bundleId };
    } catch {
      return none;
    }
  }

  /** Brings the app to the front (LaunchServices; no permission needed): by bundle id when known, else by name. */
  async bringToFront(app, bundleId) {
    const args = typeof bundleId === 'string' && bundleId ? ['-b', bundleId] : typeof app === 'string' && app ? ['-a', app] : null;
    if (!args) return false;
    try {
      await this.open(args);
      return true;
    } catch {
      return false;
    }
  }

  /** The working-in stack's and every CU surface's IPC: thumbnails, app names and icons, bringing an app forward. */
  handle(ipcMain) {
    ipcMain.handle('computer:workingThumb', (_e, chatId, app, turnId, size) => this.thumbnail(String(chatId), app, turnId, size));
    ipcMain.handle('computer:appIdentity', (_e, app) => this.identity.resolve(app));
    ipcMain.handle('computer:bringToFront', (_e, app, bundleId) => this.bringToFront(app, bundleId));
  }

  /**
   * What the control pill names: the chat's agent ("The agent" when none is known), and whether the person took over.
   * @param {string | null | undefined} agent
   */
  async pillWho(agent, paused = false) {
    return { agent: agent || AGENT_FALLBACK, paused };
  }

  /** A feature shutdown or helper exit retires cached permissions and all pending captures. */
  clear() {
    this.thumbs.clear();
    this.captures.clear();
    this.screen = null;
    this.screenRead = null;
  }

  /** The chat was archived or deleted. */
  forget(chatId) {
    for (const [key, view] of this.thumbs) if (view.chatId === chatId) this.thumbs.delete(key);
  }
}

module.exports = { WorkingInViews, openWith, THUMB_EVERY_MS, PERMISSION_TTL_MS, THUMB_SIDES };
