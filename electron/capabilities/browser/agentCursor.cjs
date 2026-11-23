// The agent cursor (IAB-04): while an agent clicks, types or scrolls in a pane tab, the page shows a
// virtual pointer gliding to where the action lands, a ripple on each click, a highlight around the
// field it types into, and a short label beside the pointer ("Clicking “Submit”"), so the user sees
// what the agent does. Harness-neutral: BrowserTabs (host.cjs) calls it for every browser_* input
// action, whichever harness asked.
//
// - The overlay is drawn by a script in an isolated world of its own (Page.createIsolatedWorld,
//   "mopilot-cursor"), never the page's JavaScript. It adds one aria-hidden element with a closed
//   shadow root at the end of <html>, pointer-events: none, so it takes no input, doesn't show in the
//   accessibility tree the agent reads, and changes inside it don't count as page mutations.
// - The action waits for the pointer (#1511, as in the Codex app): act() resolves once the glide has arrived, so the
//   click, keys or wheel land under it. A click or hover on a point comes in the way the Codex app's cursor does (#3810, measured in
//   its in-app browser): planned here by shared/cursorApproach.mjs (OBSERVED_CODEX_IAB), the pointer appears about 140 pt away on the line
//   back to its last point, springs in (0.162 s, no overshoot), hovers, clicks, lingers 287 ms and fades; the page plays the planned path.
//   A pointer still on the page (after a key or a scroll) glides 175 ms, a longer move up to TRAVEL_MS_MAX; a pointer already
//   at the target, a hidden page (no window, a hidden pane) or reduced motion moves at once and waits for nothing.
//   A stopped call ends the wait (actionGuard pause), and its caller then refuses to act (hostInput.cjs show).
// - Otherwise cosmetic: every call is bounded and swallows its errors, so it never fails an action.
// - Hidden while the tools take a screenshot (the model sees the page, not its own pointer); removed when
//   the user takes the tab over and at the end of the turn, and by itself after IDLE_MS without actions.
// - Typed text never shows: the label names the field ("Typing in “Email”"), not what goes into it.
// - With `frame` (the user's Chrome, chromeHost.cjs) the overlay also draws the control frame (agentControlFrame.cjs)
//   from the agent's first call on the tab until the turn ends, on every page the tab loads meanwhile; the pointer
//   still fades after IDLE_MS, and the frame removes itself only after FRAME_IDLE_MS (main is gone). Its Stop calls `onStop`.
//   With it the tab's favicon carries a mark (agentTabMark.cjs) and the pill follows the chat's turn (status): waiting for the
//   user's OK, it says so and its Review calls `onReview`; the turn's end leaves the tab's deliverable/handoff dot (clear's `final`).
//   The chat's other held tabs (its tab group's) say the agent is active in the group, and their Go to tab brings the tab it works
//   on now to the front (Page.bringToFront on that tab's own debugger, which the agent holds).

const { labelFor, overlayArgs } = require('./agentCursorLabels.cjs');
const { cursorOverlay, CURSOR_SOURCE: SOURCE } = require('./agentCursorOverlay.cjs');
const { pause } = require('../contract/actionGuard.cjs');
const { labelText } = require('../../../shared/labelText.mjs');
const { planApproach, OBSERVED_CODEX_IAB } = require('../../../shared/cursorApproach.mjs');

const { FRAME_CSS, FRAME_SOURCE, STOP_BINDING } = require('./agentControlFrame.cjs');
const { MARK_SOURCE } = require('./agentTabMark.cjs');

const WORLD = 'mopilot-cursor';
const CALL_MS = 400;
/** The longest glide the action waits for, and the frame after it the page paints the arrival in. */
const TRAVEL_MS_MAX = 500;
const SETTLE_MS = 16;
const IDLE_MS = 30_000;
/** The approach path sent to the page: the plan's 120 Hz samples up to its arrival, every other one (60 Hz is what the page can draw). */
const PATH_STEP = 2;
/** How long a control frame outlives the agent's last call when main can't remove it (as long as a chat keeps its Chrome tabs). */
const FRAME_IDLE_MS = 10 * 60_000;

const { noteIgnored } = require('../../ignored.cjs');
const bounded = (p, ms) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });

class AgentCursor {
  /**
   * @param {{ enabled?: () => boolean, callMs?: number, idleMs?: number, frame?: boolean, frameIdleMs?: number,
   *           onStop?: (tab: any) => void, onReview?: (tab: any) => void, shown?: (tab: any) => boolean }} [o]
   *   shown: whether the user sees the tab's page now (else the pointer moves at once and nothing waits)
   *   frame: draw the control frame too (agentControlFrame.cjs); onStop: the user pressed its Stop on `tab`; onReview: its Review
   */
  constructor(o = {}) {
    this.enabled = o.enabled ?? (() => true);
    this.callMs = o.callMs ?? CALL_MS;
    this.idleMs = o.idleMs ?? IDLE_MS;
    this.frame = !!o.frame;
    this.frameIdleMs = o.frameIdleMs ?? FRAME_IDLE_MS;
    this.onStop = o.onStop ?? (() => undefined);
    this.onReview = o.onReview ?? (() => undefined);
    /** with `frame`: the chats waiting for the user's OK (status) */
    this.waiting = new Set();
    /** with `frame`: the tabs held this turn, to reach a chat's when its turn changes */
    this.holding = new Set();
    /** with `frame`: chatId -> the tab the agent works on now (the others it holds show the group's pill) */
    this.front = new Map();
    this.shown = o.shown ?? (() => true);
    /** tab -> the cursor world's execution context id in its top frame */
    this.worlds = new WeakMap();
    /** with `frame`: tabs the agent works on this turn (the frame shows on each page they load until clear) */
    this.held = new WeakSet();
    /** debuggers whose events this cursor follows */
    this.heard = new WeakSet();
    /** tab -> where its pointer last went, for the overlay a new page draws */
    this.last = new WeakMap();
    /** tab -> the running act's promise, settled once its pointer has arrived (arrival) */
    this.moving = new WeakMap();
  }

  /** What the overlay is made with: the idle time, the control frame's parts with `frame`, the label joiner, the longest glide. */
  #args() {
    const join = labelText.toString();
    if (!this.frame) return `${this.idleMs}, null, ${join}, ${TRAVEL_MS_MAX}`;
    return `${this.idleMs}, { frame: ${FRAME_SOURCE}, mark: ${MARK_SOURCE}, css: ${JSON.stringify(FRAME_CSS)}, binding: ${JSON.stringify(STOP_BINDING)}, lifeMs: ${this.frameIdleMs} }, ${join}, ${TRAVEL_MS_MAX}`;
  }

  /** With `frame`: Stop pressed on the page, a new page loaded (the frame goes on it), the debugger gone (so is the world). */
  #hear(tab) {
    const dbg = tab.backend?.debugger;
    if (!dbg || typeof dbg.on !== 'function' || this.heard.has(dbg)) return;
    this.heard.add(dbg);
    dbg.on('message', (_e, method, params) => {
      if (!this.held.has(tab)) return;
      if (method === 'Runtime.bindingCalled' && params?.name === STOP_BINDING) {
        if (params.payload === 'front') return void this.#bringFront(tab);
        const review = params.payload === 'review';
        try {
          (review ? this.onReview : this.onStop)(tab);
        } catch (error) {
          noteIgnored(review ? 'open a chat from the page' : 'stop a chat from the page', error);
        }
      } else if (method === 'Page.domContentEventFired') void this.mark(tab);
    });
    dbg.on('detach', () => {
      this.worlds.delete(tab);
      // the agent's tab closed: Go to tab on the others leads to the one it held last
      if (this.front.get(tab.chatId) === tab) void this.#promote(tab);
    });
  }

  /** Go to tab on another of the chat's tabs: the tab the agent works on comes to the front. */
  async #bringFront(tab) {
    const front = this.front.get(tab.chatId);
    if (!front || front === tab) return;
    try {
      await front.send('Page.bringToFront');
    } catch (error) {
      noteIgnored('bring the agent tab to the front', error);
    }
  }

  /**
   * With `frame`: the agent works on `tab` now. The chat's tab it worked on before shows the group's pill; this one the working
   * pill again (a tab drawn later starts with its role, mark). Bounded by callMs each.
   */
  async #lead(tab) {
    const before = this.front.get(tab.chatId);
    if (before === tab) return;
    this.front.set(tab.chatId, tab);
    const calls = [this.worlds.has(tab) ? this.#call(tab, 'role("front")', { create: false }) : null];
    if (before && this.held.has(before)) calls.push(this.#call(before, 'role("group")', { create: false }));
    await Promise.all(calls.map((c) => c && bounded(c, this.callMs)));
  }

  /** `gone` was the chat's front tab: the chat's tab held last that is still drawn (its debugger still on) takes its place, or none does. */
  async #promote(gone) {
    this.front.delete(gone.chatId);
    const next = [...this.holding].filter((t) => t !== gone && t.chatId === gone.chatId && this.held.has(t) && this.worlds.has(t)).at(-1);
    if (next) await this.#lead(next);
  }

  #seen(tab) {
    try {
      return this.shown(tab) === true;
    } catch {
      return false;
    }
  }

  #on() {
    try {
      return this.enabled() === true;
    } catch {
      return false;
    }
  }

  /** Runs `expr` (on __mopilotCursor) in the tab's cursor world, making the world when it's missing or went away. */
  async #call(tab, expr, { create = true } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let contextId = this.worlds.get(tab);
      if (contextId == null) {
        if (!create) return null;
        if (this.frame) {
          this.#hear(tab);
          // Stop's way back to main, only in the cursor's world (a binding lasts for the CDP session)
          await tab.send('Runtime.addBinding', { name: STOP_BINDING, executionContextName: WORLD });
        }
        const { frameTree } = await tab.send('Page.getFrameTree');
        ({ executionContextId: contextId } = await tab.send('Page.createIsolatedWorld', {
          frameId: frameTree.frame.id,
          worldName: WORLD,
          grantUniveralAccess: false,
        }));
        const r = await tab.send('Runtime.evaluate', { expression: `${SOURCE}(${this.#args()}), true`, contextId, returnByValue: true });
        if (r?.exceptionDetails) return null;
        this.worlds.set(tab, contextId);
      }
      let r;
      try {
        r = await tab.send('Runtime.evaluate', {
          expression: `globalThis.__mopilotCursor.${expr}`,
          contextId,
          returnByValue: true,
          awaitPromise: true,
        });
      } catch {
        // the page navigated: its worlds are gone
        this.worlds.delete(tab);
        continue;
      }
      if (r?.exceptionDetails) {
        this.worlds.delete(tab);
        continue;
      }
      return r?.result?.value ?? null;
    }
    return null;
  }

  /**
   * Shows an action: { kind: 'click' | 'hover' | 'drag' | 'scroll' | 'type' | 'key', x?, y?, name?,
   * button?, clickCount?, to?, direction?, keys? }. Never throws; bounded by callMs.
   */
  act(tab, action) {
    if (!this.#on() || !action) return Promise.resolve(null);
    if (this.frame) {
      this.held.add(tab);
      this.holding.add(tab);
      void this.#lead(tab);
    }
    // set before the first await: an input command right behind this one (the Codex plugin's moveMouse) waits on it
    const p = this.#show(tab, action);
    this.moving.set(tab, p);
    return p;
  }

  /**
   * The Codex app's cursor motion for a click or hover at (x, y) (shared/cursorApproach.mjs, the in-app browser profile): where the pointer
   * comes from, the path it takes, when it presses and how long it lingers. Data only; the page plays it. Null without a target point.
   */
  #approach(args, last, still) {
    if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) return null;
    const plan = planApproach({ from: last ?? null, to: { x: args.x, y: args.y }, reducedMotion: still, profile: OBSERVED_CODEX_IAB });
    if (!(plan.durationMs > 0)) return null;
    const round = (n) => Math.round(n * 10) / 10;
    const path = plan.samples
      .filter((s, i) => s.t < plan.durationMs && i % PATH_STEP === 0)
      .map((s) => [round(s.t), round(s.x), round(s.y)]);
    path.push([round(plan.durationMs), round(plan.to.x), round(plan.to.y)]);
    return { path, durationMs: round(plan.durationMs), hoverMs: plan.hoverMs, hideAfterClickMs: plan.hideAfterClickMs };
  }

  /** Draws the action, then waits (at most TRAVEL_MS_MAX, less when the call is stopped) until its pointer arrives. */
  async #show(tab, action) {
    const args = overlayArgs(action);
    const last = this.last.get(tab);
    if (last) args.from = last;
    // nobody sees the page (a hidden pane, no window): no glide to wait for
    if (!this.#seen(tab)) args.still = true;
    const plan = this.#approach(args, last, !!args.still);
    if (plan) args.plan = plan;
    const r = await bounded(this.#call(tab, `show(${JSON.stringify(args)})`), this.callMs);
    if (!r || typeof r !== 'object') return r;
    if (Number.isFinite(r.x) && Number.isFinite(r.y)) this.last.set(tab, { x: r.x, y: r.y });
    const ms = Number.isFinite(r.ms) ? Math.min(Math.max(r.ms, 0), TRAVEL_MS_MAX) : 0;
    if (ms) await pause(ms + SETTLE_MS);
    return true;
  }

  /** Resolves once the pointer's running glide on `tab` has arrived (at once when none runs); never throws. */
  async arrival(tab) {
    await this.moving.get(tab);
  }

  /**
   * With `frame`: the agent works on the tab (any call, a read too), so the frame shows until clear. Never throws;
   * bounded by callMs; once drawn the turn's later calls skip it (a new page gets it from its own load).
   */
  async hold(tab) {
    if (!this.frame || !this.#on()) return null;
    // every call names the tab the agent works on now; a tab already held is drawn
    if (this.held.has(tab)) {
      await this.#lead(tab);
      return null;
    }
    this.held.add(tab);
    this.holding.add(tab);
    await this.#lead(tab);
    const drawn = await this.mark(tab);
    // not drawn (a slow page, a world that failed): the next call tries again
    if (drawn !== true) {
      this.held.delete(tab);
      this.holding.delete(tab);
    }
    return drawn;
  }

  /** Draws the frame on the tab's page as it is now (a tab held this turn). */
  async mark(tab) {
    if (!this.held.has(tab) || !this.#on()) return null;
    const args = {
      frame: true,
      ...(this.waiting.has(tab.chatId) ? { status: 'waiting' } : {}),
      ...(this.front.get(tab.chatId) === tab ? {} : { role: 'group' }),
    };
    return bounded(this.#call(tab, `show(${JSON.stringify(args)})`), this.callMs);
  }

  /**
   * With `frame`: the chat's turn is 'running', 'waiting' (for the user's OK) or 'done'; the pill and favicon of every tab it holds
   * follow, and a page loaded later starts that way. Never throws; each tab bounded by callMs.
   */
  async status(chatId, state) {
    if (!this.frame) return;
    if (state === 'waiting') this.waiting.add(chatId);
    else this.waiting.delete(chatId);
    if (state === 'done') {
      // the turn end clears what it reaches; a tab that went before then (closed mid-turn) is let go here
      for (const t of this.holding) if (t.chatId === chatId) this.holding.delete(t);
      this.front.delete(chatId);
      return;
    }
    const expr = `status(${JSON.stringify(state === 'waiting' ? 'waiting' : 'running')})`;
    await Promise.all(
      [...this.holding]
        .filter((t) => t.chatId === chatId && this.held.has(t))
        .map((t) => bounded(this.#call(t, expr, { create: false }), this.callMs)),
    );
  }

  /** Hides the overlay for a screenshot (only where it is drawn). */
  async conceal(tab) {
    return bounded(this.#call(tab, 'conceal(true)', { create: false }), this.callMs);
  }

  /** Shows it again after the screenshot. */
  async reveal(tab) {
    return bounded(this.#call(tab, 'conceal(false)', { create: false }), this.callMs);
  }

  /**
   * Removes the overlay now (take over, turn end, a hand-off with its `final` mark): resolves once the page did (true), or after callMs. The turn end
   * awaits it before its turn's commands stop (a Chrome tab's are refused then, #1632); an overlay it can't reach still
   * removes itself (after idleMs, or FRAME_IDLE_MS with the frame).
   * @param {any} tab @param {string | null} [final] the tab's turn-end favicon mark ('deliverable', 'handoff'; agentTabMark.cjs finalMark)
   */
  async clear(tab, final = null) {
    this.held.delete(tab);
    this.holding.delete(tab);
    // handed to the user, or taken over: another tab the chat holds leads (at the turn's end none is left)
    if (this.front.get(tab.chatId) === tab) void this.#promote(tab);
    this.last.delete(tab);
    if (!this.worlds.has(tab)) return false;
    const done = await bounded(this.#call(tab, final ? `clear(${JSON.stringify(final)})` : 'clear()', { create: false }), this.callMs);
    this.worlds.delete(tab);
    return done === true;
  }
}

module.exports = {
  AgentCursor,
  cursorOverlay,
  labelFor,
  overlayArgs,
  CURSOR_SOURCE: SOURCE,
  CURSOR_WORLD: WORLD,
  CURSOR_IDLE_MS: IDLE_MS,
  TRAVEL_MS_MAX,
  FRAME_IDLE_MS,
};
