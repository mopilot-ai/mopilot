// Desktop control tools (desktop_*): the computer-use surface agents get on every harness, through the
// capability registry (Claude's SDK MCP channel, Codex's thread MCP config, an ACP session's MCP server).
// The model asks for a set of apps once (desktop_request_access, one card); each app gets a tier by
// its kind (browsers view only, terminals and IDEs click and scroll, the rest full control). Screenshots
// show only the granted apps' windows. Every action, and every action of a batch, re-checks the
// frontmost app (and the app under the pointer) against the chat's grants and tiers before it runs.
// The first input in a chat asks the user once whether it may take over the screen (or, with lazy
// takeover, the access card asked it already); while a chat holds the desktop, an overlay shows it and
// Esc stops it, and only one chat holds it at a time. An input action brings the app it is for to the
// front when another app is in front; with hide-before-action, MoPilot's own windows and the apps
// that aren't granted are hidden while the chat holds the desktop, and come back when its turn ends.
// Text goes in through accessibility or a paste where it can (no autocorrect), and is checked after.
// Whatever the tools put on the clipboard, the user's own clipboard comes back when the turn ends.
//
// The specs are plain JSON schema (SPECS in desktopSpecs.cjs), so any harness adapter can list them; the
// handlers are harness-neutral (DesktopControl.tools() gives registry tools).
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { SCHEDULED_OFF } = require('./computerErrors.cjs');
const { helperError } = require('./computer.cjs');
const P = require('../contract/desktopPolicy.cjs');
const { SETTLE_MS, TURN_END_MS, VERIFY_MS, SPECS, ACTION_SPECS, ACTIONS, TOOL_NAMES } = require('./desktopSpecs.cjs');
const { indexElements, processAncestry, onboarding, permissionLabel, sleep } = require('./desktopUtil.cjs');
const { DesktopTeach } = require('./desktopTeach.cjs');
const { TeachOverlay } = require('../teachOverlay.cjs');
const { guarded, mayAct } = require('../contract/actionGuard.cjs');

/* -- the tools ---------------------------------------------------- */
// DesktopControl holds the state and extends the layers that act on it, each in its own module and typed against it
// with @this: desktopAccess (grants, clipboard) <- desktopGate (screen, consent, lock, gate) <- desktopActions (input)
// <- desktopCapture (screenshots, batches) <- desktopTeach (teach mode, full control). The specs are desktopSpecs.cjs and the helpers desktopUtil.cjs.
/** @typedef {{ readText(): string, writeText(text: string): void }} Clipboard */
/** @typedef {{ hide(chatId?: string | null): boolean | Promise<boolean>, show(focus: boolean): void, attend?(): boolean }} DesktopHost */
/** @typedef {{ board: Clipboard, chats: Set<string>, via: 'text' | 'helper', text: string, written: string | null }} Clip */

// Calls that only look: run again after a grant they repeat no input (the rule computer_screenshot follows).
const OBSERVE = new Set([
  'desktop_screenshot',
  'desktop_zoom',
  'desktop_app_screenshot',
  'desktop_app_zoom',
  'desktop_app_ax_find',
  'desktop_app_list_windows',
]);

// The card's owner for each refusal explain() raised it for: absent when the failure belonged to a retired lifecycle.
const REFUSALS = new WeakMap();

class DesktopControl extends DesktopTeach {
  /**
   * @param {object} o
   * @param {InstanceType<typeof import('../computer.cjs').ComputerHelper>} o.helper
   * @param {InstanceType<typeof import('./computer.cjs').ComputerUse>} o.cu the computer-use coordinator: the desktop lock, the activity bar, attendance, the permission card
   * @param {InstanceType<typeof import('../grants.cjs').GrantStore>} o.grants persisted grants (Settings) and the user's deny list
   * @param {InstanceType<typeof import('../contract/approvals.cjs').ApprovalBroker>} o.broker
   * @param {Clipboard | null} [o.clipboard]
   * @param {{ BrowserWindow: any, screen: any, clipboard?: Clipboard } | null} [o.electron] Electron's main-process modules: the clipboard (unless o.clipboard) and the teach-mode tooltip's window
   * @param {{ suspendEscape<T>(fn: () => Promise<T>): Promise<T> } | null} [o.indicator] lifts the Esc shortcut while the agent sends Escape itself
   * @param {() => Promise<Set<number>>} [o.hostPids] the processes hosting the agent (never granted)
   * @param {{ name?: string, bundleId?: string, path?: string }} [o.helperInfo] for the permission onboarding text
   * @param {(chatId: string) => void} [o.onTurnEnded] after turnEnded let go (the indicator comes down)
   * @param {(chatId: string) => (string | null | Promise<string | null>)} [o.modelOf] the chat's model, for the screenshot size
   * @param {() => boolean} [o.hideBeforeAction] hide MoPilot's windows and the apps that aren't granted while a chat holds the desktop
   * @param {DesktopHost | null} [o.host] MoPilot's own windows
   * @param {(bundleId: string | undefined, chatId: string) => string | null} [o.appLocked] the other chat working in that app in the background, if any
   * @param {(chatId: string) => string[]} [o.lockedElsewhere] the apps other chats are working in in the background (never hidden)
   * @param {InstanceType<typeof import('../teachOverlay.cjs').TeachOverlay> | null} [o.teach] the teach-mode tooltip (desktop_teach_step); without one teach mode is unavailable
   * @param {number} [o.settleMs]
   * @param {number} [o.verifyMs]
   */
  constructor(o) {
    super();
    this.helper = o.helper;
    this.cu = o.cu;
    this.grants = o.grants;
    this.broker = o.broker;
    this.clipboard = o.clipboard || o.electron?.clipboard || null;
    this.indicator = o.indicator || null;
    this.hostPids = o.hostPids || (() => processAncestry());
    this.helperInfo = o.helperInfo || {};
    this.onTurnEnded =
      o.onTurnEnded ||
      (() => {
        /* no turn-end listener */
      });
    this.appLocked = o.appLocked || (() => null);
    this.lockedElsewhere = o.lockedElsewhere || (() => []);
    this.settleMs = o.settleMs ?? SETTLE_MS;
    /** the helper waits for the screen to settle (screen.settle); false after an older helper said it has no such request */
    this.screenSettle = true;
    this.verifyMs = o.verifyMs ?? VERIFY_MS;
    this.modelOf = o.modelOf || (() => null);
    this.hideBeforeAction = o.hideBeforeAction || (() => false);
    this.host = o.host || null;
    this.teachOverlay = o.teach || new TeachOverlay({ electron: o.electron || null, note: noteIgnored });
    /** the chats on a teach tour (one tour on the Mac at a time) */
    /** @type {Set<string>} */
    this.teaching = new Set();
    /** per chat: grants, flags, consent, the screenshot frame and its elements */
    this.sessions = new Map();
    /** input runs one call at a time, across chats */
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    this.hostPidsP = null;
    /**
     * while a chat holds the desktop with hide-before-action: {chatId, previous, hidden, others, hostHidden, front}
     * @type {{ chatId: string, previous: { pid: number, host: boolean } | null | undefined, hidden: { pid: number, bundleId?: string }[],
     *          others: boolean, hostHidden: boolean, front?: { show: () => void, until: number } } | null}
     */
    this.screen = null;
    /**
     * the user's clipboard, kept while the tools use it: {chats, via: 'helper' | 'text', text, written}
     * @type {Clip | null}
     */
    this.clip = null;
  }

  /**
   * Registry tool definitions; each handler authorizes its own call.
   * @returns {import('../contract/registry.cjs').ToolDef[]}
   */
  tools() {
    return SPECS.map((s) => ({ ...s, authorizesItself: true, handler: (args, ctx) => this.run(s.name, args || {}, ctx) }));
  }

  session(chatId) {
    let s = this.sessions.get(chatId);
    if (!s) {
      s = {
        apps: new Map(),
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
        consent: false,
        display: null,
        geom: null,
        elements: [],
        lastApp: null,
        epoch: 0,
        held: { keys: new Set(), buttons: new Set() },
      };
      this.sessions.set(chatId, s);
    }
    return s;
  }

  /** The chat was archived or deleted: let go of anything it holds and forget its grants, consent and screenshot frame. */
  async forget(chatId) {
    if (!chatId) return;
    if (this.holders().includes(chatId)) await this.turnEnded(chatId);
    this.sessions.delete(chatId);
    // the apps allowed in the chat go with it
    for (const g of this.grants?.chat?.(chatId) ?? []) {
      try {
        this.grants.revoke(chatId, g.bundleId);
      } catch (error) {
        noteIgnored("remove an archived chat's computer permissions", error);
      }
    }
  }

  /** Settings' Remove: from a chat's saved list and its live session (the next action asks again), or (chatId null) from every chat's list. */
  revoke(chatId, bundleId) {
    const removed = this.grants.revoke(chatId, bundleId);
    const dropped = chatId ? !!this.sessions.get(chatId)?.apps.delete(bundleId.toLowerCase()) : false;
    return removed || dropped;
  }

  /** The chats holding something on the Mac: the desktop lock, held keys or buttons, hidden apps, the user's clipboard. */
  holders() {
    const out = new Set();
    if (this.cu.controlling) out.add(this.cu.controlling);
    if (this.screen) out.add(this.screen.chatId);
    for (const id of this.clip?.chats ?? []) out.add(id);
    for (const id of this.teaching) out.add(id);
    for (const [id, s] of this.sessions) if (s.held.keys.size || s.held.buttons.size) out.add(id);
    return [...out];
  }

  /**
   * The app quits or computer use is switched off: every chat lets go while the helper still runs (held input
   * released, hidden apps shown, the clipboard put back), and nothing takes the desktop again after.
   */
  async letGoAll() {
    this.cu.closed = true;
    this.teachOverlay?.dispose();
    await Promise.all(this.holders().map((id) => this.turnEnded(id)));
  }

  /**
   * The helper crashed or quit: what it held for the chats (hidden apps, held input) waits for a relaunched helper
   * to give it back, and the user's clipboard comes back from the text kept here. Each holder's turn lets go now.
   */
  async helperExited() {
    await Promise.all(this.holders().map((id) => this.turnEnded(id)));
  }

  /**
   * A helper to give things back with: the running one, or one relaunched for it (after a crash). False when none starts.
   * @returns {Promise<boolean>}
   */
  async helperToRestore() {
    if (this.helper.running) return true;
    try {
      await this.helper.start();
      return true;
    } catch (error) {
      // nothing can be given back through the helper; the rest of the cleanup still runs
      noteIgnored('relaunch the computer-use helper to give the Mac back', error);
      return false;
    }
  }

  /** Esc or Stop: a running batch stops before its next action. */
  interrupt(chatId) {
    const s = this.sessions.get(chatId);
    if (s) s.epoch++;
    this.endTeach(chatId);
  }

  /**
   * The chat's turn ended (finished, stopped, interrupted, the harness died): let go of held keys and
   * buttons and of the desktop. Idempotent, and done within two seconds whatever the helper does.
   */
  async turnEnded(chatId) {
    const s = this.sessions.get(chatId);
    if (s) s.epoch++;
    this.endTeach(chatId);
    await this.letGo(chatId);
    this.onTurnEnded(chatId);
  }

  /**
   * Lets go of what the chat holds on the Mac: held keys and buttons, the desktop lock, hidden apps, the user's clipboard.
   * Bounded by TURN_END_MS whatever the helper does, and best effort.
   * @param {string} chatId
   */
  async letGo(chatId) {
    const s = this.sessions.get(chatId);
    const work = (async () => {
      if (s && (s.held.keys.size || s.held.buttons.size)) {
        const held = { keys: [...s.held.keys], buttons: [...s.held.buttons] };
        s.held.keys.clear();
        s.held.buttons.clear();
        if (await this.helperToRestore())
          await this.helper.releaseInput(held).catch((error) => {
            // the helper may have stopped; its input is released with it
            noteIgnored('let go of held keys and buttons at the end of a turn', error);
          });
      }
      await this.cu.release(chatId).catch?.((error) => {
        // turn-end cleanup is best effort; the rest still runs
        noteIgnored('release the desktop lock at the end of a turn', error);
      });
      await this.restoreScreen(chatId);
      await this.restoreClipboard(chatId);
    })();
    await Promise.race([
      work.catch((error) => {
        // turn-end cleanup is best effort and bounded by the timer
        noteIgnored('clean up the desktop at the end of a turn', error);
      }),
      sleep(TURN_END_MS),
    ]);
  }

  /** The apps the chat may use, by lowercased bundle id: this chat's request_access grants and the saved ones (Settings), each capped by its kind's tier. */
  granted(chatId) {
    const s = this.session(chatId);
    const out = new Map();
    const deny = this.grants?.deny?.() || [];
    const blocked = (id) => P.anyMatch(P.HOST_BUNDLES, id) || P.anyMatch(deny, id);
    const LEVEL_TIER = { view: 'read', click: 'click', full: 'full' };
    for (const g of this.grants?.forChat?.(chatId) || []) {
      const level = LEVEL_TIER[g.level];
      if (!level || blocked(g.bundleId)) continue;
      const cap = P.tierOf(g.bundleId);
      const tier = P.tierRank(level) < P.tierRank(cap) ? level : cap;
      const k = g.bundleId.toLowerCase();
      if (!out.has(k) || P.tierRank(out.get(k).tier) < P.tierRank(tier))
        out.set(k, { bundleId: g.bundleId, name: g.name || g.bundleId, tier, saved: true });
    }
    for (const [k, g] of s.apps) {
      if (blocked(g.bundleId)) continue;
      if (!out.has(k) || P.tierRank(out.get(k).tier) < P.tierRank(g.tier)) out.set(k, g);
    }
    return out;
  }

  async ready() {
    try {
      await this.helper.start();
    } catch (e) {
      throw new ToolError(`Desktop control isn't available: ${e?.message ?? e}`, 'unavailable');
    }
    return this.helper;
  }

  /**
   * Runs fn after every earlier call has settled.
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    // the next call waits for this one to settle; its error reaches the caller through run
    this.queue = Promise.allSettled([run]);
    return run;
  }

  /** One tool call. A missing macOS permission shows the permission card in the chat. */
  async run(tool, args, ctx = {}) {
    const chatId = this.cu.chatOf(ctx.chatId);
    const s = this.session(chatId);
    // the call acts only while it isn't stopped and the chat's turn hasn't ended or been interrupted since it began
    return guarded({ signal: ctx.signal ?? null, epoch: () => s.epoch }, () => this.runGuarded(chatId, tool, args, ctx));
  }

  /** run(), inside the call's guard. */
  async runGuarded(chatId, tool, args, ctx, retried = false) {
    const owner = this.cu.permissionOwner(chatId);
    try {
      if (this.cu.session(chatId)?.scheduled?.computer === false) throw new ToolError(SCHEDULED_OFF, 'refused');
      const out = await this.dispatch(chatId, tool, args, ctx);
      await this.cu.recoverPermissionGuide(chatId, owner, tool, this.helper);
      return out;
    } catch (e) {
      const err = await this.explain(chatId, e, owner);
      if (retried) throw err;
      // the card is up and macOS was asked: the grant arrived, so a call that only looks runs again
      await this.askAfterRefusal(chatId, tool, err, ctx);
      return this.runGuarded(chatId, tool, args, ctx, true);
    }
  }

  /**
   * The permission card is up for `err`: ask macOS (once while the app runs) and wait, bounded, for the grant, so the
   * call carries on by itself. Resolves when the call may run again; otherwise throws `err` (no card of the current
   * lifecycle, nobody there to answer, not granted in time, stopped) or, for a call that acts, says the grant landed
   * and the model must call again: input may already have reached the app before its follow-up failed.
   */
  async askAfterRefusal(chatId, tool, err, ctx) {
    const refusal = REFUSALS.get(err);
    const permission = /** @type {{ permission?: string }} */ (err).permission;
    if (!refusal || !permission || !this.cu.permissionMayAct(chatId, refusal) || (await this.cu.unattended(chatId, ctx))) throw err;
    const granted = await this.cu.awaitGrant(chatId, refusal, permission);
    // Try again may have cleared the card while waiting; only a stopped call or a retired lifecycle ends it
    if (!granted || !mayAct() || !this.cu.permissionLive(refusal.lifecycle)) throw err;
    if (OBSERVE.has(tool)) return;
    await this.cu.recheck(chatId);
    throw new ToolError(`macOS now allows ${permissionLabel(permission)}. Call ${tool} again.`, 'permission_granted');
  }

  /** A helper failure as the model should see it; a missing permission also raises the permission card. */
  async explain(chatId, e, owner = this.cu.permissionOwner(chatId)) {
    /** @type {InstanceType<typeof ToolError> & { permission?: string }} */
    const err = e instanceof ToolError ? e : helperError(e);
    if (err.code !== 'permission') return err;
    const permission = err.permission || 'accessibility';
    const refusal = this.cu.showPermissionGuide(chatId, permission, owner);
    // Screen Recording only takes effect in a new helper process: relaunch it on the next call
    // (not while a chat holds anything the helper keeps: hidden apps, held input, the whole clipboard)
    if (permission === 'screenRecording' && refusal && this.cu.permissionCurrent(chatId, refusal) && !this.holders().length)
      this.helper.stop();
    const out = Object.assign(new ToolError(onboarding(permission, this.helperInfo), 'permission'), { permission });
    if (refusal) REFUSALS.set(out, refusal);
    return out;
  }

  async dispatch(chatId, tool, args, ctx) {
    switch (tool) {
      case 'desktop_request_access':
        return this.requestAccess(chatId, args, ctx);
      case 'desktop_list_granted_applications':
        return this.listGranted(chatId);
      case 'desktop_open_application':
        return this.openApplication(chatId, args);
      case 'desktop_switch_display':
        return this.switchDisplay(chatId, args);
      case 'desktop_read_clipboard':
        return this.readClipboard(chatId);
      case 'desktop_write_clipboard':
        return this.writeClipboard(chatId, args);
      case 'desktop_batch':
        return this.batch(chatId, args, ctx);
      case 'desktop_request_teach_access':
        return this.requestTeachAccess(chatId, args, ctx);
      case 'desktop_teach_step':
        return this.teachStep(chatId, args, ctx);
      case 'desktop_teach_batch':
        return this.teachBatch(chatId, args, ctx);
      case 'desktop_request_full_control':
        return this.requestFullControl(chatId, ctx);
      case 'desktop_release_full_control':
        return this.releaseFullControl(chatId);
      default: {
        const action = tool.replace(/^desktop_/, '');
        if (!ACTIONS.includes(action)) throw new ToolError(`Unknown desktop tool: ${tool}`, 'bad_args');
        if (P.INPUT.has(action)) await this.preflight(chatId, ctx);
        // input actions queue themselves (a confirmation card must not hold the queue)
        const out = await (action === 'wait' || P.INPUT.has(action)
          ? this.act(chatId, action, args, ctx)
          : this.serial(() => this.act(chatId, action, args, ctx)));
        return out.content || [{ type: 'text', text: JSON.stringify(out.record) }];
      }
    }
  }
}

module.exports = { DesktopControl, SPECS, ACTION_SPECS, ACTIONS, TOOL_NAMES, indexElements, processAncestry, onboarding };
