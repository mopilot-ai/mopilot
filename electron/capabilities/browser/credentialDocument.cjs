// A credential request owns one observed document lifetime, checked again at each actual CDP dispatch.
const { AsyncLocalStorage } = require('node:async_hooks');
const { ToolError } = require('../contract/registry.cjs');
const { assertActionLive } = require('./hostUtil.cjs');
const { keyOf } = require('./pageKey.cjs');
const documents = new AsyncLocalStorage();
const changed = () => new ToolError('The approved page is no longer current.', 'credential_document_changed');
const RETIRES = new Set([
  'Page.frameStartedNavigating',
  'Page.frameStartedLoading',
  'Page.frameNavigated',
  'Page.navigatedWithinDocument',
  'Page.frameDetached',
  'Runtime.executionContextsCleared',
  'Runtime.executionContextDestroyed',
  'Target.detachedFromTarget',
]);

/** A scope never revives, even if the same URL, frame or execution-context id comes back. */
async function withCredentialDocument(wc, signal, fn, checkOwner = () => undefined) {
  const controller = new AbortController();
  /** @type {Error | null} */
  let reason = null;
  let retire;
  const retired = new Promise((resolve) => {
    retire = resolve;
  });
  const stop = (error = changed()) => {
    if (reason) return;
    reason = error;
    retire(error);
    controller.abort();
  };
  const moved = (event, _url, _inPlace, mainFrame) => {
    if (event?.isMainFrame ?? mainFrame) stop();
  };
  const message = (_event, method) => {
    // Retire the complete approved snapshot for any frame replacement: child session ids can be reused.
    if (RETIRES.has(method)) stop();
  };
  const gone = () => stop(new ToolError('The credential tab was closed.', 'tab_closed'));
  const lost = () => stop();
  const aborted = () => stop(new ToolError('The credential request was stopped.', 'aborted'));
  const listeners = [
    [wc, 'did-start-navigation', moved],
    [wc, 'destroyed', gone],
    [wc, 'render-process-gone', lost],
    [wc.debugger, 'message', message],
    [wc.debugger, 'detach', lost],
  ];
  for (const [emitter, event, listener] of listeners) emitter?.on(event, listener);
  signal?.addEventListener('abort', aborted, { once: true });
  const scope = {
    wc,
    check() {
      if (reason) throw reason;
      checkOwner();
    },
    wait(p) {
      return Promise.race([
        p,
        retired.then((error) => {
          throw error;
        }),
      ]);
    },
  };
  try {
    if (signal?.aborted) aborted();
    if (wc.isDestroyed?.()) gone();
    if (wc.isLoadingMainFrame?.()) lost();
    return await documents.run(scope, () => waitForCredentialDocument(wc, () => fn(controller.signal)));
  } finally {
    stop();
    for (const [emitter, event, listener] of listeners) emitter?.removeListener(event, listener);
    signal?.removeEventListener('abort', aborted);
  }
}

/** Called after attachment awaits, immediately before debugger/relay dispatch; normal calls keep action ownership. */
function assertBrowserDispatch(wc) {
  assertActionLive();
  const scope = documents.getStore();
  if (!scope) return;
  scope.check();
  if (keyOf(scope.wc) !== keyOf(wc)) throw changed();
}

/** Retired responses and rejections never reach page-world publication or retry/cache cleanup. */
async function waitForCredentialDocument(wc, send) {
  const scope = documents.getStore();
  if (!scope) return send();
  assertBrowserDispatch(wc);
  try {
    const out = await scope.wait(send());
    assertBrowserDispatch(wc);
    return out;
  } catch (error) {
    assertBrowserDispatch(wc);
    throw error;
  }
}

module.exports = { withCredentialDocument, assertBrowserDispatch, waitForCredentialDocument };
