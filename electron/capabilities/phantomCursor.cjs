// The phantom cursor: while a chat works in an app in the background, a click-through window over the
// target window shows where each action lands without moving the user's own pointer. The cursor is made per action and plays the
// observed Sky cursor (shared/cursorApproach.mjs planApproach, #3810): it appears on the line back to the previous point, glides on
// a straight critically damped spring, hovers, presses (arrow, then a disc) and stays as the disc until the action reports (finish; capped), then is gone at once; between actions nothing is
// shown. A click's input goes INPUT_LEAD_MS before the press (the helper's own latency), so the click lands at the press and the cursor is never gone before it, with no ring.
// A drag, and an action reported without an approach (a batch run in the helper), keep the older whole-path page (show).
// Like the control indicator the window sits at the screen-saver level and opts out of capture, so screenshots never show it and the
// helper's hit test looks through it. The pages are static HTML with CSS animations: no script, nothing to click.

const { noteIgnored } = require('../ignored.cjs');
const { identityKey } = require('../../shared/identityKey.mjs');
const { planApproach } = require('../../shared/cursorApproach.mjs');
const { cursorHtml, approachHtml, DRAG_MS } = require('./phantomCursorPages.cjs');
const { Park, PARK_MS } = require('./phantomCursorPark.cjs');
const { noteUnshown, isShowing } = require('./phantomCursorShown.cjs');
const finite = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
const validBounds = (b) => !!b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0;
/** How long a drag's path stays after it was shown. */
const HIDE_AFTER_MS = 1800;
/** How long a window with no result for its action stays before it is hidden anyway (a batch or an action that never reports). */
const STALE_MS = 2000;
/** How long a page may take to load and be set going: after this the click goes on with no cursor shown (a click never goes before its cursor is visible, and never waits longer than this plus the plan). */
const LOAD_WAIT_MS = 1000;
/** One display frame: after the page is told to run, the compositor starts its animation clock on the next frame, so the plan's clock starts one frame later. */
const FRAME_MS = 17;
/** What sets an approach page going: it is rendered paused (no script runs in it), so the main process decides when the animation clock starts. */
const RUN_CSS = '.cur,.arrow,.disc{animation-play-state:running !important}';
/** How long an action waits for the overlay another action is using before it goes on with no cursor. */
const QUEUE_CAP_MS = 500;
/** The actions that press: a click waits for the cursor to arrive, hover and press before the input goes. */
const PRESS_KINDS = new Set(['click']);
/** How long a click's input goes ahead of the press: the real helper needs about this long between being asked and the click event (IPC, the dispatch check, its 40 ms pre-click settle; measured on the real helper, #3810: the click landed about 150 ms after the approach resolved), so the click lands at the press. Timing only: whether a click landed is the helper's result. */
const INPUT_LEAD_MS = 140;
/** How long a click's disc stays up waiting for the action's report before it goes anyway (a slow or hung helper never leaves it showing); the report, Stop and a take-over end it sooner. */
const HOLD_CAP_MS = 1500;
/** Where the older page's pointer comes from when there is no previous point in this window: up and to the left. */
const ENTRY = { x: -36, y: -28 };
/** When a click's input goes (INPUT_LEAD_MS before the press, so mid-glide for a long move; the click itself lands only after the helper's latency) and when its cursor has played out, both from the start of the glide. Other actions: no wait, played out at the plan's end. */
function scheduleOf(plan, press) {
  if (!press) return { inputAt: 0, playedAt: plan.totalMs };
  return { inputAt: Math.max(0, plan.pressAtMs - INPUT_LEAD_MS), playedAt: plan.pressAtMs + HOLD_CAP_MS };
}
/** A token that is unique per approach page and survives a data URL's percent-encoding. */
let pageCount = 0;
const newNonce = () => `n${Date.now().toString(36)}x${(++pageCount).toString(36)}_`;
const dataUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

class PhantomCursor {
  /**
   * @param {object} o
   * @param {{ BrowserWindow: any, systemPreferences?: any } | null} o.electron Electron's main-process modules (null: nothing is shown)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [o.timers]
   * @param {() => boolean} [o.reducedMotion] whether the system asks for Reduce Motion (default: Electron's animation settings)
   */
  constructor(o) {
    this.electron = o.electron || null;
    this.timers = o.timers || { setTimeout, clearTimeout };
    this.reducedMotion = o.reducedMotion || (() => this.#systemReducedMotion());
    this.window = null;
    /** the window's idle-hide timer (a drag staying a while) */
    this.timer = null;
    /** the action on the overlay: {chatId, rec, press, resolve, timers, played}; one overlay window, so one action at a time */
    this.active = null;
    /** the actions waiting for the overlay, in order: each waits at most QUEUE_CAP_MS, then goes on with no cursor */
    this.queue = [];
    /** action token -> {chatId, key, global, press, done}: what an action that was given an approach did, so it reports once (finish) */
    this.acts = new WeakMap();
    /** (chat, app) -> where its cursor last ended, in global points: the next action's approach is the line back to it */
    this.previous = new Map();
    /** the click whose cursor stays on its point after the click (phantomCursorPark.cjs) */
    this.park = new Park(this.timers, () => this.hide());
    /** the window the drag page was last shown over (its bounds as a key) and where it ended, in window points */
    this.last = null;
    /** the page being loaded for the window (a newer one, or a hide, makes an older load's answer void) */
    this.generation = 0;
    /** removers of the page-load listeners an approach is waiting on (cleared when the next page or a hide comes) */
    this.listeners = [];
  }

  /**
   * One action of `chatId` in `bundleId` landing at `points` (global points) in the window `bounds`: shows the cursor's approach and
   * resolves when the input may go (a click: after the arrival, hover and press; any other action: at once). There is one overlay: an
   * action that finds it busy waits its turn (at most QUEUE_CAP_MS, then goes on with no cursor), so each click still waits for ITS
   * arrival and nobody's cursor is replayed over another's. cancel(), finish() or hide() resolves it early; the caller checks that it
   * may still act. Resolves at once when nothing can be shown. `token` names the action: finish() with it reports it exactly once;
   * without one the action already ran (shown after the fact) and its point is the chat's previous point at once.
   * @returns {Promise<void>}
   */
  approach({ chatId, bundleId, bounds, points, kind, token }) {
    if (!validBounds(bounds)) return Promise.resolve();
    const pts = (Array.isArray(points) ? points : []).filter(finite);
    if (!pts.length) return Promise.resolve();
    if (!this.#ensure()) return Promise.resolve();
    const global = pts[pts.length - 1];
    const key = identityKey(chatId, String(bundleId).toLowerCase());
    const press = PRESS_KINDS.has(kind);
    // the point is the chat's previous one once the action succeeded (finish); an action that already ran has it as it starts
    let rec = /** @type {any} */ (null);
    if (token) this.acts.set(token, (rec = { chatId, key, global, press, done: false }));
    return new Promise((resolve) => {
      const act = { chatId, key, bounds, global, rec, press, resolve, timers: new Set(), played: false };
      if (!press) resolve();
      if (!this.active || this.active.played) this.#start(act);
      else this.#wait(act);
    });
  }

  /**
   * The action named by `token` reported its result (any number of times: only the first counts): a click's cursor stays parked (no ring) and any other action's goes now, and the
   * action's point becomes the chat's previous one. False when the action was given no approach, so the caller can show it another way; true for every action that had one, even when its
   * cursor was cut short (stale, Stop, another chat's turn), so nothing is replayed after the fact.
   */
  finish({ chatId, token }) {
    const rec = token ? this.acts.get(token) : null;
    if (!rec || rec.chatId !== chatId) return false;
    if (rec.done) return true;
    rec.done = true;
    this.previous.set(rec.key, { chatId, x: rec.global.x, y: rec.global.y });
    this.#unqueue((a) => a.rec === rec);
    const act = this.active;
    if (!act || act.rec !== rec) return true;
    this.#leave(act);
    return true;
  }

  /**
   * The helper says the click's mouse-down went out: the cursor stops waiting and parks on its point (#3810; #4081 had it go within a frame). Only the cursor: the point stays the chat's
   * previous one only when the action then reports success (finish), so a click that fails still does not move it.
   */
  dispatched({ chatId, token }) {
    const rec = token ? this.acts.get(token) : null;
    if (!rec || rec.chatId !== chatId || rec.done) return false;
    const act = this.active;
    if (!act || act.rec !== rec) return false;
    this.#leave(act);
    return true;
  }

  /** The action's input has gone (click.dispatched) or it reported: a click's cursor parks on its point (see Park); any other action's goes now. */
  #leave(act) {
    this.#end(act, false);
    // a cursor whose page was never set going has nothing to park
    if (!act.press || !act.started) return this.hide();
    this.park.set(act.chatId, act.key);
    this.#pump();
  }

  get parked() {
    return this.park.at;
  }

  /** Stop, Esc, a take-over or the end of a turn: the chat's cursor goes at once and the input waiting on it goes no further than its checks allow. */
  cancel(chatId) {
    this.#unqueue((a) => a.chatId === chatId);
    if ((this.active && this.active.chatId === chatId) || this.park.at?.chatId === chatId) this.hide();
  }

  /** A turn ended: the chat's cursor goes and the points its next actions come from are forgotten. */
  forgetPositions(chatId) {
    this.cancel(chatId);
    for (const [key, v] of this.previous) if (v.chatId === chatId) this.previous.delete(key);
  }

  /** The chat was archived or deleted: its cursor and remembered positions go. */
  forget(chatId) {
    this.forgetPositions(chatId);
  }

  /**
   * Shows a drag, which goes through every point of its path (`points`, global points) over the window `bounds`: the pointer glides evenly through them and the
   * path is drawn; its last point is the chat's previous one. False when nothing is shown (an approach still on its way keeps the overlay).
   */
  show({ bounds, points, chatId, bundleId }) {
    if (!validBounds(bounds)) return false;
    const global = (Array.isArray(points) ? points : []).filter(finite);
    const pts = global.map((p) => ({ x: p.x - bounds.x, y: p.y - bounds.y }));
    if (!pts.length) return false;
    if (this.active && !this.active.played) return false;
    const w = this.#ensure();
    if (!w) return false;
    this.park.clear();
    this.#end(this.active, false);
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    const from = this.last?.key === key ? this.last.point : { x: pts[0].x + ENTRY.x, y: pts[0].y + ENTRY.y };
    this.last = { key, point: pts[pts.length - 1] };
    if (chatId !== undefined) {
      const at = global[global.length - 1];
      this.previous.set(identityKey(chatId, String(bundleId).toLowerCase()), { chatId, x: at.x, y: at.y });
    }
    try {
      this.#place(w, bounds);
      this.#present(w, cursorHtml({ width: bounds.width, height: bounds.height, from, points: pts }));
    } catch {
      return false;
    }
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => this.hide(), HIDE_AFTER_MS);
    return true;
  }

  hide() {
    this.generation++;
    this.park.clear();
    this.#dropListeners();
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.last = null;
    try {
      if (this.window && !this.window.isDestroyed()) this.window.hide();
    } catch (error) {
      // the window may already be destroyed
      noteIgnored('hide the phantom cursor', error);
    }
    this.#end(this.active, false);
    this.#pump();
  }

  dispose() {
    this.#unqueue(() => true);
    this.hide();
    try {
      this.window?.destroy();
    } catch (error) {
      // the window may already be destroyed
      noteIgnored('close the phantom cursor', error);
    }
    this.window = null;
  }

  /** Puts `act` on the overlay: the cursor appears when its page has loaded, and the input waits for what the plan says. */
  #start(act) {
    for (const id of act.timers) this.timers.clearTimeout(id);
    act.timers.clear();
    this.#end(this.active, false);
    this.park.clear();
    const w = this.#ensure();
    if (!w) return this.#end(act);
    this.active = act;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    const before = this.previous.get(act.key);
    const { bounds, global } = act;
    const plan = planApproach({
      from: before ? { x: before.x - bounds.x, y: before.y - bounds.y } : null,
      to: { x: global.x - bounds.x, y: global.y - bounds.y },
      bounds: { x: 0, y: 0, width: bounds.width, height: bounds.height },
      reducedMotion: this.reducedMotion(),
    });
    if (!act.rec) this.previous.set(act.key, { chatId: act.chatId, x: global.x, y: global.y });
    const generation = ++this.generation;
    this.#dropListeners();
    // a page that is not loaded and set going by the cap shows nothing: the input must not go before the cursor can be seen, nor wait longer
    const nonce = newNonce();
    const cap = this.timers.setTimeout(() => {
      act.timers.delete(cap);
      noteUnshown(w, nonce);
      this.hide();
    }, LOAD_WAIT_MS);
    act.timers.add(cap);
    try {
      this.#place(w, bounds);
      w.loadURL(dataUrl(approachHtml({ plan, press: act.press, nonce, holdMs: PARK_MS }))).then(
        () => {
          if (this.active !== act || this.generation !== generation) return;
          // loadURL may answer for an older navigation still settling: the start goes to this page, once it is the one showing
          this.#whenShowing(w, nonce, () => {
            // the page may finish loading long after: only the action and the start this wait was made for may go on
            if (this.active !== act || this.generation !== generation) return;
            this.#reveal(w);
            this.#run(w, act, plan, generation, cap, nonce);
          });
        },
        (error) => {
          // the cursor is cosmetic; a page that failed to load shows nothing and holds nothing
          noteIgnored('load the phantom cursor', error);
          if (this.active === act) this.#fail(act);
        },
      );
    } catch {
      this.#fail(act);
    }
  }

  /** The action's page could not be shown: it goes on with no cursor, and the page it was to replace (a parked cursor) goes too, so none is left with no owner. */
  #fail(act) {
    this.#end(act, false);
    this.hide();
  }

  /**
   * The loaded page is paused at its start: sets it going and starts the plan's clock when the animations really start (the insert has
   * resolved and one frame has passed), so the arrival, the press and the hide are all measured from the moment the glide begins.
   */
  #run(w, act, plan, generation, cap, nonce) {
    const begin = () => {
      // the signal must have landed on this approach's own page; if another page took over meanwhile, the cap ends the action
      if (this.active !== act || this.generation !== generation || !isShowing(w, nonce)) return;
      this.#later(act, FRAME_MS, () => {
        this.timers.clearTimeout(cap);
        act.timers.delete(cap);
        act.started = true;
        const { inputAt, playedAt } = scheduleOf(plan, act.press);
        if (act.press) this.#later(act, inputAt, () => act.resolve());
        this.#later(act, playedAt, () => this.#played(act));
      });
    };
    const failed = (error) => {
      // the page runs without the signal (its animations stay paused): the cap ends the action with no cursor
      noteIgnored('start the phantom cursor', error);
    };
    try {
      w.webContents.insertCSS(RUN_CSS).then(begin, failed);
    } catch (error) {
      failed(error);
    }
  }

  #dropListeners() {
    for (const off of this.listeners.splice(0)) {
      try {
        off();
      } catch (error) {
        // the window may already be destroyed
        noteIgnored('drop the phantom cursor page wait', error);
      }
    }
  }

  /** Runs `f` once the window's committed page is the one carrying `nonce`: now, or when a page finishes loading and it is. */
  #whenShowing(w, nonce, f) {
    if (isShowing(w, nonce)) return f();
    const wc = w.webContents;
    const on = () => {
      if (!isShowing(w, nonce)) return;
      wc.removeListener('did-finish-load', on);
      f();
    };
    try {
      wc.on('did-finish-load', on);
      // a newer page or a hide makes this wait void: its listener goes with the next load's check or the cap
      this.listeners.push(() => wc.removeListener('did-finish-load', on));
    } catch (error) {
      noteIgnored('wait for the phantom cursor page', error);
    }
  }

  /** The cursor has played out: the overlay is free for the next action, and the window hides if nothing reports or comes. */
  #played(act) {
    act.played = true;
    if (this.queue.length) this.#pump();
    else this.#later(act, STALE_MS, () => this.hide());
  }

  /** Queues `act` for the overlay: it waits for its turn and goes on with no cursor after QUEUE_CAP_MS. */
  #wait(act) {
    this.queue.push(act);
    this.#later(act, QUEUE_CAP_MS, () => this.#unqueue((a) => a === act));
  }

  /** Takes the queued actions that `match` out (their input goes on, without a cursor). */
  #unqueue(match) {
    const gone = this.queue.filter(match);
    this.queue = this.queue.filter((a) => !match(a));
    for (const a of gone) this.#end(a, false);
  }

  /** Starts the next queued action when the overlay is free. */
  #pump() {
    if (!this.queue.length || (this.active && !this.active.played)) return;
    this.#start(/** @type {any} */ (this.queue.shift()));
  }

  /** Shows the window (its page has loaded). */
  #reveal(w) {
    try {
      if (!w.isDestroyed()) w.showInactive();
    } catch (error) {
      // the cursor is cosmetic
      noteIgnored('show the phantom cursor', error);
    }
  }

  /** Loads `html` and shows the window once it is in (never the page that was there before). */
  #present(w, html) {
    const generation = ++this.generation;
    this.#dropListeners();
    w.loadURL(dataUrl(html)).then(
      () => {
        if (this.generation === generation) this.#reveal(w);
      },
      (error) => {
        // the cursor is cosmetic; a failed load just shows nothing
        noteIgnored('load the phantom cursor', error);
      },
    );
  }

  /** Ends an action: its timers stop, whoever waits on it goes on, and it is no longer the active one (the next in line takes the overlay unless `pump` is false). */
  #end(act, pump = true) {
    if (!act) return;
    for (const id of act.timers) this.timers.clearTimeout(id);
    act.timers.clear();
    const was = this.active === act;
    if (was) this.active = null;
    act.resolve();
    if (was && pump) this.#pump();
  }

  #later(act, ms, f) {
    const id = this.timers.setTimeout(() => {
      act.timers.delete(id);
      f();
    }, ms);
    act.timers.add(id);
  }

  #place(w, bounds) {
    w.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    });
  }

  #systemReducedMotion() {
    try {
      return this.electron?.systemPreferences?.getAnimationSettings?.().prefersReducedMotion === true;
    } catch {
      return false;
    }
  }

  #ensure() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const BW = this.electron?.BrowserWindow;
    if (!BW) return null;
    try {
      const w = new BW({
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        focusable: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        enableLargerThanScreen: true,
        title: 'MoPilot phantom cursor',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false },
      });
      w.setIgnoreMouseEvents(true);
      // above the target window and the apps covering it; the helper's hit test looks through this level
      w.setAlwaysOnTop(true, 'screen-saver');
      w.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
      // never in a screenshot or a screen share
      w.setContentProtection(true);
      this.window = w;
      return w;
    } catch {
      return null;
    }
  }
}

module.exports = {
  PhantomCursor,
  cursorHtml,
  approachHtml,
  HIDE_AFTER_MS,
  STALE_MS,
  LOAD_WAIT_MS,
  FRAME_MS,
  RUN_CSS,
  QUEUE_CAP_MS,
  INPUT_LEAD_MS,
  HOLD_CAP_MS,
  PARK_MS,
  scheduleOf,
  DRAG_MS,
};
