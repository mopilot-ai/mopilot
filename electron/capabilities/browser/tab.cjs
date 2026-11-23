// One browser host tab (or adopted popup) and its CDP session: events, frames, the page agent world and refs.
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');

const { sendTabCommand, rendererGone } = require('./browserDispatch.cjs');
const { assertCdpTarget } = require('./cdp.cjs');
const { PAGE_AGENT_SOURCE } = require('./pageAgent.cjs');
const { readThroughClosedRoots } = require('./closedShadow.cjs');
const { PASSKEY_SIGNAL } = require('./passkeys.cjs');
const { AUTO_ATTACH, framesOf } = require('./documentScripts.cjs');
const { BUFFER_MAX, PAGE_BACKDROP, stale, oneLine } = require('./hostUtil.cjs');
const { isHolding, releaseHeld, forgetHeld } = require('./heldInput.cjs');
const { focusForInput } = require('./views.cjs');
const { holdNativeScale } = require('./pageZoom.cjs');
const { isBackendTab, watchLoads, keyOf } = require('./backend.cjs');
const { RefHints } = require('./refHints.cjs');
const { LocalTabContents } = require('./localBackend.cjs');
const { watchWebMcp, catalogOf } = require('./webmcp.cjs');

/** One tab (or adopted popup) and its CDP session. */
class Tab {
  constructor(host, { id, chatId, wc, owner, kind = 'tab', legacy = false, root = null, created = false }) {
    this.host = host;
    this.id = id;
    this.chatId = chatId;
    this.wc = wc;
    /** the page behind the tab, through the backend contract (backend.cjs): a relay or remote tab is its own backend, a pane tab is wrapped */
    this.backend = isBackendTab(wc) ? wc : new LocalTabContents(wc);
    this.owner = owner; // the app window hosting the pane (tabs only)
    this.kind = kind;
    this.legacy = legacy;
    this.root = root; // popups: the tab that opened them
    this.created = created; // opened by the agent this turn
    this.openedByAgent = created; // opened by the agent, in any turn (what the handoff record says about it)
    this.mark = null;
    this.markTurn = 0; // the chat's ended-turn count when it was marked (the mark lapses at the next turn's end)
    this.used = 0; // when the agent last acted on it (host.useSeq)
    this.result = false; // kept open after the turn as where the agent finished
    this.closed = false;
    this.held = false;
    this.takenOver = false; // the user took the tab over for the rest of the turn
    this.userTook = false; // the user took it over and has not handed it back (it outlasts the turn)
    this.signin = null; // { reason, since, finish } while the user signs in (browser_request_signin)
    this.signinMoved = ''; // the agent's note once the user took the sign-in to their Chrome (BrowserTabs.signinMoved)
    this.closing = false; // closed on purpose (browser_tabs_close, the turn end): its page going is not a remount
    this.queue = Promise.resolve();
    this.console = [];
    this.network = new Map();
    this.netOrder = [];
    this.inflight = new Set();
    this.lastNet = 0;
    this.dialog = null;
    this.dialogWaiters = new Set();
    this.fileChooser = null;
    this.downloads = [];
    this.frames = new Map(); // CDP session id -> { sessionId, parent, frameId, world, ownerRef }
    this.world = null;
    this.refSeq = 0;
    this.refFrame = new Map(); // ref -> session id ('' for the top frame)
    this.refHints = new RefHints(); // what each ref named, to re-resolve it after a reload
    this.listening = false;
    this.failure = null;
    this.emulated = null;
    this.navigating = false;
    this.acting = 0; // actions of the agent's under way on it now (BrowserTabs.run)
    this.onMessage = (_e, method, params, sessionId) => this.#event(method, params || {}, sessionId || '');
    // CDP went (the debugger was let go elsewhere): the next attach listens anew, so this one's listeners go too
    this.onDetach = () => {
      if (!this.backend.isDestroyed()) {
        this.backend.debugger.removeListener('message', this.onMessage);
        this.backend.debugger.removeListener('detach', this.onDetach);
      }
      this.#detached();
    };
    watchLoads(this, wc);
  }

  get url() {
    return this.backend.isDestroyed() ? '' : this.backend.getURL();
  }

  get title() {
    return this.backend.isDestroyed() ? '' : this.backend.getTitle();
  }

  /** How its window lays out the page: 'front', 'back' (painted behind the pane), 'none', or null (not reported). */
  get layer() {
    return this.host.layers.get(keyOf(this.backend)) ?? null;
  }

  check() {
    if (this.closed || this.backend.isDestroyed()) throw new ToolError(`Tab ${this.id} was closed.`, 'tab_closed');
    const o = this.host.o;
    assertCdpTarget(this.backend, {
      appContents: o.appContents(),
      panelSession: o.panelSession(),
      popupRoot: this.kind === 'popup' ? this.root.backend : undefined,
    });
  }

  async attach() {
    this.check();
    const dbg = this.backend.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    if (this.listening) return;
    this.listening = true;
    dbg.on('message', this.onMessage);
    dbg.on('detach', this.onDetach);
    const quiet = (m, p) =>
      dbg.sendCommand(m, p).catch((error) => {
        // a domain this target lacks is skipped
        noteIgnored(`set up ${m} on a browser tab`, error);
      });
    // a background tab of the user's Chrome or a parked view is hidden to Chromium: input hangs or is lost (#1509, never
    // in a cross-site iframe). Emulated focus makes it visible and focused to itself until CDP detaches (focusForInput)
    await focusForInput(this.backend, quiet, !!this.host.o.inputWhileHidden);
    await quiet('Page.enable');
    await quiet('Runtime.enable');
    await quiet('Network.enable');
    await quiet('Log.enable');
    await quiet('Page.setInterceptFileChooserDialog', { enabled: true });
    // frames the page's debugger attached before this turn (documentScripts.cjs) are not reported again
    for (const f of framesOf(this.backend)) if (!this.frames.has(f.sessionId)) this.#frame(f.sessionId, f.parent, f.targetId);
    await quiet('Target.setAutoAttach', AUTO_ATTACH);
    // a page with no background is transparent: give it the pane's white, so captures aren't black
    await quiet('Emulation.setDefaultBackgroundColorOverride', PAGE_BACKDROP);
    watchWebMcp(this); // the tools its pages publish (webmcp.cjs), while shared.browser.webmcp is on
  }

  /** Lets go of CDP (turn end): buffers stay, emulation and the agent's worlds go, and so does any key or button left down. */
  detach() {
    const dbg = this.backend.isDestroyed() ? null : this.backend.debugger;
    if (dbg) {
      // a key or button an agent left down (the Codex browser plugin sends raw CDP) is let go first: the events go
      // out now, before CDP detaches, without waiting on a page a dialog may be blocking
      if (isHolding(this) && dbg.isAttached()) void releaseHeld(this, (...command) => dbg.sendCommand(...command));
      dbg.removeListener('message', this.onMessage);
      dbg.removeListener('detach', this.onDetach);
      try {
        if (dbg.isAttached()) dbg.detach();
      } catch (error) {
        // the debugger may already be detached
        noteIgnored('detach the debugger from a browser tab', error);
      }
    }
    // what could not be let go of went with the page's CDP session
    forgetHeld(this);
    this.#detached();
    if (!this.backend.isDestroyed()) {
      try {
        this.backend.setBackgroundThrottling(true);
      } catch (error) {
        // the contents may be going away
        noteIgnored('turn background throttling back on for a browser tab', error);
      }
    }
    const was = this.held;
    this.held = false;
    if (was) this.host.emit?.(this.chatId);
  }

  #detached() {
    catalogOf(this)?.release(); // its page tools' listener and calls go with CDP (webmcp.cjs)
    this.listening = false;
    this.world = null;
    this.frames.clear();
    const emulated = this.emulated;
    this.emulated = null;
    this.fileChooser = null;
    // CDP going ends the emulation: the pane stops showing the device, and the page takes its fitted zoom again
    holdNativeScale(this.backend, false);
    if (emulated) this.host.emit?.(this.chatId);
  }

  /** Whether the tab's renderer is gone (it crashed, or was killed when it hung) while its contents stay. */
  rendererGone() {
    return rendererGone(this.backend);
  }

  /** Marks the tab as driven by an agent: no background throttling while it holds it. */
  hold() {
    if (this.held || this.backend.isDestroyed()) return;
    this.held = true;
    try {
      this.backend.setBackgroundThrottling(false);
    } catch (error) {
      // the contents may be going away
      noteIgnored('turn background throttling off for a browser tab', error);
    }
    this.host.emit?.(this.chatId);
  }

  send(method, params = {}, sessionId = '', onDispatch = /** @type {(() => void) | null} */ (null)) {
    return sendTabCommand(this, method, params, sessionId, onDispatch);
  }

  /** Takes up a frame's CDP session (its own process): its events reach the tab's buffers and refs. */
  #frame(sessionId, parent, frameId) {
    this.frames.set(sessionId, { sessionId, parent, frameId, world: null, ownerRef: null });
    const send = (m, params = {}) =>
      this.backend.debugger.sendCommand(m, params, sessionId).catch((error) => {
        // the frame may have gone before setup finished
        noteIgnored(`set up ${m} in a frame of a browser tab`, error);
      });
    void send('Page.enable');
    void send('Runtime.enable');
    void send('Network.enable');
    void send('Target.setAutoAttach', AUTO_ATTACH);
    void send('Runtime.runIfWaitingForDebugger');
  }

  #push(list, entry) {
    list.push(entry);
    if (list.length > BUFFER_MAX) list.shift();
  }

  #event(method, p, sessionId) {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const text = (p.args || [])
          .map((a) =>
            a.value !== undefined
              ? typeof a.value === 'string'
                ? a.value
                : JSON.stringify(a.value)
              : a.unserializableValue || a.description || a.type,
          )
          .join(' ');
        // the passkey watch's own reports to main (passkeys.cjs), not the page's
        if (text.startsWith(PASSKEY_SIGNAL)) break;
        const frame = p.stackTrace?.callFrames?.[0];
        const level =
          p.type === 'error' || p.type === 'assert' ? 'error' : p.type === 'warning' ? 'warning' : p.type === 'debug' ? 'debug' : 'log';
        this.#push(this.console, { at: Date.now(), level, text, source: frame ? `${frame.url}:${frame.lineNumber + 1}` : '' });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails || {};
        this.#push(this.console, {
          at: Date.now(),
          level: 'error',
          text: d.exception?.description || d.text || 'Uncaught exception',
          source: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : '',
        });
        break;
      }
      case 'Log.entryAdded': {
        const e = p.entry || {};
        this.#push(this.console, {
          at: Date.now(),
          level: e.level === 'warning' ? 'warning' : e.level === 'error' ? 'error' : e.level === 'verbose' ? 'debug' : 'log',
          text: e.text || '',
          source: e.url || e.source || '',
        });
        break;
      }
      case 'Network.requestWillBeSent': {
        const id = `${sessionId}:${p.requestId}`;
        if (!this.network.has(id)) {
          this.netOrder.push(id);
          if (this.netOrder.length > BUFFER_MAX) this.network.delete(this.netOrder.shift());
        }
        this.network.set(id, {
          id: p.requestId,
          sessionId,
          method: p.request?.method || 'GET',
          url: p.request?.url || '',
          type: p.type || '',
          started: Date.now(),
          status: null,
          mime: '',
          error: null,
          ms: null,
        });
        if (!/WebSocket|EventSource/.test(p.type || '')) this.inflight.add(id);
        this.lastNet = Date.now();
        break;
      }
      case 'Network.responseReceived': {
        const r = this.network.get(`${sessionId}:${p.requestId}`);
        if (r) {
          r.status = p.response?.status ?? null;
          r.mime = p.response?.mimeType || '';
        }
        this.lastNet = Date.now();
        break;
      }
      case 'Network.loadingFinished':
      case 'Network.loadingFailed': {
        const id = `${sessionId}:${p.requestId}`;
        const r = this.network.get(id);
        if (r) {
          r.ms = Date.now() - r.started;
          if (method === 'Network.loadingFailed') r.error = p.canceled ? 'canceled' : p.errorText || 'failed';
        }
        this.inflight.delete(id);
        this.lastNet = Date.now();
        break;
      }
      case 'Target.attachedToTarget': {
        const info = p.targetInfo || {};
        if (info.type !== 'iframe') {
          this.backend.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch((error) => {
            // the target may have gone; it is not ours to drive
            noteIgnored('resume a worker target of a browser tab', error);
          });
          break;
        }
        this.#frame(p.sessionId, sessionId, info.targetId);
        break;
      }
      case 'Target.detachedFromTarget':
        this.frames.delete(p.sessionId);
        break;
      case 'Runtime.executionContextsCleared':
        if (!sessionId) this.world = null;
        else if (this.frames.has(sessionId)) this.frames.get(sessionId).world = null;
        break;
      case 'Runtime.executionContextDestroyed':
        if (!sessionId && p.executionContextId === this.world) this.world = null;
        else if (this.frames.get(sessionId)?.world === p.executionContextId) this.frames.get(sessionId).world = null;
        break;
      case 'Page.frameNavigated':
        if (!sessionId && !p.frame?.parentId) {
          this.world = null;
          this.fileChooser = null;
        }
        break;
      case 'Page.javascriptDialogOpening':
        // the page's main-frame dialogs come through MoPilot (pageDialogs.cjs); a frame's own still arrive here. Electron
        // answers a beforeunload before this arrives (windows.cjs decides it on will-prevent-unload)
        if (sessionId || p.type === 'beforeunload') break;
        if (p.type === 'alert') {
          // nothing to decide: accept it and say so in the next result
          this.host.change(this.chatId, `${p.type} dialog on ${this.id} accepted${p.message ? `: "${oneLine(p.message, 300)}"` : ''}`);
          this.backend.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch((error) => {
            // the dialog may already be closed
            noteIgnored('accept a JavaScript dialog with nothing to decide', error);
          });
          break;
        }
        this.dialog = { type: p.type, message: p.message || '', defaultPrompt: p.defaultPrompt || '', url: p.url || '' };
        for (const w of this.dialogWaiters) w(this.dialog);
        this.dialogWaiters.clear();
        break;
      case 'Page.javascriptDialogClosed':
        if (!sessionId) this.dialog = null;
        break;
      case 'Page.fileChooserOpened':
        this.fileChooser = { mode: p.mode, backendNodeId: p.backendNodeId ?? null, frameSession: sessionId };
        for (const w of this.dialogWaiters) w(null);
        this.dialogWaiters.clear();
        break;
      default:
    }
  }

  /** The top frame's (or a frame's) agent world, created on first use and after each navigation. */
  async #world(sessionId) {
    const holder = sessionId ? this.frames.get(sessionId) : this;
    if (!holder) throw new ToolError('That frame is gone. Re-read the page.', 'stale_ref');
    if (holder.world) return holder.world;
    const { frameTree } = await this.send('Page.getFrameTree', {}, sessionId);
    const { executionContextId } = await this.send(
      'Page.createIsolatedWorld',
      { frameId: frameTree.frame.id, worldName: 'mopilot-agent', grantUniveralAccess: false },
      sessionId,
    );
    const r = await this.send(
      'Runtime.evaluate',
      { expression: `${PAGE_AGENT_SOURCE}, true`, contextId: executionContextId, returnByValue: true },
      sessionId,
    );
    if (r?.exceptionDetails)
      throw new ToolError(
        `Couldn't read this page: ${oneLine(r.exceptionDetails.exception?.description || r.exceptionDetails.text)}`,
        'failed',
      );
    holder.world = executionContextId;
    return executionContextId;
  }

  /** Runs a pageAgent op in a frame's world; retries once when the world went away under it. */
  async agent(op, args = {}, sessionId = '', onDispatch = /** @type {(() => void) | null} */ (null)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const contextId = await this.#world(sessionId);
      let r;
      try {
        r = await readThroughClosedRoots(this, op, contextId, sessionId, (again) =>
          this.send(
            'Runtime.evaluate',
            {
              expression: `globalThis.__mopilotAgent.call(${JSON.stringify(op)}, ${JSON.stringify(args)}, ${this.refSeq}${this.refHints.arg(args, sessionId)})`,
              contextId,
              returnByValue: true,
              awaitPromise: true,
            },
            sessionId,
            again ? null : onDispatch,
          ),
        );
      } catch (e) {
        if (/context|target closed|session/i.test(String(e?.message))) {
          this.#forgetWorld(sessionId);
          continue;
        }
        throw e;
      }
      if (r?.exceptionDetails) {
        const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'error';
        if (/__mopilotAgent/.test(msg) && attempt === 0) {
          this.#forgetWorld(sessionId);
          continue;
        }
        throw new ToolError(`The page script failed: ${oneLine(msg, 300)}`, 'failed');
      }
      const out = r?.result?.value || {};
      if (typeof out.seq === 'number' && out.seq > this.refSeq) this.refSeq = out.seq;
      this.refHints.note(out, sessionId);
      return out.value;
    }
    throw new ToolError('The page changed while reading it. Try again.', 'page_changed');
  }

  /**
   * The frame a frame element (named by its ref in `place`) shows: its own debugger session when it runs in its own
   * process, or else `place`'s session with the frame's id, a cross-origin frame of the same site that shares that
   * process. A place is { sessionId, frameId? }: a session's main frame, or a frame inside that session's process.
   * @param {{ sessionId: string, frameId?: string }} place
   * @param {string} ownerRef
   * @returns {Promise<{ sessionId: string, frameId?: string }>}
   */
  async childFrame(place, ownerRef) {
    const owner = await this.send(
      'Runtime.evaluate',
      { expression: `globalThis.__mopilotAgent.element(${JSON.stringify(ownerRef)})`, contextId: await this.#placeWorld(place) },
      place.sessionId,
    );
    const objectId = owner?.result?.objectId;
    if (!objectId) throw stale(ownerRef);
    const { node } = await this.send('DOM.describeNode', { objectId }, place.sessionId);
    void this.send('Runtime.releaseObject', { objectId }, place.sessionId).catch((error) =>
      // the frame may have gone; its objects went with it
      noteIgnored('let go of a frame element read for an action', error),
    );
    if (!node?.frameId) throw new ToolError("Couldn't find this frame on the page.", 'failed');
    // an out-of-process frame's target id is its frame id
    const own = [...this.frames.values()].find((f) => f.frameId === node.frameId);
    return own ? { sessionId: own.sessionId } : { sessionId: place.sessionId, frameId: node.frameId };
  }

  /** The execution context the page agent runs in for a place: the session's world, or an isolated world of a frame in its process. */
  async #placeWorld(/** @type {{ sessionId: string, frameId?: string }} */ place) {
    if (!place.frameId) return this.#world(place.sessionId);
    // Chrome keeps one world per name and frame, so this finds the same world each time; the agent installs once
    const { executionContextId } = await this.send(
      'Page.createIsolatedWorld',
      { frameId: place.frameId, worldName: 'mopilot-agent', grantUniveralAccess: false },
      place.sessionId,
    );
    return executionContextId;
  }

  /**
   * Runs a pageAgent op at a place (childFrame): a session's frame through agent(), or a frame in that session's
   * process in its own isolated world, installing the agent there when it is not yet.
   * @param {{ sessionId: string, frameId?: string }} place
   */
  async agentAt(place, op, args = {}) {
    if (!place.frameId) return this.agent(op, args, place.sessionId);
    const contextId = await this.#placeWorld(place);
    const r = await readThroughClosedRoots(this, op, contextId, place.sessionId, () =>
      this.send(
        'Runtime.evaluate',
        {
          expression: `${PAGE_AGENT_SOURCE}.call(${JSON.stringify(op)}, ${JSON.stringify(args)}, ${this.refSeq}${this.refHints.arg(args, placeKey(place))})`,
          contextId,
          returnByValue: true,
        },
        place.sessionId,
      ),
    );
    if (r?.exceptionDetails)
      throw new ToolError(
        `The page script failed: ${oneLine(r.exceptionDetails.exception?.description || r.exceptionDetails.text)}`,
        'failed',
      );
    const out = r?.result?.value || {};
    if (typeof out.seq === 'number' && out.seq > this.refSeq) this.refSeq = out.seq;
    this.refHints.note(out, placeKey(place));
    return out.value;
  }

  #forgetWorld(sessionId) {
    if (!sessionId) this.world = null;
    else if (this.frames.has(sessionId)) this.frames.get(sessionId).world = null;
  }

  /** Remembers which frame each ref in `lines` came from, so actions reach the right one. */
  noteRefs(lines, sessionId) {
    for (const line of lines)
      for (const m of line.matchAll(/\[(ref_\d+)\]/g)) {
        this.refFrame.delete(m[1]);
        this.refFrame.set(m[1], sessionId);
      }
    while (this.refFrame.size > 20000) this.refFrame.delete(this.refFrame.keys().next().value);
  }

  /** Remembers the frame one ref came from. */
  noteRef(ref, sessionId) {
    this.noteRefs([`[${ref}]`], sessionId);
  }

  frameOf(ref) {
    if (typeof ref !== 'string' || !this.refFrame.has(ref)) throw stale(ref);
    const sessionId = this.refFrame.get(ref);
    if (sessionId && !this.frames.has(sessionId)) throw stale(ref);
    return sessionId;
  }

  /** The ref, in its parent frame, of the iframe element that hosts a cross-origin frame. */
  async ownerRef(frame) {
    if (frame.ownerRef) return frame.ownerRef;
    const parentWorld = await this.#world(frame.parent);
    const { backendNodeId } = await this.send('DOM.getFrameOwner', { frameId: frame.frameId }, frame.parent);
    const { object } = await this.send('DOM.resolveNode', { backendNodeId, executionContextId: parentWorld }, frame.parent);
    const r = await this.send(
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: 'function (seq) { return globalThis.__mopilotAgent.refFor(this, seq); }',
        arguments: [{ value: this.refSeq }],
        returnByValue: true,
      },
      frame.parent,
    );
    const v = r?.result?.value;
    if (!v?.ref) throw new ToolError("Couldn't find this frame on the page.", 'failed');
    if (v.seq > this.refSeq) this.refSeq = v.seq;
    this.refFrame.set(v.ref, frame.parent);
    frame.ownerRef = v.ref;
    return v.ref;
  }
}

/** Which frame a ref was minted in, for a frame inside a session's process (the session's main frame is keyed by its session id). */
const placeKey = (/** @type {{ sessionId: string, frameId?: string }} */ place) => `${place.sessionId}#${place.frameId}`;

module.exports = { Tab };
