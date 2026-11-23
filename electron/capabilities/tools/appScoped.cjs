// App-scoped (background) desktop control: the desktop_app_* tools, the default way agents work in a Mac
// app on every harness (Claude Code sees them on mopilot_computer as app_*, Codex and ACP sessions through
// sage-mcp under their registry names). Each call targets one window of one granted app, which is
// captured where it is (covered, on another Space, minimized) and acted in without bringing the app to
// the front or moving the user's pointer: the helper's app.* requests use accessibility first and
// events posted to the app's own process second, and refuse with unsupported(<reason>) rather than
// falling back to global input.
//
// Policy is the desktop_* tools' own (DesktopControl): the chat's request_access grants and tiers, the
// deny list, read-only modes, attendance, and confirmation of actions that can't be undone. There is no
// takeover card (the screen is not taken over); instead each app is locked to one chat while it acts
// there, so different chats can work in different apps at once. A chat that holds the display-scope
// lock (desktop_* input) excludes everyone else's background input.
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { DONE_CONTINUE } = require('../../../shared/doneContinue.mjs');
const { refuseSelf } = require('../contract/controlRefusals.cjs');
const { SCHEDULED_OFF } = require('./computerErrors.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { SPECS, TOOL_NAMES } = require('./appScopedSpecs.cjs');
const {
  indexWindowElements,
  elementAt,
  normalizeAppKey,
  keyVerdict,
  appHelperError,
  observedEffect,
  withHint,
  NO_CHANGE_HINT,
  TAKEOVER_WAIT_MS,
  isMenuDisabled,
  menuDisabledError,
  stillActing,
} = require('./appScopedUtil.cjs');
const { guarded, shuttingDown, tokenLiveness } = require('../contract/actionGuard.cjs');
const { waitForHandBack, stoppedWaiting } = require('./takeoverWait.cjs');
const { AppScopedBatch } = require('./appScopedBatch.cjs');
const { NO_LADDER } = require('./appScopedLadder.cjs');
const { filePanel } = require('./appScopedFilePanel.cjs');
const { SCRIPT_SPECS, appScript, shortcuts } = require('./appScopedScript.cjs');

/** Every tool this control serves: the desktop_app_* tools, the script tool and the Shortcuts tools. */
const ALL_SPECS = [...SPECS, ...SCRIPT_SPECS];

// AppScopedControl holds the state (sessions, app locks, take-overs) and extends the layers that act on it, each in its
// own module and typed against it with @this: appScopedCapture (screenshots) <- appScopedActions (targets and input)
// <- appScopedBatch (menus, release, batches). The specs are appScopedSpecs.cjs and the pure helpers appScopedUtil.cjs.
class AppScopedControl extends AppScopedBatch {
  /**
   * @param {object} o
   * @param {InstanceType<typeof import('./desktop.cjs').DesktopControl>} o.desktop grants, tiers, the helper start and the permission card
   * @param {InstanceType<typeof import('../computer.cjs').ComputerHelper>} o.helper
   * @param {any} o.cu the computer-use coordinator (attendance, the display-scope lock holder, the chat's mode)
   * @param {InstanceType<typeof import('../contract/approvals.cjs').ApprovalBroker>} o.broker
   * @param {{ thumbnailDue(chatId: string): boolean, acted(chatId: string, info: object): void, approach(chatId: string, info: object): Promise<void>, interrupted(chatId: string, token?: object): void, signalFor?(chatId: string, token: object): string | null, turnEnded?(chatId: string): void }} [o.visibility] the phantom
   *   cursor and the chat's live thumbnail (appVisibility.cjs): told where each action landed
   * @param {(chatId: string, app: {bundleId: string, name: string}, held: boolean) => void} [o.onLock] a chat started (true)
   *   or stopped (false) working in an app: the notifications and the chat's control strip
   * @param {import('./appScopedLadder.cjs').Ladder} [o.ladder] the escalation ladder's setting and per-app memory
   *   (none: no brief foreground, nothing remembered)
   * @param {number} [o.settleCapMs] how long the helper may wait for the app to settle after an action (default 600)
   * @param {number} [o.takeoverWaitMs]
   */
  constructor(o) {
    super();
    this.desktop = o.desktop;
    this.helper = o.helper;
    this.cu = o.cu;
    this.broker = o.broker;
    this.visibility = o.visibility || null;
    this.onLock =
      o.onLock ||
      (() => {
        /* no lock listener */
      });
    this.ladder = o.ladder || NO_LADDER;
    this.settleCapMs = o.settleCapMs ?? 600;
    this.takeoverWaitMs = o.takeoverWaitMs ?? TAKEOVER_WAIT_MS;
    /** per chat: the stop epoch and, per app, the window last captured and each window's frame and elements */
    this.sessions = new Map();
    /** lowercased bundle id -> { chatId, windows: Set<number> }: one chat acts in an app at a time */
    this.locks = new Map();
    /** lowercased bundle id -> { chatId, name, waiters: Set<(err?) => void> }: apps the user took over from a chat */
    this.held = new Map();
    /** the helper has no app.batch (an older build): batches go one request per action */
    this.noHelperBatch = false;
    this.batchSeq = 0;
  }

  /**
   * Registry tool definitions; each handler authorizes its own call.
   * @returns {import('../contract/registry.cjs').ToolDef[]}
   */
  tools() {
    return ALL_SPECS.map((s) => ({ ...s, authorizesItself: true, handler: (args, ctx) => this.run(s.name, args || {}, ctx) }));
  }

  session(chatId) {
    let s = this.sessions.get(chatId);
    if (!s) this.sessions.set(chatId, (s = { epoch: 0, apps: new Map() }));
    return s;
  }

  /** Esc or Stop: a running batch stops before its next action (in the helper too), and input waiting for the user gives up. */
  interrupt(chatId) {
    const s = this.sessions.get(chatId);
    this.visibility?.interrupted(chatId);
    if (s) {
      s.epoch++;
      if (s.batchId)
        this.helper.call('app.cancel', { batchId: s.batchId }).catch((error) => {
          // the batch may already have finished; the epoch above stops it before its next action anyway
          noteIgnored('cancel a running app batch on Stop', error);
        });
    }
    for (const h of this.held.values()) if (h.chatId === chatId) for (const done of [...h.waiters]) done(stoppedWaiting());
  }

  /** The turn ended: a batch stops, the chat's app locks go, and so does any take-over from its strip. */
  turnEnded(chatId) {
    this.interrupt(chatId);
    this.visibility?.turnEnded?.(chatId);
    this.releaseLocks(chatId);
    for (const [k, h] of this.held) if (h.chatId === chatId) this.held.delete(k);
  }

  /**
   * The user took an app over from the chat's control strip: the chat's input to it waits until they
   * hand it back (observing goes on), and a batch running there stops before its next action.
   */
  takeOver(chatId, bundleId) {
    const k = String(bundleId || '').toLowerCase();
    const l = this.locks.get(k);
    if (!k || !l || l.chatId !== chatId) return false;
    if (!this.held.has(k)) this.held.set(k, { chatId, name: l.name, waiters: new Set() });
    const s = this.sessions.get(chatId);
    if (s?.batchId)
      this.helper.call('app.cancel', { batchId: s.batchId }).catch((error) => {
        // the batch may already have finished; input to the taken-over app waits either way
        noteIgnored('cancel a running app batch when the user takes over', error);
      });
    return true;
  }

  /** The user handed the app back: input that was waiting goes on. */
  handBack(chatId, bundleId) {
    const k = String(bundleId || '').toLowerCase();
    const h = this.held.get(k);
    if (!h || h.chatId !== chatId) return false;
    this.held.delete(k);
    for (const done of [...h.waiters]) done();
    return true;
  }

  /** Whether the user has taken this app over from the chat. */
  takenOver(chatId, bundleId) {
    return this.held.get(String(bundleId || '').toLowerCase())?.chatId === chatId;
  }

  /** Input to an app the user took over waits for them to hand it back (or Stop, or the cap). */
  async waitForUser(c) {
    const h = this.held.get(c.app.bundleId.toLowerCase());
    if (!h) return;
    await waitForHandBack(h.waiters, {
      signal: c.ctx.signal,
      ms: this.takeoverWaitMs,
      capMessage: `The user took over ${c.app.name} and hasn't handed it back. Ask them to click "${DONE_CONTINUE}" in the chat, or work in another app.`,
    });
  }

  /** The chat was archived or deleted. */
  forget(chatId) {
    this.turnEnded(chatId);
    this.sessions.delete(chatId);
  }

  /** Releases the chat's locks (all, one app's, or one window's); returns the apps released. */
  releaseLocks(chatId, /** @type {string | null} */ bundleId = null, /** @type {number | null} */ windowId = null) {
    const out = [];
    for (const [k, l] of this.locks) {
      if (l.chatId !== chatId || (bundleId && k !== bundleId.toLowerCase())) continue;
      if (windowId != null) {
        l.windows.delete(windowId);
        if (l.windows.size) continue;
      }
      this.locks.delete(k);
      out.push(l.name);
      this.onLock(chatId, { bundleId: l.bundleId, name: l.name }, false);
    }
    return out;
  }

  /** The other chat holding a background lock on an app, or null (display-scope control asks before it acts). */
  /** Whether a chat holds any app for background control (the helper must not be relaunched under it). */
  busy() {
    // a lock whose turn ended or was stopped does not count (liveLock lets go of it)
    return [...this.locks.keys()].some((k) => this.liveLock(k));
  }

  /** The chats working in apps in the background now (a live lock each): a person's Esc stops them too. */
  workingChats() {
    return [...new Set([...this.locks.keys()].map((k) => this.liveLock(k)?.chatId).filter((c) => !!c))];
  }

  lockedBy(bundleId, chatId) {
    const l = bundleId ? this.liveLock(String(bundleId).toLowerCase()) : null;
    return l && l.chatId !== chatId ? l.chatId : null;
  }

  /** The apps other chats are working in in the background (their bundle ids): hide-before-action leaves them on screen. */
  lockedElsewhere(chatId) {
    return [...this.locks.keys()]
      .map((k) => this.liveLock(k))
      .filter((l) => l && l.chatId !== chatId)
      .map((l) => /** @type {NonNullable<typeof l>} */ (l).bundleId);
  }

  /**
   * The lock on an app (by lowercased bundle id), or null. A lock is granted per `(chat, turn)` token: one whose turn
   * ended or was stopped is let go here, so the app is free again for the chat's next turn or another chat.
   * @param {string} k
   */
  liveLock(k) {
    const l = this.locks.get(k);
    if (!l || !l.live || l.live()) return l ?? null;
    this.releaseLocks(l.chatId, l.bundleId);
    return null;
  }

  /** Takes the app for the chat: refused while another chat acts in it or holds the whole screen. */
  lock(chatId, app, windowId) {
    // a stopped call never takes (or takes back) an app the turn already let go of
    stillActing();
    if (this.cu.closed) throw shuttingDown();
    const holder = this.cu.liveHolder();
    if (holder && holder !== chatId)
      throw new ToolError('Another chat has taken over the screen (display-scope control). Wait for it to finish, then try again.', 'busy');
    const k = app.bundleId.toLowerCase();
    const l = this.liveLock(k);
    if (l && l.chatId !== chatId)
      throw new ToolError(
        `Another chat is working in ${app.name} in the background. Wait for it to finish, or work in another app.`,
        'busy',
      );
    if (l) l.windows.add(windowId);
    else {
      // granted to the call's (chat, turn) token (liveLock)
      this.locks.set(k, { chatId, name: app.name, bundleId: app.bundleId, windows: new Set([windowId]), live: tokenLiveness() });
      this.onLock(chatId, { bundleId: app.bundleId, name: app.name }, true);
    }
  }

  async run(name, args, ctx = {}) {
    const chatId = this.cu.chatOf(ctx.chatId);
    const s = this.session(chatId);
    // the call acts only while it isn't stopped and the chat's turn hasn't ended or been interrupted since it began
    return guarded({ signal: ctx.signal ?? null, epoch: () => s.epoch }, () => this.runGuarded(chatId, name, args, ctx));
  }

  /** run(), inside the call's guard. */
  async runGuarded(chatId, name, args, ctx, retried = false) {
    const owner = this.cu.permissionOwner(chatId);
    try {
      if (this.cu.session(chatId)?.scheduled?.computer === false) throw new ToolError(SCHEDULED_OFF, 'refused');
      const out = await this.dispatch(chatId, name, args, ctx);
      await this.cu.recoverPermissionGuide(chatId, owner, name, this.helper);
      return out;
    } catch (e) {
      const err = await this.desktop.explain(chatId, appHelperError(e), owner);
      if (retried) throw err;
      await this.desktop.askAfterRefusal(chatId, name, err, ctx);
      return this.runGuarded(chatId, name, args, ctx, true);
    }
  }

  async dispatch(chatId, name, args, ctx) {
    if (name === 'desktop_app_release') return this.release(chatId, args);
    // the Shortcuts app needn't be running: its command-line runner does the work
    if (name === 'desktop_shortcut_list' || name === 'desktop_shortcut_run') return shortcuts(this, chatId, name, args, ctx);
    const app = this.app(chatId, args.app);
    const helper = await this.desktop.ready();
    const pid = await this.pidOf(helper, app);
    const c = { chatId, app, pid, helper, ctx, s: this.session(chatId) };
    switch (name) {
      case 'desktop_app_list_windows':
        return this.listWindows(c);
      case 'desktop_app_batch':
        return this.batch(c, args);
      case 'desktop_app_menu':
        return this.menu(c, args);
      case 'desktop_app_bring_to_current_space':
        return this.bring(c, args);
      case 'desktop_app_file_panel':
        return filePanel(this, c, args);
      case 'desktop_app_script':
        return appScript(this, c, args);
      default:
        return this.one(c, name.replace(/^desktop_app_/, ''), args);
    }
  }

  /** The granted app a name or bundle id names. */
  app(chatId, query) {
    refuseSelf(query);
    const app = this.desktop.findGranted(chatId, query);
    if (!app) throw new ToolError(`${query || 'That app'} isn't granted in this chat; call desktop_request_access first`, 'denied');
    return app;
  }

  async pidOf(helper, app) {
    const running = ((await helper.listApps()).apps || []).find((a) => String(a.bundleId).toLowerCase() === app.bundleId.toLowerCase());
    if (!running?.pid)
      throw new ToolError(
        `${app.name} isn't running. Open it with desktop_open_application, then use the desktop_app_* tools.`,
        'unavailable',
      );
    return running.pid;
  }

  /** The tier an action needs in the app; refused when the grant is weaker. */
  need(c, action, tier) {
    if (P.tierRank(c.app.tier) >= P.tierRank(tier)) return;
    throw new ToolError(
      `${c.app.name} is granted at tier "${c.app.tier}" (${P.TIER_LABEL[c.app.tier]}), which doesn't allow ${action}.${c.app.tier === 'read' ? ' For a web page use the browser tools.' : ' For commands use the shell tool; only left clicks and scrolling work here.'}`,
      'tier',
    );
  }

  /** What may stop background input before it runs: a read-only mode, nobody being there when that's off. No takeover card. */
  async preflight(c) {
    if (this.cu.anchor(c.chatId) === 'readOnly')
      throw new ToolError('This chat is in a read-only mode: desktop control can only look', 'read_only');
    const unattended = await this.cu.unattended(c.chatId, c.ctx);
    if (unattended && !this.cu.unattendedAllowed()) {
      const message = `Controlling ${c.app.name} with nobody here is switched off (${unattended}). MoPilot paused this chat and asked the user; don't retry.`;
      this.cu.onUnattended(c.chatId, {
        app: { bundleId: c.app.bundleId, name: c.app.name },
        code: 'unattended',
        message,
        need: null,
        tool: 'desktop_app_input',
      });
      throw new ToolError(message, 'unattended');
    }
  }

  appState(c) {
    const k = c.app.bundleId.toLowerCase();
    let a = c.s.apps.get(k);
    if (!a) c.s.apps.set(k, (a = { name: c.app.name, lastWindow: null, windows: new Map() })); // name: action memory finds it by name
    return a;
  }

  windowIdOf(c, args) {
    return typeof args.window_id === 'number' ? args.window_id : (this.appState(c).lastWindow ?? undefined);
  }

  base(c, extra = {}) {
    return { pid: c.pid, bundleIds: [c.app.bundleId], ...extra };
  }

  async listWindows(c) {
    this.need(c, 'listing windows', 'read');
    const r = await c.helper.call('app.windows', this.base(c));
    const windows = (r.windows || []).map((w) => ({
      window_id: w.window_id,
      title: w.title,
      is_main: !!w.is_main,
      is_minimized: !!w.is_minimized,
      is_hidden: !!w.is_hidden,
      is_off_space: !!w.is_off_space,
      ...(w.is_auxiliary ? { is_auxiliary: true } : {}),
      bounds: w.bounds,
    }));
    return [
      {
        type: 'text',
        text: JSON.stringify({ app: c.app.name, bundleId: c.app.bundleId, frontmost: !!r.app?.frontmost, windows }, null, 1),
      },
    ];
  }
}

module.exports = {
  AppScopedControl,
  SPECS,
  TOOL_NAMES,
  indexWindowElements,
  elementAt,
  normalizeAppKey,
  keyVerdict,
  appHelperError,
  observedEffect,
  withHint,
  NO_CHANGE_HINT,
  TAKEOVER_WAIT_MS,
  isMenuDisabled,
  menuDisabledError,
};
