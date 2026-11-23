// MoPilot's desktop lock around Codex Computer Use (Sky): while a native Codex turn runs a cua_repl program that acts on the desktop, the chat holds the lock, so other chats' desktop tools wait or are refused, the overlay shows and Esc stops the turn.
//
// Sky executes on its own; MoPilot governs it (docs/control-plane/design.md, "Computer use"). The lock
// is the one `desktop_*` and `computer_*` take: ComputerUse.controlling in this process and the helper's
// control lock across apps and profiles (with its physical Esc and take-over pause). It is taken when a
// program starts, kept while any native turn of the chat that ran one is still running (a sub-agent's
// included, so the parent's turn end does not free the desktop under it), and let go through
// ComputerUse.release. A program that starts while another chat, app or profile holds the desktop stops
// its turn: Sky can't wait, and two controllers on one desktop is what the lock exists to prevent.
//
// The lock is taken through the same guard as MoPilot's own lock takers (./contract/actionGuard.cjs): never
// once computer use is shutting down, never for a native turn the user stopped (Esc, Stop) or that was
// refused, and a take whose chat's control epoch moved while the helper answered lets go at once.
//
// The no-go list is MoPilot's on every executor (#1319): a program that binds an app computer use never controls
// (the built-in list) or one the user blocked in Settings → Computer use stops its turn, as MoPilot's own tools
// refuse it. Sky runs the program itself, so the stop follows the program's start: at once for a bundle id or an app
// already looked up, after the helper's lookup (apps.resolve) for a name seen the first time.
const { identityKey } = require('../../shared/identityKey.mjs');
const { CuaKernels, cuaAppQueries } = require('../../shared/cuaProgram.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { guarded, mayAct, checkAct } = require('./contract/actionGuard.cjs');
const { denied } = require('./contract/policy.cjs');
const { BUILT_IN_DENY } = require('./computerContract.cjs');
const { HOST_BUNDLES, SELF_PANE_HINT, anyMatch, isHostName } = require('./contract/desktopPolicy.cjs');
const { SELF_NAME } = require('./contract/controlRefusals.cjs');

const SERVER = 'cua_repl';
/** A bundle id names itself ("Notes.app" is a name). */
const isBundleId = (/** @type {string} */ app) => /^[\w-]+(\.[\w-]+)+$/.test(app) && !/\.app$/i.test(app);

/**
 * @typedef {{ controlling: string | null, liveHolder: () => string | null, app: string | null,
 *   onActivity: (chatId: string, a: { app: string, state: 'active' } | null) => void,
 *   helper: { acquireControl: (holder: string) => Promise<unknown>,
 *     resolveApps?: (queries: string[]) => Promise<{ apps?: { query: string, app: { bundleId: string, name?: string } | null, refused?: unknown }[] }> },
 *   holder: (chatId: string) => string,
 *   release: (chatId: string) => Promise<void>, epoch: (chatId: string) => number, closed: boolean,
 *   grants?: { deny: () => string[] } }} DesktopLock
 *   the desktop lock (tools/computer.cjs ComputerUse)
 */

class NativeDesktopHolds {
  /**
   * @param {object} o
   * @param {DesktopLock} o.cu
   * @param {(threadId: string) => boolean} o.isNativeThread the thread runs the vendor plugin (codexConfig.cjs)
   * @param {(threadId: string) => string} o.chatOf the chat a thread's work is shown in (a sub-agent: its parent's; controller.requestChat)
   * @param {(threadId: string, turnId: string, chatId: string, holder: string | null, blocked?: string,
   *   refusal?: import('./contract/controlRefusals.cjs').Refusal) => void} o.onBusy another chat (`holder`), or another app or
   *   profile (null), holds the desktop, or the program acts on an app computer use never controls (`blocked`: why,
   *   `refusal`: which app and why, for the chat's note): stop this turn and say why
   * @param {(threadId: string, turnId: string) => void} [o.onStop] Esc or Stop on the chat: stop this native turn too
   * @param {(threadId: string) => boolean} [o.isSubagent] the thread is a sub-agent's (its turn outlives the chat's own)
   * @param {() => void} [o.onChange] the lock changed hands here (the overlay follows it)
   */
  constructor(o) {
    this.cu = o.cu;
    this.isNativeThread = o.isNativeThread;
    this.chatOf = o.chatOf;
    this.onBusy = o.onBusy;
    this.onStop =
      o.onStop ??
      (() => {
        /* no stop listener */
      });
    this.isSubagent = o.isSubagent ?? (() => false);
    this.onChange =
      o.onChange ??
      (() => {
        /* no listener */
      });
    /** each thread's plugin kernel bindings (until it is reset) */
    this.kernels = new CuaKernels();
    /** chat -> { took, turns: Map<identity tuple, [thread, turn]> }: the native turns holding the chat's desktop */
    this.holds = new Map();
    /** identity tuple -> thread owner: turns stopped for a busy desktop, or by the user (Esc, Stop): it never takes the desktop again */
    this.refused = new Map();
    /** an app name a program bound (lower case) -> its bundle id, as the helper resolved it (null: no such app) */
    this.bundles = new Map();
  }

  /** Whether `chatId` holds the desktop for a native program (the overlay shows for it). */
  holding(chatId) {
    return !!chatId && this.holds.has(chatId);
  }

  /** Sees each app-server notification (main's Codex observe); never consumes one. */
  observe(msg) {
    const p = msg?.params;
    if (!p || msg.id != null) return;
    const threadId = p.threadId;
    if (typeof threadId !== 'string') return;
    if (msg.method === 'thread/closed') {
      this.kernels.reset(threadId);
      return void this.ended(threadId, null);
    }
    if (msg.method === 'turn/completed') return void this.ended(threadId, p.turn?.id ?? null);
    const it = p.item;
    if (msg.method !== 'item/started' || it?.type !== 'mcpToolCall' || it.server !== SERVER || !this.isNativeThread(threadId)) return;
    if (it.tool === 'js_reset') return void this.reset(threadId);
    if (it.tool !== 'js' || typeof p.turnId !== 'string') return;
    const use = this.kernels.use(threadId, it.arguments?.code);
    if (!use.desktop) return;
    this.take(threadId, p.turnId, use.app);
    // the app it binds, and every app a getApp call of it names: one never bound to a variable is acted on too (#1362)
    for (const app of new Set([use.app, ...cuaAppQueries(it.arguments?.code)])) if (app) this.checkApp(threadId, p.turnId, app);
  }

  /** Stops the native turn when the app its program binds is on the no-go list (the built-in one or the user's). */
  checkApp(threadId, turnId, app) {
    const chatId = this.chatOf(threadId);
    const stop = (/** @type {string | null} */ bundleId) => {
      const no = bundleId ? this.blockedReason(bundleId, app) : null;
      if (no) this.refuse(threadId, turnId, chatId, null, no.why, no.refusal);
    };
    const key = app.toLowerCase();
    // a bundle id names itself ("Notes.app" is a name); a name is looked up once
    if (isBundleId(app)) return stop(app);
    // MoPilot's own names need no lookup: a missing or failing helper must not let a program act on it (#1362)
    if (isHostName(app)) return stop(HOST_BUNDLES[0]);
    if (this.bundles.has(key)) return stop(this.bundles.get(key) || null);
    const resolve = this.cu.helper.resolveApps;
    if (!resolve) return;
    Promise.resolve()
      .then(() => resolve.call(this.cu.helper, [app]))
      .then(
        (r) => {
          const found = r?.apps?.find((a) => a.query === app)?.app?.bundleId ?? null;
          this.bundles.set(key, found);
          // a turn that ended while the helper answered is not stopped again
          if (this.holds.get(chatId)?.turns.has(identityKey(threadId, turnId))) stop(found);
        },
        (error) => noteIgnored('look up the app a Codex Computer Use program binds', error),
      );
  }

  /**
   * Why computer use never controls `bundleId` (named `app` by the program), or null: MoPilot itself (a
   * development build runs as Electron, as desktop_* refuse it), the user's blocked apps, then the built-in list.
   * `why` is what the notification says; `refusal` names the app for the chat's note (./contract/controlRefusals.cjs).
   * @returns {{ why: string, refusal: import('./contract/controlRefusals.cjs').Refusal } | null}
   */
  blockedReason(bundleId, app) {
    if (anyMatch(HOST_BUNDLES, bundleId))
      return {
        why: `computer use never controls ${app} (MoPilot itself). ${SELF_PANE_HINT}`,
        refusal: { reason: 'self', app, name: SELF_NAME },
      };
    // a bundle id reads as the app's name where the built-in list names one ("Keychain Access", not "password manager")
    const named = (/** @type {string | undefined} */ reason) => (isBundleId(app) && reason && /^[A-Z]/.test(reason) ? reason : app);
    if (denied(this.cu.grants?.deny() ?? [], bundleId))
      return { why: `${app} is blocked in Settings → Computer use`, refusal: { reason: 'blocked', app, name: named(undefined) } };
    const built = BUILT_IN_DENY.find((d) => denied([d.pattern], bundleId));
    return built
      ? { why: `computer use never controls ${app} (${built.reason})`, refusal: { reason: 'builtIn', app, name: named(built.reason) } }
      : null;
  }

  /** The thread's plugin kernel was reset (a js_reset item, or the one MoPilot sends on Stop): no app is bound any more. */
  reset(threadId) {
    this.kernels.reset(threadId);
  }

  /** A desktop program started on a native turn: the chat takes the lock, or the turn stops if someone else has it. */
  take(threadId, turnId, app) {
    const chatId = this.chatOf(threadId);
    const key = identityKey(threadId, turnId);
    const cu = this.cu;
    // a stopped or refused turn, or computer use shutting down: never (back) on the desktop
    if (this.refused.has(key) || cu.closed) return;
    // a lock a tool call's turn kept after it ended or was stopped is free again (ComputerUse.liveHolder)
    const holder = cu.liveHolder();
    if (holder && holder !== chatId) return void this.refuse(threadId, turnId, chatId, holder);
    let hold = this.holds.get(chatId);
    if (!hold) this.holds.set(chatId, (hold = { took: false, turns: new Map() }));
    hold.turns.set(key, [threadId, turnId]);
    if (holder === chatId) {
      if (app && cu.app !== app) {
        cu.app = app;
        cu.onActivity(chatId, { app, state: 'active' });
      }
      return;
    }
    this.claim(chatId, hold, key, app || 'your Mac');
  }

  /**
   * Takes the lock for `chatId` on behalf of the native turn `key`: in this process at once (so no other
   * chat can take it meanwhile), and the helper's lock behind it. Another app or profile holding the
   * helper's lock stops the turn; a helper that can't run leaves the in-process lock, which still keeps
   * this app's chats apart.
   */
  claim(chatId, hold, key, app) {
    // the chat's control epoch now: Esc, Stop or the turn's end while the helper answers make this take dead
    guarded({ epoch: () => this.cu.epoch(chatId) }, () => this.takeGuarded(chatId, hold, key, app));
  }

  /** The take itself, inside its guard: checked like every lock taker before the lock is set (CM-R13). */
  takeGuarded(chatId, hold, key, app) {
    const cu = this.cu;
    try {
      checkAct('taking the desktop for Codex Computer Use');
    } catch {
      return;
    }
    const [threadId, turnId] = hold.turns.get(key);
    const claim = {};
    hold.claim = claim;
    cu.controlling = chatId;
    cu.app = app;
    hold.took = true;
    cu.onActivity(chatId, { app, state: 'active' });
    this.onChange();
    const live = () => mayAct() && !this.refused.has(key) && !cu.closed;
    // a dead take lets go at once, unless a newer take for the chat replaced it meanwhile
    const dead = () => {
      if (hold.claim !== claim || cu.controlling !== chatId) return;
      void cu.release(chatId);
      this.onChange();
    };
    Promise.resolve()
      .then(() => cu.helper.acquireControl(cu.holder(chatId)))
      .then(
        () => live() || dead(),
        (e) => {
          if (e?.reason !== 'lock_busy') {
            if (!live()) return void dead();
            // a helper that can't run leaves the in-process lock, which still keeps this app's chats apart
            return void noteIgnored('take the helper lock for Codex Computer Use', e);
          }
          if (hold.claim === claim && cu.controlling === chatId) {
            cu.controlling = null;
            cu.app = null;
            cu.onActivity(chatId, null);
          }
          if (this.holds.get(chatId) === hold) this.holds.delete(chatId);
          this.onChange();
          this.refuse(threadId, turnId, chatId, null);
        },
      );
  }

  /** Stops a native turn once: for a desktop someone else holds, or (`blocked`, why; `refusal`, which app) an app on the no-go list. */
  refuse(threadId, turnId, chatId, holder, blocked, refusal) {
    const key = identityKey(threadId, turnId);
    if (this.refused.has(key)) return;
    this.refused.set(key, threadId);
    if (blocked) this.onBusy(threadId, turnId, chatId, holder, blocked, refusal);
    else this.onBusy(threadId, turnId, chatId, holder);
  }

  /** A native turn (or, `turnId` null, every turn of a closed thread) ended: the chat lets go once none of its native turns hold it. */
  ended(threadId, turnId) {
    const mine = (key, owner) => owner === threadId && (turnId == null || key === identityKey(threadId, turnId));
    for (const [key, owner] of this.refused) if (mine(key, owner)) this.refused.delete(key);
    for (const [chatId, hold] of this.holds) {
      for (const [key, [owner]] of hold.turns) if (mine(key, owner)) hold.turns.delete(key);
      if (hold.turns.size) continue;
      this.holds.delete(chatId);
      this.letGo(chatId, hold);
    }
  }

  /** Lets go of a lock this module took, through ComputerUse.release (the helper's lock too). */
  letGo(chatId, hold) {
    if (!hold.took || this.cu.controlling !== chatId) return;
    this.cu.release(chatId);
    this.onChange();
  }

  /**
   * The chat's turn ended and the turn-end ledger let go of its desktop: a native turn of the chat still
   * running (a sub-agent's) takes it back at once, so its program never runs without the lock.
   */
  retake(chatId) {
    const hold = this.holds.get(chatId);
    if (!hold || this.cu.liveHolder() || this.cu.closed) return;
    const key = [...hold.turns.keys()].find((k) => !this.refused.has(k));
    if (key) this.claim(chatId, hold, key, this.cu.app || 'your Mac');
  }

  /**
   * The chat's own turn ended (finished or stopped; Codex may report its turn/completed later): its own
   * threads' native turns no longer hold the desktop. A sub-agent's turn keeps running, and holds on.
   */
  chatTurnEnded(chatId) {
    const hold = this.holds.get(chatId);
    if (!hold) return;
    for (const [key, [threadId]] of hold.turns) if (!this.isSubagent(threadId)) hold.turns.delete(key);
    if (!hold.turns.size) this.holds.delete(chatId);
  }

  /** Esc or Stop on the chat: every native turn holding its desktop (a sub-agent's too) is stopped, and never takes it back. */
  interrupt(chatId) {
    for (const [key, [threadId, turnId]] of this.holds.get(chatId)?.turns ?? []) {
      this.refused.set(key, threadId);
      this.onStop(threadId, turnId);
    }
  }

  /** The app-server exited: every native turn went with it. */
  clear() {
    for (const [chatId, hold] of this.holds) this.letGo(chatId, hold);
    this.holds.clear();
    this.kernels.clear();
    this.refused.clear();
    this.onChange();
  }
}

module.exports = { NativeDesktopHolds };
