// The agent's cursor on a Host's desktop, for the pane (G8 #3903): a Host's screen has no overlay window (the frames are stills of the display, taken without a pointer), so the pane draws the agent's pointer over the frame. It plays the same plan as the cursor on this Mac (shared/cursorApproach.mjs planApproach, observed Sky timings), and is driven by the agent's action, never by when a frame arrives: the approach starts when the action starts, the click goes out when the cursor has arrived (a lead before the press, as phantomCursor.cjs does), and the press is shown when the Host answers the click (the Host's answer is the nearest to the helper's click.dispatched that crosses the wire).
//
// A point is in the Host display's points; the pane maps it into the frame it shows. The cursor is stamped with the version of the display geometry the chat's latest screenshot had (a version changes when the display's origin or size in points does; the picture's own scale is the frame's, so a scaled screenshot of the agent's does not change it), and the pane draws it only on a frame of the same version: a frame of another layout never shows the cursor in the wrong place.
const { planApproach } = require('../../shared/cursorApproach.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { ToolError } = require('./contract/registry.cjs');

/** How long a click's input goes ahead of the press (phantomCursor.cjs INPUT_LEAD_MS: the helper's own latency). */
const INPUT_LEAD_MS = 140;
const finite = (/** @type {any} */ p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * @param {object} o
 * @param {(chatId: string, message: object) => void} o.emit one message for the panes that watch the chat's desktop (it names its Host: a pane of another machine ignores it)
 * @param {typeof planApproach} [o.plan]
 * @param {() => boolean} [o.reducedMotion] whether the user asks for Reduce Motion (the cursor jumps)
 */
function createHostCursor({ emit, plan = planApproach, reducedMotion = () => false }) {
  /** Everything is kept per chat on one Host: a chat that moves to another machine starts from nothing there. */
  const keyOf = (/** @type {string} */ hostId, /** @type {string} */ chatId) => `${hostId}\u0000${chatId}`;
  /** host+chat -> where its cursor last landed, in display points @type {Map<string, { x: number, y: number }>} */
  const last = new Map();
  /** host+chat -> the display layouts seen (layout -> version) and the version of the one the agent last looked at @type {Map<string, { layouts: Map<string, number>, agent: number }>} */
  const layouts = new Map();
  /** chat id -> the action whose cursor is showing @type {Map<string, { id: number, hostId: string, to: { x: number, y: number } }>} */
  const current = new Map();
  let ids = 0;
  /** Pane notifications are optional; state retirement and Host input must still finish if a window has gone. @param {string} chatId @param {object} message */
  const publish = (chatId, message) => {
    try {
      emit(chatId, message);
    } catch (error) {
      noteIgnored("publish the agent's cursor on a Host's desktop", error);
    }
  };
  const layoutsOf = (/** @type {string} */ k) => layouts.get(k) ?? layouts.set(k, { layouts: new Map(), agent: 0 }).get(k);
  const versionFor = (/** @type {string} */ hostId, /** @type {string} */ chatId, /** @type {any} */ shot) => {
    const d = shot?.display;
    const layout = JSON.stringify([d?.x, d?.y, d?.width, d?.height]);
    const known = /** @type {NonNullable<ReturnType<typeof layoutsOf>>} */ (layoutsOf(keyOf(hostId, chatId)));
    if (!known.layouts.has(layout)) known.layouts.set(layout, known.layouts.size + 1);
    return { known, version: /** @type {number} */ (known.layouts.get(layout)) };
  };
  const hideCurrent = (/** @type {string} */ chatId, /** @type {number} */ id) => {
    const c = current.get(chatId);
    if (!c) return;
    current.delete(chatId);
    publish(chatId, { kind: 'hide', id, hostId: c.hostId });
  };
  return {
    /** The agent took a screenshot of the chat's display: its layout is the one the agent places its next actions by. Returns the layout's version. @param {string} hostId @param {string} chatId @param {any} shot */
    agentSaw(hostId, chatId, shot) {
      const { known, version } = versionFor(hostId, chatId, shot);
      known.agent = version;
      return version;
    },
    /** The version of the layout a pane's frame has (a pane's frame never changes what the agent placed its actions by). @param {string} hostId @param {string} chatId @param {any} shot */
    frameVersion: (hostId, chatId, shot) => versionFor(hostId, chatId, shot).version,
    /** The version the agent last looked at (0: none yet). @param {string} hostId @param {string} chatId */
    versionOf: (hostId, chatId) => layouts.get(keyOf(hostId, chatId))?.agent ?? 0,
    /**
     * The action starts: the cursor appears and glides to `to`. Returns the action's id and how long the action waits before its input goes (the press
     * minus the lead; the whole glide for an action that does not press). A newer approach of the same chat replaces the one showing. Null with no usable point (nothing shown).
     * @param {string} hostId @param {string} chatId @param {{ x: number, y: number }} to @param {boolean} press
     */
    approach(hostId, chatId, to, press) {
      if (!finite(to)) return null;
      const p = plan({ from: last.get(keyOf(hostId, chatId)) ?? null, to, reducedMotion: reducedMotion() });
      const id = ++ids;
      current.set(chatId, { id, hostId, to: { x: to.x, y: to.y } });
      publish(chatId, {
        kind: 'approach',
        id,
        hostId,
        version: this.versionOf(hostId, chatId),
        press,
        plan: { samples: p.samples, to: p.to, pressAtMs: p.pressAtMs, totalMs: p.totalMs, hideAfterClickMs: p.hideAfterClickMs },
      });
      return { id, waitMs: press ? Math.max(0, p.pressAtMs - INPUT_LEAD_MS) : p.durationMs };
    },
    /** Whether the action is still the one showing: Stop, a takeover, a turn's end and a newer action end it. @param {string} chatId @param {number} id */
    isCurrent: (chatId, id) => current.get(chatId)?.id === id,
    /** The Host answered the action: the cursor landed (the next glide starts there) and the click went out. Ignored for an action that was replaced. @param {string} chatId @param {number} id */
    dispatched(chatId, id) {
      const c = current.get(chatId);
      if (c?.id !== id) return;
      last.set(keyOf(c.hostId, chatId), c.to);
      publish(chatId, { kind: 'dispatched', id, hostId: c.hostId });
    },
    /** The action failed: the cursor goes now, and the next glide starts where the last one landed. @param {string} chatId @param {number} id */
    failed(chatId, id) {
      if (current.get(chatId)?.id === id) hideCurrent(chatId, id);
    },
    /** The user took over, the turn ended or Stop: nothing of the agent's shows, and an action still on its way does not go. @param {string} chatId */
    hide: (chatId) => hideCurrent(chatId, 0),
    /** A machine dropped its connection: what shows for its chats goes. @param {string} hostId */
    hideHost(hostId) {
      for (const [chatId, c] of [...current]) if (c.hostId === hostId) hideCurrent(chatId, 0);
    },
    /** The chat ended: its positions and layouts go, on every Host. @param {string} chatId */
    forget(chatId) {
      current.delete(chatId);
      for (const map of [last, layouts]) for (const k of [...map.keys()]) if (k.endsWith(`\u0000${chatId}`)) map.delete(k);
    },
  };
}

/**
 * Wraps the helper's call so a pointer action shows the cursor: it approaches first, the input goes when the cursor has arrived, and the press shows when the Host
 * answers. Any other call goes straight through. The cursor never decides whether the action runs: a failing cursor is noted and the action goes on.
 * @param {ReturnType<typeof createHostCursor>} cursor
 * @param {(ms: number) => Promise<void>} sleep
 * @param {string} hostId the Host the helper is for
 * @param {(chatId: string) => boolean} stopped the user took over meanwhile: the action ends with user_took_over before its input
 */
function cursorAround(cursor, hostId, sleep, stopped) {
  /** method -> whether it presses @type {Map<string, boolean>} */
  const POINTER = new Map([
    ['input.click', true],
    ['input.move', false],
    ['input.scroll', false],
  ]);
  /** Drawing notifications cannot change the outcome of an input that ran. @param {() => void} publish */
  const notify = (publish) => {
    try {
      publish();
    } catch (error) {
      noteIgnored("update the agent's cursor on a Host's desktop", error);
    }
  };
  /**
   * @param {string} chat @param {string} method @param {any} params
   * @param {() => Promise<any>} run the call itself
   */
  return async (chat, method, params, run) => {
    if (!POINTER.has(method)) return run();
    /** @type {{ id: number, waitMs: number } | null} */
    let shown = null;
    try {
      shown = cursor.approach(hostId, chat, { x: params?.x, y: params?.y }, Boolean(POINTER.get(method)));
      if (shown) await sleep(shown.waitMs);
    } catch (error) {
      noteIgnored("show the agent's cursor on a Host's desktop", error);
    }
    // the user took the desktop over while the cursor was on its way: the input does not go
    if (stopped(chat)) {
      if (shown) notify(() => cursor.failed(chat, /** @type {NonNullable<typeof shown>} */ (shown).id));
      throw new ToolError('You are driving this desktop. Hand it back to let the agent continue.', 'user_took_over');
    }
    // Stop, an abort or the turn's end while the cursor travelled: the input does not go (the same hide that takes the drawing away ends the action)
    if (shown && !cursor.isCurrent(chat, shown.id)) throw new ToolError('The action was stopped before it ran.', 'aborted');
    let result;
    try {
      result = await run();
    } catch (error) {
      if (shown) notify(() => cursor.failed(chat, /** @type {NonNullable<typeof shown>} */ (shown).id));
      throw error;
    }
    if (shown) notify(() => cursor.dispatched(chat, /** @type {NonNullable<typeof shown>} */ (shown).id));
    return result;
  };
}

module.exports = { createHostCursor, cursorAround, INPUT_LEAD_MS };
