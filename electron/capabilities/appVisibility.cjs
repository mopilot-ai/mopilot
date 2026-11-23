// What the user sees of background (app-scoped) control while it happens: the phantom cursor over the
// target window, and the chat's control strip (SessionState.appControl): the apps the chat works in,
// each with its window title, a live thumbnail of the window (refreshed with the chat's actions and
// screenshots, at most once a second) and whether the user took it over. Shared by every harness: the
// desktop_app_* tools report here whichever adapter called them.

const { randomUUID } = require('node:crypto');
const { identityKey } = require('../../shared/identityKey.mjs');

const THUMB_EVERY_MS = 1000;

class AppVisibility {
  /**
   * @param {object} o
   * @param {{ get(chatId: string): any, patch(chatId: string, patch: object): void }} o.sessions
   * @param {{ show(a: object): boolean, approach(a: object): Promise<void>, finish(a: object): boolean, dispatched(a: object): boolean, cancel(chatId: string): void, forget(chatId: string): void, forgetPositions(chatId: string): void } | null} [o.cursor] the phantom cursor (phantomCursor.cjs)
   * @param {{ on(event: string, f: (p: any) => void): unknown } | null} [o.helper] the computer-use helper: its click.dispatched ('clicked') ends the click's cursor
   * @param {() => number} [o.now]
   * @param {number} [o.thumbEveryMs]
   */
  constructor(o) {
    this.sessions = o.sessions;
    this.cursor = o.cursor || null;
    // the helper's early "mouse-down went out" ends the click's cursor within a frame of the real click (the action's report still decides whether it worked)
    o.helper?.on('clicked', (p) => this.clickDispatched(p?.signal));
    this.now = o.now || Date.now;
    this.thumbEveryMs = o.thumbEveryMs ?? THUMB_EVERY_MS;
    /** chatId -> when a thumbnail was last asked for */
    this.asked = new Map();
    /** Structured chat/bundle tuple -> {chatId, title, windowId, thumbnail}: the latest view, also from before the chat took the app */
    this.views = new Map();
    /** the actions whose result already reached the cursor: a second report of one (a retry, a brief-foreground escalation) never touches it */
    this.reported = new WeakSet();
    /** signal id -> {chatId, token}: the clicks whose mouse-down the helper reports early (click.dispatched), and the signal an action's token was given */
    this.signals = new Map();
    this.signalOf = new WeakMap();
  }

  /** The id a click carries to the helper (`signal`), so the helper's early "mouse-down went out" can end this action's cursor; null with no cursor. */
  signalFor(chatId, token) {
    if (!this.cursor || !token) return null;
    const signal = this.signalOf.get(token) ?? randomUUID();
    this.signalOf.set(token, signal);
    this.signals.set(signal, { chatId, token });
    return signal;
  }

  /** The helper's click.dispatched: the real click went out, so the cursor goes within a frame; whether the click worked is still the action's report (acted). */
  clickDispatched(signal) {
    const s = typeof signal === 'string' ? this.signals.get(signal) : null;
    if (s) this.cursor?.dispatched(s);
  }

  #dropSignal(token) {
    const signal = token && this.signalOf.get(token);
    if (signal) this.signals.delete(signal);
  }

  /** Whether the chat's next action should bring back a thumbnail: at most one a second. */
  thumbnailDue(chatId) {
    const t = this.now();
    const last = this.asked.get(chatId);
    if (last !== undefined && t - last < this.thumbEveryMs) return false;
    this.asked.set(chatId, t);
    return true;
  }

  /**
   * An input action is about to run: the cursor appears and glides to where it lands (the chat's previous point is where it comes from),
   * and this resolves when the input may go: a click after the cursor has arrived, hovered and pressed, any other action at once. Only
   * a window on the current Space shows it. Every harness reaches it the same way, through the desktop_app_* tools.
   * Only the actions of desktop_app_click, type, key, scroll, focus and drag get a cursor, and only when they run on their own: what runs
   * inside desktop_app_batch (the helper runs the steps together), desktop_app_script, Shortcuts, OCR or the file panel shows no
   * pre-click cursor (a batch step's arrow appears after the fact, in acted()). `info.token` names the action (appScopedApproach.cjs).
   */
  approach(chatId, info) {
    if (!this.cursor || !info.points?.length || !info.bounds || !(info.state == null || info.state === 'visible')) return Promise.resolve();
    // a drag is drawn once it has run (acted); its path is the cursor's
    if (info.action === 'drag' && info.points.length > 1) return Promise.resolve();
    return this.cursor.approach({
      chatId,
      bundleId: info.app.bundleId,
      bounds: info.bounds,
      points: info.points,
      kind: info.action,
      token: info.token,
    });
  }

  /** Stop, Esc, a take-over or the end of the chat's turn: its cursor goes and nothing waits on it. */
  interrupted(chatId, token) {
    this.#dropSignal(token);
    this.cursor?.cancel(chatId);
  }

  /**
   * An action (or a screenshot) ran: {app: {bundleId, name}, windowId, title, bounds, state, action,
   * points (global points), effect, thumb (base64 JPEG or null), token}. An action may report more than once (a retry, the
   * brief-foreground escalation): only its first report touches the cursor.
   */
  acted(chatId, info) {
    // only a window on the current Space shows the cursor: elsewhere it would point at whatever is there
    if (this.cursor && info.points?.length && info.bounds && (info.state == null || info.state === 'visible')) {
      const { token } = info;
      this.#dropSignal(token);
      if (!(token && this.reported.has(token))) {
        if (token) this.reported.add(token);
        // the cursor played its approach before the input: now it goes (confirmation stays in the action's result: no ring, no linger)
        if (!(token && this.cursor.finish({ chatId, token }))) {
          // the action had no approach (a drag, or a step run inside a helper batch): a drag shows its path, another action the approach after the fact
          const at = { chatId, bundleId: info.app.bundleId, bounds: info.bounds, points: info.points };
          if (info.action === 'drag' && info.points.length > 1) this.cursor.show(at);
          else void this.cursor.approach({ ...at, kind: 'move' });
        }
      }
    }
    const k = identityKey(chatId, info.app.bundleId.toLowerCase());
    const prev = this.views.get(k) || { title: null, windowId: null, thumbnail: null };
    const view = {
      title: info.title ?? prev.title,
      windowId: info.windowId ?? prev.windowId,
      thumbnail: info.thumb ? `data:image/jpeg;base64,${info.thumb}` : prev.thumbnail,
    };
    this.views.set(k, { ...view, chatId });
    this.#update(chatId, info.app.bundleId, (e) => ({ ...e, ...view, at: this.now() }));
  }

  /** The chat started (held) or stopped working in an app: its entry in the strip comes or goes. */
  locked(chatId, app, held) {
    const cur = this.sessions.get(chatId)?.appControl?.apps ?? [];
    const k = app.bundleId.toLowerCase();
    const others = cur.filter((e) => e.bundleId.toLowerCase() !== k);
    if (held) {
      const cached = this.views.get(identityKey(chatId, k));
      const view = cached
        ? { title: cached.title, windowId: cached.windowId, thumbnail: cached.thumbnail }
        : { title: null, windowId: null, thumbnail: null };
      this.sessions.patch(chatId, {
        appControl: { apps: [{ bundleId: app.bundleId, app: app.name, ...view, at: this.now(), takenOver: false }, ...others] },
      });
      return;
    }
    this.views.delete(identityKey(chatId, k));
    if (others.length) {
      this.sessions.patch(chatId, { appControl: { apps: others } });
      return;
    }
    this.sessions.patch(chatId, { appControl: null });
    this.asked.delete(chatId);
    // only this chat's cursor: another chat may be showing its own on the one overlay
    this.cursor?.cancel(chatId);
  }

  /** The chat's turn ended: its cursor is gone and the next turn's first action comes in from the default start. */
  turnEnded(chatId) {
    this.cursor?.forgetPositions(chatId);
  }

  /** The user took the app over from the strip (true), or handed it back (false). */
  takenOver(chatId, bundleId, on) {
    if (on) this.cursor?.cancel(chatId);
    this.#update(chatId, bundleId, (e) => ({ ...e, takenOver: !!on }));
  }

  /** The chat was archived or deleted. */
  forget(chatId) {
    this.asked.delete(chatId);
    this.cursor?.forget(chatId);
    for (const [key, view] of this.views) if (view.chatId === chatId) this.views.delete(key);
  }

  #update(chatId, bundleId, f) {
    const apps = this.sessions.get(chatId)?.appControl?.apps;
    const k = String(bundleId).toLowerCase();
    if (!apps?.some((e) => e.bundleId.toLowerCase() === k)) return;
    // the app acted in last comes first
    const next = apps.map((e) => (e.bundleId.toLowerCase() === k ? f(e) : e)).sort((a, b) => b.at - a.at);
    this.sessions.patch(chatId, { appControl: { apps: next } });
  }
}

module.exports = { AppVisibility, THUMB_EVERY_MS };
