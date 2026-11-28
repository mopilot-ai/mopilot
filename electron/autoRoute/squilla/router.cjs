// SquillaRouter in Electron main: lazily loads OpenSquilla's local router, routes one turn, unloads when idle.
'use strict';

const path = require('node:path');
const { ignoring } = require('../../ignored.cjs');
const { candidateDirs, findAssetsDir, loadParams, loadUpstream, UPSTREAM } = require('./assets.cjs');
const { createEncoders } = require('./encoders.cjs');
const { createFeaturizer } = require('./features.cjs');
const { calibrate, parseLightGBM, predictProbabilities, softmax } = require('./lightgbm.cjs');
const { createPca, createScaler, createSvd } = require('./linear.cjs');
const { INTENTS, decide } = require('./policy.cjs');
const { createTfidf } = require('./tfidf.cjs');
const { createBertTokenizer } = require('./tokenizer.cjs');
const { SEGMENT_KINDS, extractTextSegments, segmentTexts } = require('./text.cjs');

const IDLE_MS = 10 * 60_000;
const TIMEOUT_MS = 200;

/**
 * Loads every model part from a verified asset directory.
 * @param {{ dir: string, ort: any, arch?: string, readUpstream?: typeof loadUpstream, readParams?: typeof loadParams }} o
 */
async function loadRuntime({ dir, ort, arch, readUpstream = loadUpstream, readParams = loadParams }) {
  const upstream = readUpstream(dir);
  const params = readParams();
  const tokenizer = createBertTokenizer(upstream.tokenizer);
  const encoders = await createEncoders({ ort, tokenizer, bgeModel: upstream.bgeModel, intentModel: upstream.intentModel, arch });
  const pca = createPca(params.pca);
  const featurizer = createFeaturizer({
    embed: encoders.embed,
    pca,
    tfidf: createTfidf(params.tfidf),
    svd: createSvd(params.svd),
    scaler: createScaler(params.scaler),
  });
  const tierModel = parseLightGBM(upstream.tierModel);
  const { tierTemperature, intentTemperature } = UPSTREAM.calibration;

  /**
   * The classifiers for one canonical RouterInput: the tier head on the current request alone, the intent head on all of it.
   * @param {any} input
   * @param {boolean} withIntent
   */
  async function predict(input, withIntent) {
    const features = await featurizer.tierFeatures({ current_request: input.current_request });
    const tierProbs = calibrate(predictProbabilities(tierModel, features), tierTemperature);
    if (!withIntent) return { intentProbs: null, tierProbs, features };
    const numeric = featurizer.intentNumeric(input, features);
    const prepared = encoders.intentInputs(segmentTexts(extractTextSegments(input)), SEGMENT_KINDS);
    const logits = await encoders.intentLogits(prepared, numeric);
    const probs = softmax(logits.map((l) => l / intentTemperature));
    return { intentProbs: Object.fromEntries(INTENTS.map((k, i) => [k, probs[i]])), tierProbs, features, prepared, numeric, logits };
  }

  return { predict, featurizer, encoders, tokenizer, tierModel, close: () => encoders.close() };
}

/**
 * @typedef {{
 *   currentRequest: string,
 *   historyUser?: string[],
 *   previousAnswer?: string,
 *   previousUsage?: Record<string, unknown>,
 *   routeHistory?: Array<{ tier: string, difficulty?: number | null, margin?: number | null }>,
 *   activeTier?: string | null,
 *   contextTokensEst?: number,
 *   explicitControl?: 'new_task' | 'redo' | null,
 * }} RouteInput
 */

/** RouteInput as OpenSquilla's canonical RouterInput, with history and route history capped as decide_model_tier does. */
function routerInput(o) {
  return {
    current_request: o.currentRequest,
    history_user: (o.historyUser ?? []).slice(-4),
    previous_answer: o.previousAnswer ?? '',
    previous_usage: o.previousUsage ?? {},
    route_history: (o.routeHistory ?? []).slice(-5),
    active_route_tier: o.activeTier ?? null,
    context:
      Number.isInteger(o.contextTokensEst) && /** @type {number} */ (o.contextTokensEst) >= 0
        ? { context_tokens_est: o.contextTokensEst }
        : {},
  };
}

/**
 * Where the weights are looked for: `assetsDir` alone when given; otherwise `resourcesPath` (default
 * process.resourcesPath), the checkout's build/vendor under `appRoot`, then `userData` (Electron's userData folder, when
 * the caller passes it), each with auto-route/squilla appended.
 * @param {{
 *   assetsDir?: string,
 *   resourcesPath?: string,
 *   appRoot?: string,
 *   userData?: string,
 *   loadOrt?: () => any,
 *   load?: typeof loadRuntime,
 *   findDir?: (dirs: string[]) => string | null,
 *   idleMs?: number,
 *   timeoutMs?: number,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 *   arch?: string,
 * }} [o]
 */
function createSquillaRouter(o = {}) {
  const {
    load = loadRuntime,
    findDir = findAssetsDir,
    idleMs = IDLE_MS,
    timeoutMs = TIMEOUT_MS,
    timers = { setTimeout, clearTimeout },
    loadOrt = () => require('onnxruntime-node'),
  } = o;
  /** @type {Promise<Awaited<ReturnType<typeof loadRuntime>>> | null} */
  let runtime = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idle = null;
  let closed = false;

  const dirs = () =>
    candidateDirs({
      assetsDir: o.assetsDir,
      resourcesPath: 'resourcesPath' in o ? o.resourcesPath : process.resourcesPath,
      appRoot: 'appRoot' in o ? o.appRoot : path.resolve(__dirname, '..', '..', '..'),
      userData: o.userData,
    });

  function ensure() {
    if (closed) return Promise.reject(new Error('SquillaRouter is closed'));
    if (!runtime) {
      const dir = findDir(dirs());
      const loading = dir
        ? Promise.resolve().then(() => load({ dir, ort: loadOrt(), arch: o.arch }))
        : Promise.reject(new Error('SquillaRouter assets are not installed'));
      runtime = loading;
      // a failed load is retried on the next turn rather than cached
      loading.catch(() => {
        if (runtime === loading) runtime = null;
      });
    }
    return runtime;
  }

  function scheduleUnload() {
    if (idle) timers.clearTimeout(idle);
    const handle = timers.setTimeout(() => {
      idle = null;
      release();
    }, idleMs);
    // an idle timer must not keep the process alive
    if (handle && typeof handle.unref === 'function') handle.unref();
    idle = handle;
  }

  /** Whether the router can run here: its weights are installed and ONNX Runtime loads. Never throws. */
  async function available() {
    if (closed || !findDir(dirs())) return false;
    try {
      loadOrt();
      return true;
    } catch {
      return false; // no ONNX Runtime build for this platform (macOS on Intel)
    }
  }

  /**
   * Routes one turn. Rejects on any failure or after timeoutMs, so the caller keeps its own selection; a slow first load
   * keeps going in the background for the next turn.
   * @param {RouteInput} input
   */
  async function route(input) {
    // no idle unload while a turn is using the sessions; the timer restarts when it settles
    if (idle) timers.clearTimeout(idle);
    idle = null;
    const canonical = routerInput(input);
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const work = ensure().then((r) =>
      decide({
        text: canonical.current_request,
        activeTier: canonical.active_route_tier,
        contextTokens: canonical.context.context_tokens_est ?? 0,
        explicitControl: input.explicitControl ?? null,
        predict: (withIntent) => r.predict(canonical, withIntent),
      }),
    );
    const timeout = new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(new Error(`SquillaRouter took longer than ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      timers.clearTimeout(timer);
      work.catch(ignoring('finish an Auto routing decision after its timeout'));
      if (!closed) scheduleUnload();
    }
  }

  /** Drops the loaded runtime and releases its sessions; a failed release leaves nothing to retry. */
  function release() {
    const current = runtime;
    runtime = null;
    if (current) current.then((r) => r.close()).catch(ignoring('release the Auto router sessions'));
  }

  function close() {
    closed = true;
    if (idle) timers.clearTimeout(idle);
    idle = null;
    release();
  }

  return { available, route, close };
}

module.exports = { IDLE_MS, TIMEOUT_MS, createSquillaRouter, loadRuntime, routerInput };
