// Computer use: launches "MoPilot.app" through LaunchServices and talks to it over a
// private unix socket (newline-delimited JSON-RPC 2.0). The helper, not MoPilot, holds the
// Accessibility and Screen Recording grants, and it enforces the hard floor (no input to MoPilot,
// System Settings, Keychain Access or password apps; one controller per user; physical Esc and
// take-over). This is main's internal API; agents reach it later through per-session tool injection.
const { noteIgnored, messageOf } = require('../ignored.cjs');
const { proc } = require('../platform/ports/proc.cjs');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { fs } = require('../platform/ports/fs.cjs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { writePrivate } = require('../platform/fsutil.cjs');
const { mayAct, unguarded, currentToken } = require('./contract/actionGuard.cjs');
const { span } = require('./contract/callPhases.cjs');
const { notePermissions, recheckPermissions } = require('./computerPermissionState.cjs');
const {
  helperFix,
  outdatedHelperText,
  GIVES_BACK,
  READ_ONLY,
  NO_LAUNCH,
  BUILT_IN_DENY,
  withFloor,
  HELPER_NAME,
  HELPER_BUNDLE_ID,
  helperAppPath,
  launchArgs,
  lineDecoder,
  attachHelperSocket,
  HelperError,
  openHelper,
} = require('./computerContract.cjs');
const { stampRefusal, launchStamped } = require('./computerStamp.cjs');

const NOTIFICATIONS = { 'control.paused': 'paused', 'record.event': 'record', 'click.dispatched': 'clicked' }; // helper notification -> event
/** One running helper, tied to this main process. Events: 'paused' ({reason: 'escape'|'takeover'}), 'record' (a person's click or key while recording, watchRecord.cjs), 'exit' (the helper went away). */
class ComputerHelper extends EventEmitter {
  /**
   * @param {{appPath?: string, mainPid?: number, denyBundleIds?: string[], spawn?: typeof proc.spawn,
   *          connectTimeoutMs?: number, callTimeoutMs?: number, connectTo?: string | null, platform?: string,
   *          packaged?: boolean, expectedDigest?: string | null | (() => string | null), exists?: (p: string) => boolean, now?: () => number, recheckMs?: number}} [opts]
   * `packaged`: the helper ships inside the app (its errors never name developer scripts).
   * `recheckMs`: how often a request that worked reads permissions reported missing again (recheckPermissions).
   * `connectTo`: the socket of a helper that is already listening, used instead of launching one (the
   * e2e tests' fake helper, through SAGE_CU_FAKE_HELPER): nothing is launched, no real screen is touched.
   */
  constructor(opts = {}) {
    super();
    this.appPath = opts.appPath || helperAppPath();
    this.mainPid = opts.mainPid || process.pid;
    this.denyBundleIds = opts.denyBundleIds || [];
    this.spawn = opts.spawn || /** @type {typeof proc.spawn} */ ((...a) => /** @type {any} */ (proc.spawn)(...a));
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 30000;
    this.connectTo = opts.connectTo || null;
    this.platform = opts.platform || process.platform;
    this.packaged = opts.packaged === true;
    this.exists = opts.exists || ((p) => fs.existsSync(p));
    this.now = opts.now || Date.now;
    this.recheckMs = opts.recheckMs ?? 10_000;
    /** the source digest the helper must report (helperStamp.cjs); null checks nothing */
    this.expectedDigest = opts.expectedDigest ?? null;
    /** @type {{ error: Error, at: number } | null} why the helper on disk was refused, and its Info.plist time then (computerStamp.cjs) */
    this.outdated = null;
    /** when a request that worked last read the permissions again */
    this.recheckedAt = Number.NEGATIVE_INFINITY;
    /** why the last launch failed, until one succeeds */
    /** @type {string | null} */
    this.lastError = null;
    /** the macOS permissions this helper last reported (its hello, a status read or a request); null until then */
    /** @type {Record<string, boolean> | null} */
    this.permissions = null;
    this.socket = null;
    this.jsonReader = null;
    this.dir = null;
    this.info = null;
    this.nextId = 1;
    this.pending = new Map();
    this.starting = null;
  }

  get running() {
    return !!this.socket;
  }

  /**
   * Whether there is a helper to launch on this machine: macOS with the app in place, or a socket to connect to.
   * Never launches it, and sends nothing (a property, like `running`, not a request).
   */
  get installed() {
    if (this.connectTo) return true;
    return this.platform === 'darwin' && this.exists(this.appPath);
  }

  /** What fixes a missing or outdated helper here (helperFix). */
  get fix() {
    return helperFix(this.packaged);
  }

  /**
   * Launches the helper and resolves with its hello: {pid, version, bundleId, permissions}. Single-flight:
   * callers that come while it starts (also after the socket is up, until hello answers) share one launch.
   * Every request calls this first, so a helper that exited or crashed is relaunched by the next call.
   */
  start() {
    if (this.starting) return this.starting;
    if (this.socket) return Promise.resolve(this.info);
    const refused = stampRefusal(this);
    if (refused) return Promise.reject(refused);
    // every launch reports how it went ('state'), so the capability health record follows it; launched outside the
    // call that happens to start it: the socket's listeners must not carry that call's guard
    this.starting = unguarded(() => launchStamped(this, () => this.#start()))
      .then(
        (info) => {
          this.lastError = null;
          notePermissions(this, info?.permissions, false);
          this.emit('state');
          return info;
        },
        (e) => {
          this.lastError = messageOf(e);
          this.emit('state');
          throw e;
        },
      )
      .finally(() => (this.starting = null));
    return this.starting;
  }

  async #start() {
    if (this.connectTo) {
      try {
        this.#attach(await this.#connect(this.connectTo));
        this.info = await this.#send('hello', { token: '' }, this.callTimeoutMs);
        return this.info;
      } catch (e) {
        this.stop();
        throw e;
      }
    }
    if (this.platform !== 'darwin') throw new Error('computer use needs macOS');
    if (!this.exists(this.appPath))
      throw new Error(
        this.packaged
          ? `computer-use helper not found at ${this.appPath} (${this.fix})`
          : `computer-use helper not found at ${this.appPath} (run node scripts/build-helper.mjs)`,
      );
    // A short private directory: sun_path is limited to 104 bytes.
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcu-'));
    fs.chmodSync(this.dir, 0o700);
    const socketPath = path.join(this.dir, 'h.sock');
    const token = crypto.randomBytes(32).toString('hex');
    const configPath = path.join(this.dir, 'launch.json');
    const denyBundleIds = withFloor(this.denyBundleIds);
    writePrivate(configPath, JSON.stringify({ socket: socketPath, token, mainPid: this.mainPid, denyBundleIds }));
    try {
      await openHelper(this.spawn, this.appPath, configPath);
      const sock = await this.#connect(socketPath);
      this.#attach(sock);
      this.info = await this.#send('hello', { token }, this.callTimeoutMs);
      return this.info;
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  async #connect(socketPath) {
    const deadline = Date.now() + this.connectTimeoutMs;
    for (;;) {
      try {
        return await new Promise((resolve, reject) => {
          const s = net.createConnection(socketPath);
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        });
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`computer-use helper did not start: ${e.message}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  #attach(sock) {
    attachHelperSocket(
      this,
      sock,
      (msg) => this.#onMessage(msg),
      () => this.#cleanup(),
    );
  }

  #onMessage(msg) {
    if (msg.id == null) {
      if (NOTIFICATIONS[msg.method]) this.emit(NOTIFICATIONS[msg.method], msg.params || {});
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      const err = new HelperError(msg.error.message, msg.error.code, msg.error.data?.reason);
      // a helper too old for the request: the fix that applies to this app (outdatedHelperText)
      if (err.reason === 'method_not_found') Object.assign(err, { fix: this.fix });
      p.reject(err);
    } else p.resolve(msg.result);
  }

  /**
   * Sends one JSON-RPC request, (re)launching the helper first when it isn't running. If the helper exits
   * while the request runs, a read-only one (READ_ONLY, or `readOnly: true`) is sent once more to the
   * relaunched helper; anything else rejects with reason 'helper_restarted' and is never replayed, because
   * it may already have happened. NO_LAUNCH requests reject with 'helper_not_running' instead of launching.
   */
  async call(method, params = {}, { timeoutMs = this.callTimeoutMs, readOnly = READ_ONLY.has(method), noLaunch = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (noLaunch && (!this.socket || this.starting))
        throw new HelperError('computer-use helper is not running', null, 'helper_not_running');
      if (NO_LAUNCH.has(method) && !this.socket && !this.starting)
        throw new HelperError('computer-use helper is not running', null, 'helper_not_running');
      await this.#ensure();
      // checked right before the request goes out: the call may have been stopped while the helper started
      if (!GIVES_BACK.has(method) && !mayAct()) throw new HelperError(`Stopped by the user before ${method}`, null, 'aborted');
      try {
        const result = await span(`helper:${method}`, () => this.#send(method, params, timeoutMs));
        recheckPermissions(this, method, () => this.#send('permissions.status', {}, this.callTimeoutMs));
        return result;
      } catch (e) {
        if (e?.reason !== 'helper_exited' || noLaunch) throw e;
        if (readOnly && attempt === 0) continue;
        if (readOnly)
          throw new HelperError(
            `The computer-use helper exited twice while running ${method}; wait a moment and try again.`,
            null,
            'helper_unavailable',
          );
        // relaunched now, so the model's fresh look works and the message holds
        const back = await this.start().then(
          () => true,
          () => false,
        );
        throw new HelperError(
          `The computer-use helper stopped while running ${method} and ${back ? 'was restarted' : 'could not be restarted yet'}. The action may or may not have happened, so it was not repeated: take a fresh screenshot (or re-read the app's state) before you try it again.`,
          null,
          'helper_restarted',
        );
      }
    }
  }

  /** The running helper, launched (or relaunched) when it isn't. */
  async #ensure() {
    if (this.socket && !this.starting) return;
    try {
      await this.start();
    } catch (e) {
      throw new HelperError(`computer-use helper could not be started: ${e.message}`, null, 'helper_unavailable');
    }
  }

  /** One request over the connected socket. */
  #send(method, params, timeoutMs) {
    if (!this.socket) return Promise.reject(new HelperError('computer-use helper exited', null, 'helper_exited'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`computer-use helper: ${method} timed out`));
      }, timeoutMs);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      // the call's (chat, turn) token, which the helper refuses once the turn is revoked (an older helper ignores it;
      // main refuses the same requests before they go out, in call())
      const turn = currentToken();
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params, ...(turn ? { turn } : {}) })}\n`);
    });
  }

  /**
   * A chat's turn ended or was stopped: the running helper refuses every request carrying one of its tokens (but
   * those that give the Mac back) and lets go of a desktop lock that turn took. Nothing is launched for it; an older
   * helper without the method is left alone, since main refuses the same requests itself.
   * @param {string} chat
   * @param {number} turn the turn retired (tokens up to it are no longer current)
   * @param {string | null} [thread] only that Codex thread's tokens; none: every token of the chat
   */
  async revokeTurn(chat, turn, thread = null) {
    try {
      await this.call('turn.revoke', { chat, turn, ...(thread == null ? {} : { thread }) }, { timeoutMs: 5000 });
    } catch (e) {
      if (!['method_not_found', 'helper_not_running', 'helper_exited', 'helper_stopped'].includes(e?.reason)) throw e;
    }
  }

  /** Closes the connection; the helper exits when main disconnects. Requests still waiting fail ('helper_stopped'); the next call launches it again. */
  stop() {
    this.jsonReader?.close();
    this.jsonReader = null;
    const s = this.socket;
    this.socket = null;
    for (const p of this.pending.values()) p.reject(new HelperError('computer-use helper was stopped', null, 'helper_stopped'));
    this.pending.clear();
    if (s) {
      try {
        s.write(`${JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown' })}\n`);
      } catch (error) {
        // the socket may already be broken; end() below closes it anyway
        noteIgnored('ask the computer-use helper to shut down', error);
      }
      s.end();
    }
    this.#cleanup();
  }

  #cleanup() {
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
  }

  // Thin wrappers. Coordinates are global screen points (top-left origin).
  /** Automatic recovery uses noLaunch so a proof read cannot start or restart a helper. */
  permissionStatus(options = {}) {
    return this.call('permissions.status', {}, options).then((p) => notePermissions(this, p));
  }

  /**
   * The permissions as macOS grants them now. A Screen Recording grant only reaches a new helper process, so a
   * running helper that reported it off is relaunched first, while no request is in flight and `idle()` says
   * nothing holds the desktop.
   * @param {() => boolean} [idle]
   */
  freshPermissionStatus(idle = () => true) {
    // never for a call that was stopped (it may only give the Mac back), nor while a request runs or the desktop is held
    if (this.socket && !this.starting && this.permissions?.screenRecording === false && this.pending.size === 0 && mayAct() && idle())
      this.stop();
    return this.permissionStatus();
  }

  /** Shows the macOS prompt for 'accessibility' | 'screenRecording' | 'inputMonitoring'. */
  requestPermission(kind) {
    return this.call('permissions.request', { kind }, { timeoutMs: 120000 }).then((p) => notePermissions(this, p));
  }
  openSettings(kind) {
    return this.call('permissions.openSettings', { kind });
  }
  /** {authorization: 'authorized'|'denied'|'restricted'|'notDetermined', locale, available, onDevice} for local dictation. */
  speechStatus(language) {
    return this.call('speech.status', { language });
  }
  /** Shows the macOS Speech Recognition prompt (first time only) and answers like speechStatus. */
  speechRequest(language) {
    return this.call('speech.request', { language }, { timeoutMs: 120000 });
  }
  /** {text, locale}: on-device recognition of a base64 WAV. `language`: 'en', 'zh', ... or 'auto' (system locale). */
  speechTranscribe(audioBase64, language) {
    return this.call('speech.transcribe', { audio: audioBase64, language }, { timeoutMs: 180000 });
  }
  /** Replaces the helper's extra deny list (the built-in rules stay): a running helper gets it now, a relaunched one at launch. */
  setDeny(bundleIds) {
    this.denyBundleIds = bundleIds;
    return this.socket ? this.call('deny.set', { bundleIds: withFloor(bundleIds) }) : Promise.resolve(null);
  }
  /**
   * {png (base64), width, height, display: {id, x, y, width, height}, pixelsPerPoint}; MoPilot is not in it.
   * With `pid` (and `bundleIds`) only that app's windows are captured; without, the display minus MoPilot
   * and the deny list.
   */
  screenshot(opts = {}) {
    return this.call('screenshot', opts);
  }
  /** {pid, bundleId, name, refused?}: the app owning the window at (x, y), or (no point) the one keystrokes reach. */
  targetInfo(/** @type {{ x: number, y: number } | null} */ point = null) {
    return this.call('target.info', point ? { x: point.x, y: point.y } : {});
  }
  /** `bundleIds`, here and on the input calls: refused unless every target is one of these apps. */
  axSnapshot(opts = {}) {
    return this.call('ax.snapshot', opts);
  }
  /**
   * {app, elements: [{id, text, role, frame: {x, y, w, h}, source: 'ax'|'ocr', confidence?}], truncated, display}:
   * the app's accessibility elements plus on-device OCR of its own pixels, frames in global points. Works
   * with no vision model. `pid` (default: the frontmost app), `bundleIds`, `maxElements` (<= 1000).
   */
  ocrElements(opts = {}) {
    return this.call('ocr.elements', opts, { timeoutMs: 60000 });
  }
  /** Seconds since the last physical keyboard or mouse input. */
  async idleSeconds() {
    return (await this.call('input.idle')).seconds;
  }
  /**
   * Who sent the latest Escape, as the running helper's input guard saw it: 'person', 'agent' (the helper's own
   * post, or another process's synthetic key) or 'unknown'. A helper that isn't running saw nothing, and is not
   * launched for it.
   * @returns {Promise<string>}
   */
  async escapeSender() {
    try {
      return (await this.call('input.escape')).sender;
    } catch (e) {
      if (/** @type {any} */ (e)?.reason === 'helper_not_running') return 'unknown';
      throw e;
    }
  }
  acquireControl(holder) {
    return this.call('control.acquire', { holder });
  }
  releaseControl() {
    return this.call('control.release');
  }
  /** The glow around `pid`'s window while an action runs (renewed by each start; ends on glowStop or after two minutes). */
  glowStart(pid) {
    return this.call('glow.start', { pid });
  }
  glowStop() {
    return this.call('glow.stop');
  }
  resumeControl() {
    return this.call('control.resume');
  }
  click(x, y, opts = {}) {
    return this.call('input.click', { x, y, ...opts });
  }
  type(text, opts = {}) {
    return this.call('input.type', { text, ...opts }, { timeoutMs: 120000 });
  }
  key(key, opts = {}) {
    return this.call('input.key', { key, ...opts });
  }
  scroll(x, y, dx, dy, opts = {}) {
    return this.call('input.scroll', { x, y, dx, dy, ...opts });
  }

  // Desktop control (the desktop_* tools). Older helpers answer method_not_found to these.
  /** {apps: [{pid, bundleId, name, frontmost, hidden}]}: running apps a person switches between. */
  listApps() {
    return this.call('apps.list');
  }
  /** {apps: [{query, app: {bundleId, name, displayName, path, running, pid?} | null, refused?}]}: names or bundle ids to apps. */
  resolveApps(queries) {
    return this.call('apps.resolve', { queries });
  }
  /** Launches or brings forward an app: {pid, bundleId, name, frontmost}. `bundleIds` restricts it like input calls. */
  openApp(bundleId, opts = {}) {
    return this.call('apps.open', { bundleId, ...opts }, { timeoutMs: 20000 });
  }
  /** {displays: [{id, x, y, width, height, scale, main, name}]} in global points. */
  listDisplays() {
    return this.call('displays.list');
  }
  /** {x, y}: the pointer in global points. */
  cursor() {
    return this.call('input.cursor');
  }
  move(x, y, opts = {}) {
    return this.call('input.move', { x, y, ...opts });
  }
  drag(x1, y1, x2, y2, opts = {}) {
    return this.call('input.drag', { x1, y1, x2, y2, ...opts });
  }
  /** Presses (down) or lets go of a mouse button. */
  button(button, down, /** @type {{ x: number, y: number } | null} */ point = null, opts = {}) {
    return this.call('input.button', { button, down, ...(point ? { x: point.x, y: point.y } : {}), ...opts });
  }
  /** Lets go of keys and buttons a call that timed out may have left down. */
  releaseInput(/** @type {{ keys?: string[], buttons?: string[] }} */ { keys = [], buttons = [] } = {}) {
    return this.call('input.release', { keys, buttons }, { timeoutMs: 5000 });
  }
  /** Presses an element of the latest ax.snapshot through accessibility: {ok, route: 'ax', center}. */
  axPress(pid, id, opts = {}) {
    return this.call('ax.press', { pid, id, ...opts });
  }
  axFocus(pid, id, opts = {}) {
    return this.call('ax.focus', { pid, id, ...opts });
  }
  /**
   * The keyboard-focused element of an allowed app: {pid, bundleId, role, value?, selection?: {location,
   * length} (UTF-16), truncated?, settable}. Refused for a password field.
   */
  focusedText(opts = {}) {
    return this.call('text.focused', opts);
  }
  /** Replaces the focused element's selection with `text` through accessibility: {ok, route: 'ax'}, or {ok: false, reason}. */
  insertText(text, opts = {}) {
    return this.call('text.insert', { text, ...opts });
  }
  /** Pastes (cmd+v) into the focused element of an allowed app; refused for a password field. */
  paste(opts = {}) {
    return this.call('input.paste', opts);
  }
  /** Hides every running app but these bundle ids (and MoPilot): {hidden: [{pid, bundleId, name}]}. */
  hideOthers(keepBundleIds) {
    return this.call('apps.hideOthers', { keepBundleIds });
  }
  /** Shows the apps hideOthers hid again, then brings `activatePid` (when given) to the front. */
  restoreApps(pids, /** @type {number | null} */ activatePid = null) {
    return this.call('apps.restore', { pids, ...(activatePid ? { activatePid } : {}) });
  }
  /** Keeps a copy of the whole clipboard (every item, every type) in the helper. */
  saveClipboard() {
    return this.call('pasteboard.save');
  }
  /** Puts the saved clipboard back (apply), or only forgets it. */
  restoreClipboard(apply = true) {
    return this.call('pasteboard.restore', { apply });
  }
}

module.exports = {
  helperFix,
  outdatedHelperText,
  GIVES_BACK,
  READ_ONLY,
  NO_LAUNCH,
  BUILT_IN_DENY,
  withFloor,
  HELPER_NAME,
  HELPER_BUNDLE_ID,
  helperAppPath,
  launchArgs,
  openHelper,
  lineDecoder,
  ComputerHelper,
  attachHelperSocket,
  HelperError,
};
