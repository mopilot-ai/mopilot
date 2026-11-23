// The worker thread that reads a Claude chat's turns off the main thread (electron/platform/claudeTurnsWorker.cjs): it loads the
// Agent SDK itself, keeps the messages it read by transcript (claudeTranscriptRead.cjs) and answers each request with the page.
const { parentPort, workerData } = require('node:worker_threads');
const { createTranscriptReader, createReadCache } = require('./claudeTranscriptRead.cjs');

/** The worker's ignored failures go to its console; the app's ring of them (electron/ignored.cjs) lives in main. */
const noteIgnored = (what, error) => console.debug(`[ignored] ${what}:`, error);
/** The addon's folder is known to main's `process` alone, and the core is how the turns are built. @param {any} data @param {any} own */
function resourcesFrom(data, own) {
  if (data?.resourcesPath) own.resourcesPath ??= data.resourcesPath;
}
resourcesFrom(workerData, process);
const { readTurnPage } = createTranscriptReader({ noteIgnored });

/**
 * Answers `{ id, req }` messages on `port` with `{ id, ok, page }` or `{ id, ok: false, error }` (an Error), one at a time.
 * @param {{ on: Function, postMessage: Function }} port
 * @param {() => Promise<{ getSessionMessages: Function }>} loadSdk
 */
function serve(port, loadSdk) {
  const cache = createReadCache();
  /** @type {Map<string, Promise<unknown>>} each session's newest request, so its reads run in turn */
  const tails = new Map();
  port.on('message', (m) => {
    // two reads of one transcript would parse it twice before the first could be kept; other sessions do not wait for it
    const key = String(m.req?.sessionId);
    const run = (tails.get(key) ?? Promise.resolve()).then(async () => {
      try {
        port.postMessage({ id: m.id, ok: true, page: await readTurnPage({ sdk: await loadSdk(), cache }, m.req) });
      } catch (error) {
        // an Error crosses with its message and stack; its code (the SDK sets one) is sent beside it
        port.postMessage({ id: m.id, ok: false, error: error instanceof Error ? error : new Error(String(error)), code: error?.code });
      }
      if (tails.get(key) === run) tails.delete(key);
    });
    tails.set(key, run);
  });
}

/** Serves on the worker's port (none when this file is loaded as a plain module), loading the SDK on the first request. */
function boot(port, loadSdk = () => import('@anthropic-ai/claude-agent-sdk')) {
  if (port) serve(port, loadSdk);
}

boot(parentPort);

module.exports = { serve, boot, resourcesFrom };
