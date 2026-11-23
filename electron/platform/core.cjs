// The Rust core (core/crates/node, docs/architecture/rust-core.md) loaded as a Node addon, and its routes called with a JSON
// reply. The app does not start without it (`coreProblem`, electron/boot.cjs), and nothing falls back without it: a call
// with no core, or one that fails, throws.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncResource } = require('node:async_hooks');
const { messageOf, noteIgnored } = require('../ignored.cjs');
const { HOST_CORE_ADDON, HOST_CORE_DIR, HOST_CORE_RECORD } = require('../../shared/host/coreBuild.mjs');

/** The addon's file name as Cargo builds it, per platform. */
const BUILT = { darwin: 'libmopilot_core.dylib', linux: 'libmopilot_core.so', win32: 'mopilot_core.dll' };

/** The folder this code runs from: the app's, a checkout's or an unpacked Host version's. */
const ROOT = path.join(__dirname, '..', '..');

/** Whether this is a packaged app: its own code sits in app.asar, which the release fuses hold to the build's hash. */
const inPackagedApp = (dir = __dirname) => dir.split(/[\\/]/).includes('app.asar');

/** Where an unpacked Host version keeps its addon. @param {string} root */
const hostAddon = (root) => path.join(root, HOST_CORE_DIR, HOST_CORE_ADDON);

/**
 * What an unpacked Host version says of its addon (electron/host/bundle.cjs), or null for a version without one.
 * @param {string} [root] @param {(f: string) => string} [read]
 * @returns {{ build: string, sha256: string } | null}
 */
function hostCoreRecord(root = ROOT, read = (f) => fs.readFileSync(f, 'utf8')) {
  try {
    const record = JSON.parse(read(path.join(root, HOST_CORE_DIR, HOST_CORE_RECORD)));
    return typeof record.sha256 === 'string' ? record : null;
  } catch {
    // none recorded
    return null;
  }
}

/**
 * Where the addon is: MOPILOT_CORE when set; else the one a packaged app ships in its Resources/core (scripts/build-core.mjs);
 * else the one an unpacked Host version carries (electron/host/bundle.cjs); else the core's release build in this checkout,
 * as a developer runs it. A packaged app loads only its own copy: an environment variable or a checkout's build would put
 * code the release did not sign into the signed app, and the app does not run without the core.
 * So does a Host with an addon: what it runs came under a manifest its app signed, and the path is decided before the
 * variable is read. `root` holding a Host's addon cannot make a packaged app take it: that case returned first.
 * @param {{ env?: Record<string, string | undefined>, platform?: string, root?: string, resources?: string, exists?: (f: string) => boolean, packaged?: boolean }} [o]
 */
function corePath({
  env = process.env,
  platform = process.platform,
  root = ROOT,
  resources = process.resourcesPath ?? '',
  exists = fs.existsSync,
  packaged = inPackagedApp(),
} = {}) {
  const shipped = path.join(resources, 'core', 'mopilot_core.node');
  if (packaged) return resources && exists(shipped) ? shipped : null;
  const hosted = hostAddon(root);
  if (exists(hosted)) return hosted;
  if (env.MOPILOT_CORE) return env.MOPILOT_CORE;
  if (resources && exists(shipped)) return shipped;
  return checkoutCore(root, platform);
}

/**
 * The addon, as core/crates/node exports it: a library without all of these is not the core (`loadCore`).
 * @typedef {{ dispatch: (route: string, payload: Buffer) => Promise<Buffer>, dispatchSync: (route: string, payload: Buffer) => Buffer, dispatchCancellable: (route: string, payload: Buffer) => { id: number, reply: Promise<Buffer> }, cancel: (id: number) => boolean, subscribe: (listener: (event: Buffer) => void) => void, routes: () => string[] }} CoreAddon
 */

/** What the addon exports: its JS and its build come from one checkout, so a library missing one is a stale build. */
const EXPORTS = ['dispatch', 'dispatchCancellable', 'cancel', 'dispatchSync', 'subscribe', 'routes'];

/** The core's release build in the checkout at `root`, or null on a platform it has none for. @param {string} [root] @param {string} [platform] */
const checkoutCore = (root = ROOT, platform = /** @type {string} */ (process.platform)) => {
  const built = BUILT[/** @type {keyof typeof BUILT} */ (platform)];
  return built ? path.join(root, 'core', 'target', 'release', built) : null;
};

/** A file's SHA-256, hex. */
const sha256Of = (/** @type {string} */ file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * The addon's hash recorded with a packaged Windows app (scripts/package.mjs writes core-hash.json beside this file, in
 * app.asar): Windows checks no signature when a library loads, so the loader checks this (docs/architecture/rust-core.md
 * §8); null when there is none (macOS, where library validation is the check, and a developer's checkout).
 * @param {(f: string) => string} [read]
 */
function recordedHash(read = (f) => fs.readFileSync(f, 'utf8')) {
  try {
    const hash = JSON.parse(read(path.join(__dirname, 'core-hash.json'))).sha256;
    return typeof hash === 'string' ? hash : null;
  } catch {
    // none recorded
    return null;
  }
}

/**
 * The addon at `file`, or null when there is none, it does not load, or its hash is not `expected` (noted once). A load
 * that `required` a hash refuses a file when none was recorded.
 * @param {string | null} file
 * @param {{ exists?: (f: string) => boolean, dlopen?: (m: { exports: any }, f: string) => void, expected?: string | null,
 *           required?: boolean, hashOf?: (f: string) => string }} [o]
 * @returns {CoreAddon | null}
 */
function loadCore(
  file,
  { exists = fs.existsSync, dlopen = (m, f) => process.dlopen(m, f), expected = null, required = false, hashOf = sha256Of } = {},
) {
  if (!file || !exists(file)) return null;
  try {
    if (expected || required) {
      const actual = hashOf(file);
      if (actual !== expected) throw new Error(`its hash ${actual} is not the one the app was packaged with (${expected})`);
    }
    const m = { exports: /** @type {any} */ ({}) };
    dlopen(m, file);
    const missing = EXPORTS.filter((name) => typeof m.exports[name] !== 'function');
    if (missing.length) throw new Error(`it has no ${missing.join(', ')}`);
    return m.exports;
  } catch (error) {
    loadFailure = messageOf(error);
    noteIgnored('load the Rust core', error);
    return null;
  }
}

/** @type {CoreAddon | null | undefined} */
let loaded;
/** Why the last load failed, for `coreProblem`. @type {string | null} */
let loadFailure = null;

/**
 * How `file` is checked before it loads. A Host's own addon requires the hash its version records, which the signed
 * manifest covers; a packaged Windows app requires the hash it was packaged with; another package checks a recorded hash
 * when there is one.
 * @param {string | null} file
 * @param {{ root?: string, platform?: string, packaged?: boolean, record?: ReturnType<typeof hostCoreRecord>, hash?: string | null }} [o]
 */
function coreCheck(
  file,
  { root = ROOT, platform = process.platform, packaged = inPackagedApp(), record = hostCoreRecord(root), hash = recordedHash() } = {},
) {
  if (!packaged && file === hostAddon(root)) return { expected: record?.sha256 ?? null, required: true };
  // a record outside a package is a failed packaging run's leftover, and says nothing of a checkout's own build
  return { expected: packaged ? hash : null, required: platform === 'win32' && packaged };
}

/** The process's core, loaded on first use and checked by `coreCheck`. */
const core = () => {
  if (loaded === undefined) {
    const file = corePath();
    loaded = loadCore(file, coreCheck(file));
  }
  return loaded;
};

/**
 * Whether this process has the core, loading it if nothing has yet: the performance probe writes it on each sample, and
 * a process that has one loads it for its own first use anyway.
 */
const coreLoaded = () => core() !== null;

/**
 * Why this process cannot run, or null: the core did not load. Every process needs it: no domain it owns has a JS copy
 * (docs/architecture/rust-core.md §3).
 * @param {{ addon?: CoreAddon | null, file?: string | null, failure?: string | null }} [o]
 */
function coreProblem({ addon = core(), file = corePath(), failure = loadFailure } = {}) {
  if (addon) return null;
  if (failure) return `The Rust core at ${file} did not load: ${failure}`;
  return file ? `The Rust core is missing: there is no file at ${file}.` : 'The Rust core is missing.';
}

/**
 * `addon`, or the error a process without the core fails with, `coreProblem`'s: no caller has another way to do the work.
 * @param {CoreAddon | null | undefined} addon
 * @returns {CoreAddon}
 */
function requiredCore(addon) {
  if (addon) return addon;
  throw new Error(coreProblem() ?? 'The Rust core is missing.');
}

/**
 * The parsed JSON reply of `route` given `payload`. It rejects without a core, and with the route's error when the call
 * fails: a caller that degrades for a reason of its own (a process gone meanwhile) catches that, and says so.
 * @param {string} route @param {CoreAddon | null} [addon] @param {string} [payload]
 */
async function coreCall(route, addon = core(), payload = '') {
  return JSON.parse(String(await requiredCore(addon).dispatch(route, Buffer.from(payload))));
}

/** The listeners on an addon's stream: it has one listener per environment, shared here. @type {WeakMap<CoreAddon, Set<(event: Buffer) => void>>} */
const streamListeners = new WeakMap();

/**
 * What the core's events run in. A threadsafe function's messages run in the async context of whatever first made it,
 * which would hand a listener the context of the environment's first call (a turn's action guard, say).
 */
const streamContext = new AsyncResource('MoPilotCoreStream');

/**
 * `addon`'s listeners, subscribing the first time. A listener that throws is noted and costs the others nothing.
 * @param {CoreAddon} addon
 */
function streamOf(addon) {
  let listeners = streamListeners.get(addon);
  if (!listeners) {
    const all = (listeners = new Set());
    addon.subscribe((/** @type {Buffer} */ event) => {
      streamContext.runInAsyncScope(() => {
        for (const listener of [...all]) {
          try {
            listener(event);
          } catch (error) {
            noteIgnored("handle the Rust core's event", error);
          }
        }
      });
    });
    streamListeners.set(addon, all);
  }
  return listeners;
}

/**
 * Hear what the core's routes emit. Without a core it throws; a subscription that fails is noted, and the next listener
 * tries again. A call's reply comes behind its events (docs/architecture/rust-core.md §4), so by the time `coreCall`
 * resolves every listener has had them, and a handler under `orderedReplies` answers after its deltas.
 * @param {(event: Buffer) => void} listener @param {CoreAddon | null} [addon]
 * @returns {() => void} stops listening
 */
function coreEvents(listener, addon = core()) {
  const present = requiredCore(addon);
  try {
    const listeners = streamOf(present);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  } catch (error) {
    // the next listener tries again
    noteIgnored("subscribe to the Rust core's stream", error);
    return () => undefined;
  }
}

/**
 * The parsed JSON reply of synchronous `route` given `payload`, null for an empty one. It throws without a core, and
 * with the route's error when the call fails.
 * @param {CoreAddon | null | undefined} addon @param {string} route @param {unknown} payload sent as JSON
 */
function coreSyncCall(addon, route, payload) {
  const reply = String(requiredCore(addon).dispatchSync(route, Buffer.from(JSON.stringify(payload))));
  return reply ? JSON.parse(reply) : null;
}

module.exports = {
  coreEvents,
  checkoutCore,
  corePath,
  loadCore,
  core,
  coreCheck,
  coreLoaded,
  coreProblem,
  coreCall,
  coreSyncCall,
  requiredCore,
  recordedHash,
  hostCoreRecord,
  inPackagedApp,
  sha256Of,
};
