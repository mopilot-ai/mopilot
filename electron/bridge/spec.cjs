// The window.native bridge's registry: the channel helpers each electron/bridge/<namespace>.cjs declares its calls with, and loading and building them.
const fs = require('node:fs');
const path = require('node:path');

/** The folder of per-namespace bridge declarations the preload exposes. */
const BRIDGE_DIR = __dirname;
/** window.native keys the preload writes itself (electron/preload.cjs), which no declaration may take. */
const RESERVED = new Set(['platform', 'mopilotService', 'flags']);

/**
 * @typedef {((...args: any[]) => any[]) | number} Params how many arguments a call forwards (padded with undefined,
 *   extra ones dropped, like a wrapper with that many parameters), or a function that maps them to the forwarded ones
 * @typedef {{ kind: 'invoke' | 'send', channel: string, params: Params, ownerChannel?: string }
 *   | { kind: 'call' | 'on', channel: string }
 *   | { kind: 'filePath' }} BridgeMethod
 * @typedef {{ [name: string]: BridgeMethod | BridgeSpec }} BridgeSpec
 */

/** ipcRenderer.invoke on `channel` (resolves the handler's result). @returns {BridgeMethod} */
const invoke = (channel, /** @type {Params} */ params = 0) => ({ kind: 'invoke', channel, params });
/** A preload-document lease, allocated synchronously before any asynchronous operation can escape it. @returns {BridgeMethod} */
const ownedInvoke = (channel, params, ownerChannel) => ({ kind: 'invoke', channel, params, ownerChannel });
/** ipcRenderer.send on `channel`, fire and forget. @returns {BridgeMethod} */
const send = (channel, /** @type {Params} */ params = 0) => ({ kind: 'send', channel, params });
/** An invoke whose handler returns {value} or {error} (main's handle()): resolves the value, or throws the error as it was. Forwards every argument. @returns {BridgeMethod} */
const call = (channel) => ({ kind: 'call', channel });
/** A subscription to `channel`: the callback gets the arguments without the event; returns the unsubscribe. @returns {BridgeMethod} */
const on = (channel) => ({ kind: 'on', channel });
/** webUtils.getPathForFile: a dropped File's path on disk. @returns {BridgeMethod} */
const filePath = () => ({ kind: 'filePath' });

/** @param {BridgeMethod | BridgeSpec} v @returns {v is BridgeMethod} */
const isMethod = (v) => !!v && typeof v === 'object' && typeof v.kind === 'string';

/**
 * Every bridge declaration in `dir`, keyed by namespace (the file's name), in file-name order.
 * @param {string} [dir]
 * @returns {Record<string, BridgeSpec>}
 */
function loadBridge(dir = BRIDGE_DIR) {
  /** @type {Record<string, BridgeSpec>} */
  const spec = {};
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.cjs') && f !== path.basename(__filename))
    .sort()) {
    const name = file.slice(0, -'.cjs'.length);
    if (RESERVED.has(name)) throw new Error(`bridge/${file}: window.native.${name} is written by the preload`);
    spec[name] = require(path.join(dir, file));
  }
  return spec;
}

/**
 * Every channel a declaration names, as `kind channel` at its dotted path.
 * @param {BridgeSpec} spec
 * @returns {{ path: string, kind: string, channel: string }[]}
 */
function channelsOf(spec, prefix = '') {
  /** @type {{ path: string, kind: string, channel: string }[]} */
  const out = [];
  for (const [name, v] of Object.entries(spec)) {
    const at = prefix ? `${prefix}.${name}` : name;
    if (!isMethod(v)) out.push(...channelsOf(v, at));
    else if (v.kind !== 'filePath') out.push({ path: at, kind: v.kind, channel: v.channel });
  }
  return out;
}

/** The one channel main sends a flush's stream events to a window on (electron/app/windows.cjs), several in one message. */
const STREAM_BATCH = 'stream:batch';

/** The window events that bracket one unpacked stream batch; the renderer holds its store writes between them (src/lib/streamFlush.ts). */
const STREAM_FLUSH_BEGIN = 'native:stream-flush-begin';
const STREAM_FLUSH_END = 'native:stream-flush-end';

const decoder = new TextDecoder();

/**
 * A stream batch's [channel, event] list (electron/app/streamBatch.cjs): its JSON bytes parsed here, at once, so nothing
 * that came after the batch is handled before its events, with each event main had no JSON for taken from `cloned`; or the
 * cloned list itself. Null for anything else.
 * @param {unknown} batch @param {unknown} [cloned]
 * @returns {[string, unknown][] | null}
 */
function streamItems(batch, cloned) {
  if (Array.isArray(batch)) return batch;
  // a view made in whichever realm the message was read into, which `instanceof` would refuse
  if (!ArrayBuffer.isView(batch) || !Array.isArray(cloned)) return null;
  let list;
  try {
    list = JSON.parse(decoder.decode(batch));
  } catch {
    // a batch that is not JSON is dropped, as one of the wrong shape always was
    return null;
  }
  return Array.isArray(list) ? list.map(([channel, event, at]) => [channel, at === undefined ? event : cloned[at]]) : null;
}

/**
 * Hand each [channel, event] of a stream batch to the listeners of that channel, in order, as if main had sent them one
 * by one: every `on(channel)` subscription stays as it was. The items are bracketed by two events on `target` (the
 * window), which the renderer uses to apply them as one commit; the end event also fires when a listener throws.
 * @param {{ on: Function, emit: Function }} ipcRenderer
 * @param {{ dispatchEvent: (e: any) => unknown } | null} [target]
 */
function unpackStreamBatches(ipcRenderer, target = null) {
  const signal = (/** @type {string} */ type) => target?.dispatchEvent(new Event(type));
  ipcRenderer.on(STREAM_BATCH, (_e, batch, cloned) => {
    const items = streamItems(batch, cloned);
    if (!items) return;
    signal(STREAM_FLUSH_BEGIN);
    /** @type {{ error: unknown } | null} */
    let failed = null;
    try {
      // one listener's failure must not drop the events behind it; the first failure is thrown once all were delivered
      for (const [channel, event] of items) {
        try {
          ipcRenderer.emit(channel, _e, event);
        } catch (error) {
          failed ??= { error };
        }
      }
    } finally {
      signal(STREAM_FLUSH_END);
    }
    if (failed) throw failed.error;
  });
}

/** The forwarded arguments of a call. */
const forward = (/** @type {Params} */ params, args) =>
  typeof params === 'function' ? params(...args) : Array.from({ length: params }, (_, i) => args[i]);

/**
 * The functions a declaration describes, over the renderer's ipcRenderer (and webUtils).
 * @param {BridgeSpec} spec
 * @param {{ ipcRenderer: any, webUtils: any }} electron
 * @returns {Record<string, any>}
 */
function buildApi(spec, electron) {
  const { ipcRenderer, webUtils } = electron;
  const owners = new Map();
  /** @param {BridgeMethod} m */
  const build = (m) => {
    switch (m.kind) {
      case 'invoke': {
        if (m.ownerChannel && !owners.has(m.ownerChannel)) owners.set(m.ownerChannel, ipcRenderer.sendSync(m.ownerChannel));
        const prefix = m.ownerChannel ? [owners.get(m.ownerChannel)] : [];
        return (...args) => ipcRenderer.invoke(m.channel, ...prefix, ...forward(m.params, args));
      }
      case 'send':
        return (...args) => ipcRenderer.send(m.channel, ...forward(m.params, args));
      case 'call':
        return (...args) =>
          ipcRenderer.invoke(m.channel, ...args).then((r) => {
            if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
            return r ? r.value : undefined;
          });
      case 'on':
        return (cb) => {
          const h = (_e, ...args) => cb(...args);
          ipcRenderer.on(m.channel, h);
          return () => ipcRenderer.removeListener(m.channel, h);
        };
      case 'filePath':
        return (f) => webUtils.getPathForFile(f);
      default:
        throw new Error(`unknown bridge method kind ${/** @type {any} */ (m).kind}`);
    }
  };
  /** @type {Record<string, any>} */
  const api = {};
  for (const [name, v] of Object.entries(spec)) api[name] = isMethod(v) ? build(v) : buildApi(v, electron);
  return api;
}

module.exports = {
  STREAM_BATCH,
  STREAM_FLUSH_BEGIN,
  STREAM_FLUSH_END,
  unpackStreamBatches,
  streamItems,
  BRIDGE_DIR,
  RESERVED,
  invoke,
  ownedInvoke,
  send,
  call,
  on,
  filePath,
  loadBridge,
  channelsOf,
  buildApi,
};
