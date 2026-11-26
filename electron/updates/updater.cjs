// Auto-update from GitHub for stable releases and MoPilot’s authenticated feed for restricted channels (none without the MoPilot service).
// macOS: prepare the signed bundle in the native installer, or hand it to Electron's Squirrel.Mac on legacy installs.
// The updater downloads the zip with progress and resume. Scheduled checks are silent and run from Applications.
// Windows: no Squirrel.Windows; the same feed is polled for win32 and its installer offered (electron/updates/windows.cjs).
// Restricted feed: updateFeedUrl(platform, arch, version, ?channel=&iid=) → 204 or 200 { url, name, notes, pub_date } (url: the .zip, the Setup .exe).
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { app, autoUpdater, dialog, net } = require('../platform/ports/electronApi.cjs').api;
const { endpoints: SERVICE } = require('../platform/mopilotEndpoints.cjs');
const { noteIgnored, ignoring, messageOf } = require('../ignored.cjs');
const { userError } = require('../../shared/userError.mjs');
const { downloadUpdate } = require('./download.cjs');
const { macInstaller } = require('./macInstaller.cjs');
const { prepareDownload, commitPreparedUpdate, restartUpdate } = require('./prepare.cjs');
const { readUpdateFeed } = require('./feed.cjs');
const { refreshUpdate } = require('./refresh.cjs');
const { verifyRollbackFile, retireForRollback, stagedVersion } = require('./rollback.cjs');
const { signatureReader, UNREAD_SIGNATURE } = require('./signature.cjs');
const { scheduleUpdates } = require('./schedule.cjs');
const { STABLE_FEED_URL } = require('../../shared/stableUpdates.cjs');
const { checkInstallerFeed, openInstaller } = require('./windows.cjs');
const { prefsChanged, checkPlan, NEEDS_APPLICATIONS } = require('./plan.cjs');

/** At most one progress broadcast per this many ms while downloading. */
const PROGRESS_MS = 500;

class Updater {
  /**
   * @param {{ installId: string, broadcast: (s: object) => void, gate?: (reason: string) => Promise<boolean>,
   *   idle?: () => Promise<boolean>, token?: () => Promise<string | null>, team?: () => Promise<string | null>,
   *   downloadDir?: string, download?: typeof downloadUpdate, serve?: typeof import('./download.cjs').serveUpdate, endpoints?: typeof SERVICE,
   *   macInstaller?: ReturnType<typeof macInstaller>, activationAttempt?: (version: string, channel: string) => void }} o
   *   gate: the exit gate (electron/platform/exitGate.cjs); idle: nothing would stop on exit; downloadDir: where the
   *   macOS update is downloaded (default: userData/update-download); download, serve: the macOS download and its
   *   hand-off to Squirrel (electron/updates/download.cjs); endpoints: the MoPilot service's (null: none), for tests
   */
  constructor(o) {
    this.o = o;
    this.endpoints = /** @type {NonNullable<typeof SERVICE>} */ ('endpoints' in o ? o.endpoints : SERVICE); // null: unsupported
    /**
     * @type {{ status: string, version: string, available: { version: string, notes: string, url?: string, rollback?: import('../../shared/releaseRollback.cjs').RollbackIntent } | null,
     *          error: string | null, checkedAt: number | null, restartWhenIdle?: boolean, manual?: boolean,
     *          progress?: { version: string, received: number, total: number | null }, preparing?: boolean }}
     *   progress: while downloading on macOS; preparing: the download finished and Squirrel is unpacking it
     */
    this.state = { status: 'idle', version: app.getVersion(), available: null, error: null, checkedAt: null };
    this.channel = 'stable';
    this.auto = true;
    this.prefs = null;
    this.generation = 0;
    this.disposed = false;
    this.macInstaller = null;
    /** @type {Promise<void> | null} */
    this.activating = null;
    this.nativeOperation = null;
    this.nativeTimeout = undefined;
    this.stagedArtifact = null;
    /** @type {AbortController | null} the macOS download in flight */
    this.download = null;
    /** @type {Promise<void> | null} that download and its hand-off to Squirrel (settles without throwing) */
    this.downloadWork = null;
    /** @type {{ close: () => void } | null} the loopback server Squirrel reads the downloaded update from */
    this.served = null;
    this.idleGeneration = 0;
    /** a check while an update is ready is reading the feed */
    this.refreshing = false;
    this.installWork = null;
    /** @type {NodeJS.Timeout | undefined} gives up on a restart to update that never quit */
    this.installTimer = undefined;
    /** @type {(() => void) | undefined} stops the current update schedule */
    this.stopSchedule = undefined;
    /** @type {NodeJS.Timeout | null} waiting for the app to go idle before restarting */
    this.idleTimer = null;
    /** the user said Not Now to moving the app (asked once per run) */
    this.declinedMove = false;
    this.manual = process.platform === 'win32' || process.platform === 'linux';
    this.supported = !!this.endpoints && app.isPackaged && (process.platform === 'darwin' || this.manual);
    if (!this.supported) {
      this.state.status = 'unsupported';
      this.ready = Promise.resolve(false);
      return;
    }
    if (this.manual) {
      this.state.manual = true;
      this.ready = Promise.resolve(true);
      return;
    }
    this.signature = signatureReader(o.team, noteIgnored);
    this.macInstaller = o.macInstaller === undefined ? macInstaller(app) : o.macInstaller;
    this.ready = this.signed();
    // Squirrel only ever reads the update the updater downloaded: its check and download are the unpacking step
    autoUpdater.on('checking-for-update', () => this.nativeProgress({ status: 'downloading', preparing: true, error: null }));
    autoUpdater.on('update-available', () => this.nativeProgress({ status: 'downloading', preparing: true }));
    autoUpdater.on('update-not-available', () => this.finishNative({ status: 'idle', checkedAt: Date.now() }));
    autoUpdater.on('update-downloaded', (_e, notes, name) =>
      this.finishNative({ status: 'ready', available: { version: name, notes: notes || '' }, checkedAt: Date.now() }, true),
    );
    autoUpdater.on('error', (err) => this.nativeError(err));
  }

  /** Whether the signature lets Squirrel update this build; if not, the state it leaves (electron/updates/signature.cjs). */
  async signed() {
    const patch = await /** @type {ReturnType<typeof signatureReader>} */ (this.signature)();
    if (patch?.status === 'unsupported') this.supported = false;
    // a signature read after one that couldn't be clears that error, even if the check then stops early
    if (!this.disposed && (patch || this.state.error === UNREAD_SIGNATURE)) this.set(patch ?? { status: 'idle', error: null });
    return !patch;
  }

  /** A Squirrel failure: unpacking or verifying the downloaded update, or a restart to update. */
  nativeError(err) {
    noteIgnored('apply the update with Squirrel', err);
    const error = userError(err);
    // quitAndInstall reports its failure here with no check in flight: offer the restart again, with why
    if (!this.nativeOperation && this.state.status === 'installing') return this.installFailed(error);
    this.finishNative({ status: 'error', error, checkedAt: Date.now() });
  }

  context() {
    return { generation: this.generation, channel: this.channel };
  }

  current(context) {
    return !this.disposed && context.generation === this.generation && context.channel === this.channel;
  }

  nativeProgress(patch) {
    const operation = this.nativeOperation;
    if (operation && this.current(operation) && !operation.timedOut)
      this.set({ ...patch, error: Object.hasOwn(patch, 'error') ? this.stageError(patch.error) : this.state.error });
  }

  /** Squirrel retains downloaded artifacts even when the selected channel no longer owns them. */
  stageError(error) {
    const artifact = this.stagedArtifact;
    if (!artifact || (artifact.valid && artifact.channel === this.channel)) return error;
    if (artifact.rollbackRevoked)
      return (
        (this.macInstaller
          ? 'A prepared update was superseded by a rollback. Retry the rollback download.'
          : 'A prepared update was superseded by a rollback and may still apply on restart. Retry the rollback download before restarting.') +
        (error ? ` ${error}` : '')
      );
    return (
      `An update from ${artifact.channel !== this.channel ? 'a previous channel' : 'an earlier check'} was downloaded and may apply on restart. Check the selected channel before restarting.` +
      (error ? ` ${error}` : '')
    );
  }

  stagedState() {
    const artifact = this.stagedArtifact;
    if (artifact?.valid && artifact.channel === this.channel) return { status: 'ready', available: artifact.available, error: null };
    return { status: artifact ? 'error' : 'idle', available: null, error: this.stageError(null) };
  }

  /** Native events have no request id: retain their owner until a terminal event, even after timeout. */
  finishNative(patch, downloaded = false) {
    const operation = this.nativeOperation;
    if (!operation) return;
    this.nativeOperation = null;
    clearTimeout(this.nativeTimeout);
    this.nativeTimeout = undefined;
    this.closeFeed(this.served);
    if (this.disposed) return;
    if (downloaded) {
      if (operation.rollback) patch.available = { ...patch.available, rollback: operation.rollback };
      this.stagedArtifact = {
        channel: operation.channel,
        available: patch.available,
        valid: this.current(operation) && !operation.timedOut,
        rollbackRevoked: operation.timedOut || !this.current(operation) ? this.stagedArtifact?.rollbackRevoked : false,
      };
      // Squirrel keeps its own copy of the update it unpacked
      fs.promises
        .rm(this.downloadDir(), { recursive: true, force: true })
        .catch(ignoring('remove a downloaded update Squirrel has unpacked'));
    }
    this.settle(patch, this.current(operation) && !operation.timedOut);
  }

  /** Retire only this feed; a cleanup failure must not mask a check error or interrupt shutdown. */
  closeFeed(served) {
    if (this.served === served) this.served = null;
    try {
      served?.close();
    } catch (error) {
      noteIgnored('close the local update feed', error);
    }
  }

  /** The end of a check: a staged update keeps its state and warning; an obsolete check only clears what it showed. */
  settle(patch, live) {
    if (this.stagedArtifact) this.set({ ...patch, ...this.stagedState(), error: this.stageError(patch.error ?? null) });
    else if (live) this.set(patch);
    else this.set({ status: 'idle', error: null });
  }

  /** Download progress belongs to the downloading state only: every other state drops it. */
  set(patch) {
    const next = { ...this.state, ...patch };
    if (next.status !== 'downloading') {
      delete next.progress;
      delete next.preparing;
    }
    this.state = next;
    this.o.broadcast(this.state);
  }

  downloadDir() {
    return this.o.downloadDir ?? path.join(app.getPath('userData'), 'update-download');
  }

  feedUrl(channel = this.channel) {
    if (channel === 'stable') return STABLE_FEED_URL;
    const q = new URLSearchParams({ channel, iid: this.o.installId });
    const staged = stagedVersion(this, channel);
    if (staged) q.set('staged', staged);
    return this.endpoints.updateFeedUrl(process.platform, process.arch, app.getVersion(), q);
  }

  /**
   * The sign-in header the feed needs for beta and dogfood: the server shows those channels only to staff accounts.
   * @returns {Promise<Record<string, string>>}
   */
  async authHeaders(channel = this.channel) {
    if (channel === 'stable') return {};
    // signed out (null) asks without the header; a token that can't be read fails the check, which shows the reason
    const token = await this.o.token?.().catch((error) => {
      throw new Error(`Could not check the ${channel} channel: your MoPilot sign-in could not be read (${messageOf(error)})`);
    });
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  /**
   * Ask the feed: null when up to date, else the update with its https file. Failures name the server and the HTTP
   * status or network error.
   * @returns {Promise<{ url: string, name: string, notes: string, pub_date?: string, rollback?: import('../../shared/releaseRollback.cjs').RollbackIntent, sha256?: string, size?: number } | null>}
   */
  async readFeed(context, headers) {
    return readUpdateFeed({
      url: this.feedUrl(context.channel),
      channel: context.channel,
      version: app.getVersion(),
      stagedVersion: stagedVersion(this, context.channel),
      platform: process.platform,
      arch: process.arch,
      installId: this.o.installId,
      headers,
      fetch: (url, init) => net.fetch(url, init),
    });
  }

  /** Apply prefs. The schedule restarts only when they changed (every window applies them). */
  configure({ auto = true, channel = 'stable' } = {}) {
    const next = { auto, channel: ['beta', 'dogfood'].includes(channel) ? channel : 'stable' };
    if (!prefsChanged(this.prefs, next)) return this.state;
    const changed = this.channel !== next.channel;
    this.prefs = next;
    this.auto = next.auto;
    this.channel = next.channel;
    if (changed) {
      this.generation++;
      this.download?.abort();
      this.stopIdleWait();
      // a restart to update already under way keeps saying so: the app is quitting with the staged update
      if (this.supported && this.state.status !== 'installing') {
        if (this.stagedArtifact?.stage) {
          this.stagedArtifact.stage.cancel();
          this.stagedArtifact = null;
        }
        this.set({ ...this.stagedState(), restartWhenIdle: false });
      }
    }
    if (!this.supported) return this.state;
    this.stopSchedule?.();
    this.stopSchedule = this.auto ? scheduleUpdates(() => this.check(), { onError: ignoring('check for updates on schedule') }) : undefined;
    return this.state;
  }

  /** A check: scheduled ones are silent; `manual` (Check for updates) may ask to move the app. */
  async check({ manual = false } = {}) {
    if (this.disposed) return this.state;
    if (this.state.status === 'ready') return this.refresh();
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return this.state;
    // a Restart when idle still waiting for an update that is no longer ready ends with this check's generation
    if (this.state.restartWhenIdle) this.stopIdleWait(), this.set({ restartWhenIdle: false });
    const context = { generation: ++this.generation, channel: this.channel };
    if (!(await (this.signature ? this.signed() : this.ready)) || !this.supported || !this.current(context)) return this.state;
    if (this.manual) return this.checkFeed(context);
    if (this.nativeOperation)
      return (
        this.set({
          status: 'error',
          error: this.stageError('A previous update check is still finishing. Try again after it finishes, or restart MoPilot.'),
        }),
        this.state
      );
    // A translocated or read-only copy can't replace itself.
    const plan = checkPlan({ manual, inApplications: app.isInApplicationsFolder(), declinedMove: this.declinedMove });
    if (plan === 'skip') return this.state;
    if (plan === 'blocked') return this.set({ status: 'error', error: NEEDS_APPLICATIONS }), this.state;
    if (plan === 'ask-move') {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: 'Move MoPilot to Applications?',
        detail: 'MoPilot can only update itself from the Applications folder.',
        buttons: ['Move to Applications', 'Not Now'],
        defaultId: 0,
      });
      if (!this.current(context)) return this.state;
      if (response !== 0) {
        this.declinedMove = true;
        return this.set({ status: 'error', error: NEEDS_APPLICATIONS }), this.state;
      }
      app.moveToApplicationsFolder();
    }
    try {
      const headers = await this.authHeaders(context.channel);
      if (!this.current(context)) return this.state;
      this.set({ status: 'checking', error: this.stageError(null) });
      const update = await this.readFeed(context, headers);
      if (!this.current(context)) return this.state;
      if (!update) return this.settle({ status: 'idle', checkedAt: Date.now() }, true), this.state;
      this.startDownload(context, update, headers);
    } catch (e) {
      if (!this.current(context)) return this.state;
      return this.set({ status: 'error', error: this.stageError(messageOf(e)), checkedAt: Date.now() }), this.state;
    }
    return this.state;
  }

  /**
   * A check while an update is ready: a newer version replaces it before the restart, so a release that published
   * several versions installs only the newest instead of one after another. It shows nothing unless it finds one; a
   * restart already asked for, an older or unreadable version, and a failed read (thrown to the schedule) keep it.
   */
  async refresh() {
    return refreshUpdate(this);
  }

  /** Download the update (resuming an earlier partial download), then hand it to Squirrel. Shows progress. */
  startDownload(context, update, feedHeaders) {
    retireForRollback(this, update);
    // the sign-in goes only to MoPilot's own server, never to where the file is hosted
    const headers = new URL(update.url).origin === new URL(this.endpoints.API_BASE).origin ? feedHeaders : {};
    const abort = new AbortController();
    this.download = abort;
    const version = update.name;
    let shown = 0;
    this.set({ status: 'downloading', error: this.stageError(null), progress: { version, received: 0, total: null }, preparing: false });
    const live = () => this.current(context) && this.download === abort;
    // an aborted download may still be closing its file: the next one waits for it
    const previous = this.downloadWork ?? Promise.resolve();
    this.downloadWork = previous
      .then(() =>
        (this.o.download ?? downloadUpdate)({
          url: update.url,
          dir: this.downloadDir(),
          fetch: (url, init) => net.fetch(url, init),
          signal: abort.signal,
          headers,
          onProgress: (received, total) => {
            const now = Date.now();
            if ((received !== total && now - shown < PROGRESS_MS) || !live()) return;
            shown = now;
            this.set({ progress: { version, received, total } });
          },
        }),
      )
      .then(async (file) => {
        if (!live()) return;
        await verifyRollbackFile(file, update);
        if (live()) await prepareDownload(this, context, file, update, abort.signal);
      })
      .then(
        () => undefined,
        (error) => {
          // a newer update that failed offers the ready one it was replacing again, with why
          if (live()) this.settle({ status: 'error', error: messageOf(error), checkedAt: Date.now() }, true);
          else noteIgnored('download an obsolete update', error);
        },
      )
      .finally(() => {
        if (this.download === abort) this.download = null;
      });
  }

  /** Windows: read the feed ourselves; a newer version is offered as an installer download. */
  checkFeed(context = this.context()) {
    return checkInstallerFeed(this, context);
  }

  /**
   * Restart to update, through the exit gate. `when: 'idle'` waits until nothing would stop and then
   * restarts without asking; the gate still runs, so goals are paused.
   */
  async install({ when = 'now' } = {}) {
    // Idle scheduling must never replace installation work that is awaiting approval.
    if (when === 'idle') return this.performInstall(when);
    const available = this.state.available;
    const generation = this.generation;
    if (this.installWork && this.installWork.available === available && this.installWork.generation === generation)
      return this.installWork.promise;
    const work = { available, generation, promise: this.performInstall(when) };
    this.installWork = work;
    try {
      return await work.promise;
    } finally {
      if (this.installWork === work) this.installWork = null;
    }
  }

  async performInstall(when) {
    if (this.disposed || this.state.status !== 'ready') return false;
    const context = this.context();
    const available = this.state.available;
    const current = () => this.current(context) && this.state.status === 'ready' && this.state.available === available;
    // Windows: the installer is downloaded in the browser; a ready state there always carries its URL (checkFeed)
    if (this.manual) return openInstaller(/** @type {{ url: string }} */ (available).url, current);
    const idle = this.o.idle;
    if (when === 'idle' && idle) {
      const idleGeneration = ++this.idleGeneration;
      // a newer update replacing this one (refresh) is waited for, and restarted into once it is ready
      const currentIdle = () => this.current(context) && this.idleGeneration === idleGeneration && this.state.status === 'ready';
      this.set({ restartWhenIdle: true });
      // clearInterval ignores null
      clearInterval(/** @type {NodeJS.Timeout | undefined} */ (this.idleTimer));
      let busy = false;
      const tick = async () => {
        if (busy || !currentIdle()) return;
        busy = true;
        try {
          // a check that fails counts as busy: the next tick asks again
          if (!(await idle().catch((error) => (noteIgnored('check whether the app is idle to restart for an update', error), false))))
            return;
          if (!currentIdle()) return;
          clearInterval(/** @type {NodeJS.Timeout | undefined} */ (this.idleTimer));
          this.idleTimer = null;
          // a restart that was refused (the exit gate) or failed must not leave "Restarting when idle" stuck: the
          // banner offers it again, with why when it failed
          await this.install().then(
            (restarted) => restarted || (currentIdle() && this.set({ restartWhenIdle: false })),
            (error) => {
              if (currentIdle()) this.set({ restartWhenIdle: false, error: messageOf(error) });
              else noteIgnored('finish an obsolete idle update restart', error);
            },
          );
        } finally {
          busy = false;
        }
      };
      this.idleTimer = setInterval(tick, 3000);
      // cannot reject: tick handles a failed probe and a failed restart itself
      void tick();
      return true;
    }
    if (this.o.gate && !(await this.o.gate('update'))) return false;
    if (!current()) return false;
    return restartUpdate(this);
  }

  /** The restart to update failed: the downloaded update is still ready, so offer it again. */
  installFailed(error) {
    clearTimeout(this.installTimer);
    this.installTimer = undefined;
    if (this.disposed || this.state.status !== 'installing') return;
    // a Restart when idle that got here has already stopped waiting: offer it again too
    if (this.macInstaller) {
      this.stagedArtifact?.stage?.cancel();
      this.stagedArtifact = null;
      this.set({ status: 'error', available: null, error, restartWhenIdle: false });
    } else this.set({ status: 'ready', error, restartWhenIdle: false });
  }

  /** Stop waiting for the app to go idle to restart. */
  stopIdleWait() {
    this.idleGeneration++;
    clearInterval(/** @type {NodeJS.Timeout | undefined} */ (this.idleTimer));
    this.idleTimer = null;
  }

  installOnQuit() {
    if (!this.macInstaller) return;
    if (this.state.status === 'installing') return this.activating?.catch(ignoring('finish the restart handoff'));
    const activating = commitPreparedUpdate(this, false).catch(ignoring('activate the prepared update on quit'));
    // Freeze update selection in the same turn as handing off to the installer.
    this.dispose();
    return activating;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.stopIdleWait();
    this.download?.abort();
    this.stagedArtifact?.stage?.cancel();
    this.closeFeed(this.served);
    clearTimeout(this.nativeTimeout);
    clearTimeout(this.installTimer);
    this.stopSchedule?.();
  }
}

module.exports = { Updater, prefsChanged, checkPlan };
