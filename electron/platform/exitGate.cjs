// The exit gate: Quit, Restart to update (and later a helper upgrade) go through it. It counts what
// quitting would stop (running turns, background tasks, active goals), asks before stopping them,
// and on confirm pauses the goals so they don't run on while the app is gone (A20, D-79):
// Codex goals are set paused; Claude goals get MoPilot's own pause (interrupt, then /goal clear,
// keeping the condition), run by main's Claude adapter, so it works with no window open (tray quit).

const { settledStatus } = require('../../shared/claudeTaskStatus.mjs');
const { noteIgnored, messageOf } = require('../ignored.cjs');

/**
 * Claude's background tasks that quitting would end: running workflows, shells, sub-agents and the like (finished
 * ones are listed too). An ambient task is the CLI's own housekeeping, except a Monitor, which is the user's.
 */
function claudeBackground(tasks) {
  return (tasks ?? []).filter((t) => !settledStatus(t.status) && (!t.ambient || t.type === 'monitor')).length;
}

/** What quitting would stop (`unknown`: it could not be counted). */
/** @returns {{ turns: string[], background: number, goals: { chatId: string, kind: string, objective: string }[], keeps?: string[], notice?: boolean, unknown?: boolean }} `keeps`: chats with a turn on this Mac's background Host, which quitting does not end; `notice`: the one-line notice about them is still to be shown */
function emptySummary() {
  return { turns: [], background: 0, goals: [] };
}

/**
 * What quitting would stop, from main's session state.
 * @param {object} o
 * @param o.chats chat ids with live state
 * @param o.get (chatId) => SessionState
 * @param o.kindOf (chatId) => 'codex' | 'claude' | 'acp:…' (the chat's current harness)
 * @param o.background number of background tasks (Codex background terminals)
 * @param o.loops (chatId) => number of /loop wake-ups and cron jobs a Claude session holds
 * @param [o.keeps] (chatId) => whether the chat runs on this Mac's background Host (its turn survives the quit, so it is listed apart)
 */
function summarize({ chats, get, kindOf, background = 0, loops, keeps }) {
  const out = emptySummary();
  for (const chatId of chats) {
    const s = get(chatId);
    if (!s) continue;
    if (keeps?.(chatId)) {
      if (s.turn === 'running' || s.turn === 'awaitingUser') (out.keeps ??= []).push(chatId);
      continue;
    }
    if (s.turn === 'running' || s.turn === 'awaitingUser') out.turns.push(chatId);
    background += claudeBackground(s.tasks) + (loops?.(chatId) || 0);
    if (s.goal?.status === 'active') out.goals.push({ chatId, kind: kindOf(chatId), objective: String(s.goal.objective ?? '') });
  }
  out.background = background;
  return out;
}

const isEmpty = (sum) => !sum.turns.length && !sum.background && !sum.goals.length;
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function joinAnd(parts) {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Said when what quitting would stop could not be counted: the dialog asks anyway. */
const UNKNOWN_TEXT = "MoPilot couldn't check what is still running.";

/** The one line about chats that keep running (Remote Run H2). @param {number} n */
const keepsText = (n) => `${count(n, 'chat')} ${n === 1 ? 'keeps' : 'keep'} running on this Mac.`;
/** Whether the sheet still has that line to show. */
const keepsToShow = (sum) => !!sum.notice && !!sum.keeps?.length;

/** The dialog's line (design copy: Quit confirm). Empty when nothing would stop. */
function summaryText(sum) {
  if (sum.unknown) return UNKNOWN_TEXT;
  const keeps = keepsToShow(sum) ? keepsText(/** @type {string[]} */ (sum.keeps).length) : '';
  const parts = [];
  if (sum.turns.length) parts.push(count(sum.turns.length, 'turn'));
  if (sum.background) parts.push(count(sum.background, 'background task'));
  if (sum.goals.length) parts.push(count(sum.goals.length, 'goal'));
  if (!parts.length) return keeps;
  return [`${joinAnd(parts)} will stop.${sum.goals.length ? ' Goals are paused, not lost.' : ''}`, keeps].filter(Boolean).join(' ');
}

/** Whether to ask: Settings → General → Confirm before quitting ('never' skips it, 'always' asks every time). */
/**
 * A restart nobody asked for may go only when nothing would stop at all (not merely when the user would not be asked:
 * "never ask" means "don't ask me when I quit", not "stop my work unattended"), and never for a user who wants every
 * quit confirmed.
 */
function quietBlocked(sum, confirmClose) {
  return !!sum.unknown || !isEmpty(sum) || confirmClose === 'always';
}

function needsConfirm(sum, confirmClose) {
  if (confirmClose === 'never') return false;
  if (confirmClose === 'always') return true;
  return !!sum.unknown || !isEmpty(sum) || keepsToShow(sum);
}

class ExitGate {
  /**
   * @param {object} o
   * @param o.collect () => Promise<summary>
   * @param o.confirm (summary, reason: 'quit' | 'update') => Promise<boolean> (a window's dialog, or a native one)
   * @param o.confirmClose () => 'shortcut' | 'always' | 'never'
   * @param o.pauseCodex (goals) => Promise (set each active Codex goal paused)
   * @param o.pauseClaude (goals) => Promise (MoPilot's pause for each active Claude goal)
   * @param [o.confirmFailed] (error, reason) => void: tells the user the confirmation could not be asked
   * @param [o.pauseMs] how long pausing may hold up the exit
   * @param [o.noticed] () => void: the one-line notice about background chats was shown
   * @param [o.stopKeeps] (chatIds) => Promise: stops the turns of background chats ("Quit and stop them")
   */
  constructor(o) {
    this.o = o;
    /** what quitting would stop, as the gate asks it (main also reads it) */
    this.collect = o.collect;
    this.pauseMs = o.pauseMs ?? 8000;
    /** set once the gate let an exit through; before-quit then lets it go */
    this.passed = false;
    this.pending = null;
    this.pendingQuiet = false;
  }

  /** An exit the gate let through did not happen (a restart to update that failed): the next one asks again. */
  reopen() {
    this.passed = false;
  }

  /**
   * Resolves true when the app may exit (after pausing goals), false when the user kept it open. A quiet request
   * (a restart nobody asked for, stealthUpdate.cjs) never asks: where the user would be asked, it is false.
   */
  request(reason = 'quit', { quiet = false } = {}) {
    if (this.passed) return Promise.resolve(true);
    // a second Quit while the dialog is up answers the same question; one the user asked for while a quiet one
    // runs is asked once that ends, so a quiet "no" never answers it
    if (this.pending) return quiet || !this.pendingQuiet ? this.pending : this.pending.then((ok) => ok || this.request(reason));
    this.pendingQuiet = quiet;
    this.pending = this.run(reason, quiet).finally(() => (this.pending = null));
    return this.pending;
  }

  async run(reason, quiet = false) {
    let sum;
    try {
      sum = await this.o.collect();
    } catch (error) {
      // not knowing what would stop is not "nothing would stop": ask (unless the user never wants to be asked)
      console.error('[exitGate] counting what quitting would stop failed', error);
      sum = { ...emptySummary(), unknown: true };
    }
    const confirmClose = this.o.confirmClose?.();
    if (quiet) {
      if (quietBlocked(sum, confirmClose)) return false;
    } else if (needsConfirm(sum, confirmClose)) {
      const answer = await this.ask(sum, reason);
      if (!answer) return false;
      if (keepsToShow(sum)) this.o.noticed?.();
      if (answer === 'stop') await this.o.stopKeeps?.(sum.keeps);
    }
    await this.pauseGoals(sum);
    this.passed = true;
    return true;
  }

  /**
   * The user's answer. A confirmation that could not be asked is not the user's Cancel: the user hears that it
   * failed and the quit they asked for goes on (goals are still paused), so Quit never silently does nothing.
   */
  async ask(sum, reason) {
    try {
      const answer = await this.o.confirm(sum, reason);
      return answer === 'stop' ? 'stop' : !!answer;
    } catch (error) {
      console.error(`[exitGate] the ${reason} confirmation could not be shown`, error);
      try {
        this.o.confirmFailed?.(error, reason);
      } catch (again) {
        noteIgnored('tell the user the quit confirmation failed', again);
      }
      return true;
    }
  }

  async pauseGoals(sum) {
    const codex = sum.goals.filter((g) => g.kind === 'codex');
    const claude = sum.goals.filter((g) => g.kind === 'claude');
    const work = [];
    // not knowing the goals: Codex can still pause all of its active goals itself (pauseAllActiveGoals)
    if (codex.length || sum.unknown)
      work.push(
        Promise.resolve()
          .then(() => this.o.pauseCodex?.(codex))
          .catch((error) => {
            // best effort on quit: a failed pause must not block quitting
            noteIgnored('pause the Codex goals before quitting', error);
          }),
      );
    if (claude.length)
      work.push(
        Promise.resolve()
          .then(() => this.o.pauseClaude?.(claude))
          .catch((error) => {
            // best effort on quit: a failed pause must not block quitting
            noteIgnored('pause the Claude goals before quitting', error);
          }),
      );
    if (!work.length) return;
    let timer;
    await Promise.race([Promise.all(work), new Promise((r) => (timer = setTimeout(r, this.pauseMs)))]);
    clearTimeout(timer);
  }
}

/** Codex background terminals across the threads this app has loaded (0 when Codex doesn't answer in time). */
async function codexBackground(codex, ms = 1500) {
  if (!codex?.leases?.size) return 0;
  const one = (threadId) =>
    codex.request('thread/backgroundTerminals/list', { threadId }).then(
      (r) => (r?.data ?? r?.terminals ?? []).length,
      () => 0,
    );
  let timer;
  const all = Promise.all([...codex.leases.keys()].map(one)).then((n) => n.reduce((a, b) => a + b, 0));
  const n = await Promise.race([all, new Promise((r) => (timer = setTimeout(() => r(0), ms)))]);
  clearTimeout(timer);
  return n;
}

/**
 * before-quit's hold: until the gate has passed, cancels the quit and quits again once it does. Returns true
 * while it holds the quit. The second quit waits for a later task: a quit that starts in native code (SIGTERM,
 * ⌘Q) runs JS microtasks while before-quit is emitted, so a quit issued from inside it would be overwritten as
 * cancelled when the first returns, closing every window without exiting.
 * @param e before-quit's event
 * @param gate the ExitGate (none yet: nothing to hold)
 * @param quit () => void (app.quit)
 * @param [defer] (fn) => void: runs fn in a later task
 */
function holdQuit(e, gate, quit, defer = setImmediate) {
  if (!gate || gate.passed) return false;
  e.preventDefault();
  gate.request('quit').then((ok) => ok && defer(quit));
  return true;
}

/**
 * before-quit's second hold, once the gate passed: processes that tidy up outside the app as they exit (the Claude
 * Code CLI and the Your Chrome CLI close the chat's Chrome tab group) get up to `ms` to exit before the app does,
 * so their cleanup is not cut off. The first confirmed quit runs `cleanup` and holds; once it settled, or `ms`
 * passed, the app quits again (in a later task, see holdQuit) and that quit goes through.
 * @param {number} ms
 * @param {{ timer?: (fn: () => void, ms: number) => unknown, defer?: (fn: () => void) => unknown }} [o]
 * @returns {(e: { preventDefault(): void }, cleanup: () => Array<unknown>, quit: () => void) => boolean} true while it holds the quit
 */
function cleanupHold(ms, { timer = setTimeout, defer = setImmediate } = {}) {
  /** @type {'open' | 'waiting' | 'done'} */
  let state = 'open';
  return (e, cleanup, quit) => {
    if (state === 'done') return false;
    e.preventDefault();
    if (state === 'waiting') return true;
    state = 'waiting';
    /** @type {Promise<unknown>} */
    let work;
    try {
      work = Promise.allSettled(cleanup());
    } catch (error) {
      // a cleanup that throws at once has nothing to wait for; quitting goes on
      noteIgnored('start the quit cleanup', error);
      work = Promise.resolve();
    }
    void Promise.race([work, new Promise((resolve) => timer(() => resolve(undefined), ms))]).then(() => {
      state = 'done';
      defer(quit);
    });
    return true;
  };
}

/**
 * A quit that must end: windows with a native sheet of their own (a page's file chooser, a dialog) may refuse to
 * close, which would leave a quit hanging with nobody to answer (#3977). Once a quit is committed, the app exits
 * `ms` later whatever is still open; the state that is written behind has been flushed by then.
 * @param {number} ms
 * @param {(code: number) => void} exit app.exit
 * @param {(fn: () => void, ms: number) => unknown} [timer]
 * @returns {(o?: { stillQuitting?: () => boolean }) => boolean} arms it once; false when already armed.
 *   The exit is skipped when the quit was taken back meanwhile (`stillQuitting` says no)
 */
function quitDeadline(ms, exit, timer = setTimeout) {
  let armed = false;
  return ({ stillQuitting = () => true } = {}) => {
    if (armed) return false;
    armed = true;
    timer(() => {
      armed = false;
      if (stillQuitting()) exit(0);
    }, ms);
    return true;
  };
}

let seq = 0;
/**
 * Ask a window and wait for its answer on `${channel}:reply` (null when it doesn't answer in time, or is closed).
 * Rejects when its page can't answer: it crashed or is gone (`send` to it does nothing, and it is not destroyed),
 * or it reloads (the new page never got the question), so the caller asks another way instead of waiting forever.
 */
function askWindow(ipcMain, wc, channel, payload, ms) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener(`${channel}:reply`, onReply);
      wc.removeListener('destroyed', onDestroyed);
      wc.removeListener('render-process-gone', onGone);
      wc.removeListener('did-start-loading', onReload);
    };
    const done = (v) => {
      cleanup();
      resolve(v);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onReply = (_e, rid, v) => rid === id && done(v);
    const onDestroyed = () => done(null);
    const onGone = (_e, details) => fail(new Error(`the window's page stopped (${details?.reason ?? 'gone'})`));
    const onReload = () => fail(new Error("the window's page reloaded"));
    const timer = ms ? setTimeout(() => done(null), ms) : undefined;
    ipcMain.on(`${channel}:reply`, onReply);
    wc.once('destroyed', onDestroyed);
    wc.once('render-process-gone', onGone);
    wc.once('did-start-loading', onReload);
    try {
      if (wc.isCrashed?.()) throw new Error("the window's page has crashed");
      wc.send(channel, id, payload);
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * The gate as main wires it.
 * @param {object} o
 * @param o.ipcMain electron's
 * @param o.dialog electron's
 * @param o.window () => BrowserWindow | null (a main window to ask in)
 * @param o.sessions () => SessionStore
 * @param o.controller () => ChatController
 * @param o.codex () => CodexAdapter
 * @param o.claude () => electron/harness/claude/index.cjs
 * @param o.claudeTurns () => ClaudeAdapter (electron/harness/claude/adapter.cjs): goalAction(chatId, 'pause')
 * @param o.prefs () => prefs (confirmClose)
 * @param [o.keepsRunning] () => the background Host's chats (electron/host/keepsRunning.cjs), or null
 */
function createExitGate(o) {
  const collect = async () => {
    const keeps = o.keepsRunning?.() ?? null;
    const sum = summarize({
      chats: o.sessions().all(),
      get: (id) => o.sessions().get(id),
      kindOf: (id) => {
        try {
          return o.controller().ref(id).kind;
        } catch {
          return null;
        }
      },
      background: await codexBackground(o.codex()),
      loops: (id) => {
        try {
          return o.claude()?.scheduled?.(o.controller().ref(id).key) ?? 0;
        } catch {
          return 0;
        }
      },
      keeps: keeps ? (id) => keeps.owns(id) : undefined,
    });
    if (keeps) sum.notice = !keeps.seen();
    return sum;
  };
  const native = async (reason, detail, keeps = false) => {
    const go = reason === 'update' ? 'Restart Now' : 'Quit';
    const { response } = await o.dialog.showMessageBox({
      type: 'warning',
      message: reason === 'update' ? 'Restart to update?' : 'Quit MoPilot?',
      detail: detail || undefined,
      buttons: keeps ? [go, 'Quit and stop them', 'Cancel'] : [go, 'Cancel'],
      defaultId: 0,
      cancelId: keeps ? 2 : 1,
    });
    return keeps && response === 1 ? 'stop' : response === 0;
  };
  const gate = new ExitGate({
    collect,
    confirmClose: () => o.prefs()?.confirmClose ?? 'shortcut',
    confirm: async (sum, reason) => {
      const text = summaryText(sum);
      const win = o.window();
      const more = keepsToShow(sum);
      if (!win) return native(reason, text, more);
      try {
        win.show();
        win.focus();
        return await askWindow(
          o.ipcMain,
          win.webContents,
          'exitGate:confirm',
          {
            reason,
            text,
            turns: sum.turns.length,
            background: sum.background,
            goals: sum.goals.length,
            ...(more ? { keeps: sum.keeps?.length } : {}),
          },
          0,
        );
      } catch (error) {
        // the window could not show the dialog: ask natively instead, and say why
        console.error('[exitGate] the window could not show the quit confirmation', error);
        return native(reason, [text, `(The window couldn't ask: ${messageOf(error)})`].filter(Boolean).join(' '), more);
      }
    },
    confirmFailed: (error, reason) =>
      o.dialog.showErrorBox(
        reason === 'update' ? "Couldn't confirm the restart" : "Couldn't confirm quitting",
        `MoPilot couldn't ask before ${reason === 'update' ? 'restarting' : 'quitting'} (${messageOf(error)}), so it goes ahead as you asked.`,
      ),
    noticed: () => o.keepsRunning?.()?.markSeen(),
    stopKeeps: (ids) => o.keepsRunning?.()?.stop(ids),
    pauseCodex: async (goals) => {
      const codex = o.codex();
      if (typeof codex?.pauseAllActiveGoals === 'function') return codex.pauseAllActiveGoals();
      await Promise.all(
        goals.map((g) =>
          Promise.resolve()
            .then(() => codex?.leased(g.chatId, 'thread/goal/set', { status: 'paused' }))
            .catch((error) => {
              // best effort on quit: one chat failing to pause must not block the others
              noteIgnored('pause a Codex goal before quitting', error);
            }),
        ),
      );
    },
    pauseClaude: async (goals) => {
      const turns = o.claudeTurns?.();
      await Promise.all(
        goals.map((g) =>
          Promise.resolve()
            .then(() => turns?.goalAction(g.chatId, 'pause'))
            .catch((error) => {
              // best effort on quit: one chat failing to pause must not block the others
              noteIgnored('pause a Claude goal before quitting', error);
            }),
        ),
      );
    },
  });
  return gate;
}

module.exports = {
  claudeBackground,
  ExitGate,
  createExitGate,
  holdQuit,
  cleanupHold,
  quitDeadline,
  codexBackground,
  askWindow,
  summarize,
  summaryText,
  needsConfirm,
  quietBlocked,
  isEmpty,
  emptySummary,
};
