// One built-in browser page's road to macOS's passkey sheet. The page's navigator.credentials wrapper (passkeys.cjs)
// calls a CDP binding on the page's own session; main takes the caller's origin and frame from CDP (never from what
// the page says), serves the request only from a frame whose every ancestor shares that origin and whose policy
// allows WebAuthn, and answers by request id in that origin's frames only, so a new document or another site's
// frame never receives it. Anything it doesn't serve is answered `fallback`: the wrapper calls Electron's own path.
const { noteIgnored } = require('../../ignored.cjs');
const { nativeRequest } = require('./passkeyRequest.cjs');
const { pageAnswer, NOT_ALLOWED } = require('./passkeyResult.cjs');
const { systemPasskeys } = require('./systemPasskeys.cjs');

const MAX_PAYLOAD = 256 * 1024;
const ID = /^[0-9a-z]{8,40}$/;

/**
 * The frames from the root to `frameId` in a CDP frame tree, or null when it isn't there.
 * @param {any} node
 * @param {string} frameId
 * @returns {any[] | null}
 */
function framePath(node, frameId) {
  if (!node?.frame) return null;
  if (node.frame.id === frameId) return [node.frame];
  for (const child of node.childFrames ?? []) {
    const below = framePath(child, frameId);
    if (below) return [node.frame, ...below];
  }
  return null;
}

/**
 * @typedef {{ id: string, origin: string, context: number, answered: boolean, run: { cancel(): void } | null }} PasskeyCall
 * @param {any} wc the page's webContents
 * @param {{ key: string, binding: string, onChange: () => void, system?: ReturnType<typeof systemPasskeys> }} o
 *   `key`: the wrapper's global (passkeys.cjs); `binding`: the CDP binding's name
 */
function createPasskeyBridge(wc, { key, binding, onChange, system = systemPasskeys() }) {
  /** the page session's execution contexts: where a binding call came from */
  /** @type {Map<number, { frameId: string, origin: string, isDefault: boolean }>} */
  const contexts = new Map();
  /** @type {Map<string, PasskeyCall>} */
  const calls = new Map();
  const command = (/** @type {string} */ method, params = {}) => wc.debugger.sendCommand(method, params);

  /** Says `message` about a call in the frames of its origin (`null`: every frame); the wrapper holding its id takes it. */
  const post = (/** @type {string} */ id, /** @type {Record<string, unknown>} */ message, /** @type {string | null} */ frames) => {
    if (wc.isDestroyed()) return;
    const source = `globalThis[${JSON.stringify(key)}]?.('settle', ${JSON.stringify(id)}, ${JSON.stringify(message)})`;
    for (const frame of wc.mainFrame?.framesInSubtree ?? [])
      if (frames === null || frame.origin === frames)
        frame.executeJavaScript(source).catch((error) => {
          // the frame went away, and the request with it
          noteIgnored('answer a passkey request in a browser page', error);
        });
  };

  /** Answers a call once. */
  const answer = (
    /** @type {PasskeyCall} */ call,
    /** @type {Record<string, unknown>} */ message,
    /** @type {string | null} */ frames = call.origin,
  ) => {
    if (call.answered) return;
    call.answered = true;
    calls.delete(call.id);
    if (call.run) onChange();
    post(call.id, message, frames);
  };

  /** Ends the calls whose document went: the sheet closes and their answers find no wrapper. */
  const dropContext = (/** @type {number | null} */ context) => {
    for (const call of [...calls.values()]) if (context === null || call.context === context) call.run?.cancel();
  };

  /** Whether the calling frame may use WebAuthn: every ancestor its own origin, and its policy not denying it. */
  const servable = async (ctx, kind) => {
    const tree = await command('Page.getFrameTree');
    const path = framePath(tree?.frameTree, ctx.frameId);
    if (!path || path.some((f) => f.securityOrigin !== ctx.origin)) return false;
    const feature = kind === 'create' ? 'publickey-credentials-create' : 'publickey-credentials-get';
    const policy = await command('Page.getPermissionsPolicyState', { frameId: ctx.frameId });
    // both default to 'self', which a same-origin chain satisfies, unless the page's own policy says otherwise
    const state = policy?.states?.find((s) => s.feature === feature);
    return !state || state.allowed === true;
  };

  async function request(context, ctx, msg) {
    if (calls.has(msg.id)) return;
    /** @type {PasskeyCall} */
    const call = { id: msg.id, origin: ctx.origin, context, answered: false, run: null };
    calls.set(call.id, call);
    const fallback = () => answer(call, { fallback: true });
    const caps = system.caps();
    if (!caps || !ctx.isDefault) return fallback();
    let ok = false;
    try {
      ok = await servable(ctx, msg.kind);
    } catch (error) {
      noteIgnored('read the frames of a page asking for a passkey', error);
    }
    // the document went, or a turn let go of the debugger, while main looked: Electron's own path
    if (!ok || !contexts.has(context)) return fallback();
    const built = nativeRequest({ kind: msg.kind, options: msg.options, origin: ctx.origin, caps });
    if (!built) return fallback();
    const win = system.anchor(wc);
    // a page that isn't showing doesn't raise a sheet over another one (Chromium refuses unfocused documents too)
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return answer(call, { error: NOT_ALLOWED });
    const run = system.run(built.native, win.getNativeWindowHandle(), built.timeout);
    if (!('answer' in run)) return answer(call, { error: NOT_ALLOWED });
    call.run = run;
    onChange();
    // the sheet is up: the wrapper waits for the user now, not for main
    post(call.id, { ack: true }, call.origin);
    const result = await run.answer;
    answer(call, pageAnswer(result, built.expect));
  }

  /** A binding call: a request, or the abort of one this origin made. */
  async function onCall(context, payload) {
    if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD) return;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (!msg || typeof msg.id !== 'string' || !ID.test(msg.id)) return;
    let ctx = contexts.get(context);
    if (!ctx) {
      // another client turned Runtime off; turning it on again reports every context
      await command('Runtime.enable').catch((error) => noteIgnored('list the contexts of a browser page', error));
      ctx = contexts.get(context);
    }
    if (msg.type === 'abort') {
      const call = calls.get(msg.id);
      if (call && ctx && call.origin === ctx.origin) call.run?.cancel();
      return;
    }
    if (msg.type !== 'request') return;
    // nowhere to say who asked: a fallback tells no secret, so it may go to every frame
    if (!ctx) return answer({ id: msg.id, origin: '', context, answered: false, run: null }, { fallback: true }, null);
    await request(context, ctx, msg);
  }

  wc.debugger.on('message', (_e, method, params, sessionId) => {
    if (sessionId) return;
    if (method === 'Runtime.executionContextCreated') {
      const c = params?.context;
      if (c && typeof c.id === 'number')
        contexts.set(c.id, {
          frameId: String(c.auxData?.frameId ?? ''),
          origin: String(c.origin ?? ''),
          isDefault: c.auxData?.isDefault === true,
        });
    } else if (method === 'Runtime.executionContextDestroyed') {
      contexts.delete(params?.executionContextId);
      dropContext(params?.executionContextId);
    } else if (method === 'Runtime.executionContextsCleared') {
      contexts.clear();
      dropContext(null);
    } else if (method === 'Runtime.bindingCalled' && params?.name === binding)
      onCall(params.executionContextId, params.payload).catch((error) => noteIgnored('serve a passkey request', error));
  });
  // a turn let go of the debugger: the next arm reports the contexts again; requests go on (answers don't need CDP)
  wc.debugger.on('detach', () => contexts.clear());
  wc.on('render-process-gone', () => dropContext(null));
  wc.once('destroyed', () => dropContext(null));

  return {
    /**
     * Sets up the binding on the page's own session (documentScripts.cjs runs it at every arm). Not Runtime.enable:
     * bot checks look for it, and the bridge turns it on only once a page asks for a passkey (onCall).
     */
    arm(send) {
      if (!system.caps()) return;
      void send('Runtime.addBinding', { name: binding });
    },
    /** Whether macOS's sheet is up for this page. */
    active: () => [...calls.values()].some((c) => c.run),
    /** What the pane may say and offer: whether this page gets macOS's sheet, and passkeys an earlier build made. */
    offers: () => {
      const offered = !!system.caps();
      return { systemPasskeys: offered, legacyPasskeys: offered && system.legacy() };
    },
    /**
     * Closes the page's sheet. `legacy`: the page asks Electron's own Touch ID authenticator instead, for a passkey an
     * earlier build made. Resolves to how many it ended.
     */
    cancel({ legacy = false } = {}) {
      let n = 0;
      for (const call of [...calls.values()]) {
        if (!call.run) continue;
        n++;
        const run = call.run;
        if (legacy) answer(call, { fallback: true });
        run.cancel();
      }
      return n;
    },
  };
}

module.exports = { createPasskeyBridge, framePath };
