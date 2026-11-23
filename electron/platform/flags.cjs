// Remote switches. Fetched from the MoPilot service's flags endpoint at startup and every 30 minutes, cached in
// userData/flags.json, built-in defaults when offline or in a build without the service. A `kill` flag is on when this build ships it on AND the server hasn't switched it off; a `toggle`
// flag (shared/flagDefs.mjs) follows the server's answer either way, where the server speaks the toggle schema.
const fs = require('node:fs');
const { writeAtomic } = require('./fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');

const { ACP_IDS, ACP_CATALOG } = require('../../shared/harnessCatalog.mjs');
const { FLAG_DEFS, flagDay, flagExpired } = require('../../shared/flagDefs.mjs');

/** What a build for this platform ships, from the one definition list (shared/flagDefs.mjs). */
function defaultsFor(platform, defs = FLAG_DEFS) {
  return Object.freeze(Object.fromEntries(defs.map((d) => [d.key, platform === 'win32' && d.win32 !== undefined ? d.win32 : d.default])));
}

/** What this build ships. */
const DEFAULTS = defaultsFor(process.platform);

/** Installed registry adapters have their own kill switches without changing native build defaults. */
function flagDefault(key, defaults = DEFAULTS) {
  if (Object.hasOwn(defaults, key)) return defaults[key];
  const id = /^harness\.acp\.([a-z0-9-]+)\.enabled$/.exec(key)?.[1];
  const descriptor = id ? ACP_CATALOG[id] : null;
  return descriptor?.registry ? descriptor.enabled : undefined;
}

/**
 * The /api/flags answer schema that may turn a `toggle` flag on: `{ schema: 2, flags: { key: bool } }`. A server
 * without it answers a flat map of every key (true unless killed), whose `true` means only "not killed".
 */
const SCHEMA = 2;

const REFRESH_MS = 30 * 60_000;
/** A cache older than this (a week without reaching the server) is dropped for the defaults. */
const MAX_AGE_MS = 7 * 24 * 3600_000;
const TIMEOUT_MS = 10_000;

const isMap = (raw) => !!raw && typeof raw === 'object' && !Array.isArray(raw);

/** The server's switches, keeping only known keys with boolean values. */
function sanitize(raw, defaults = DEFAULTS) {
  const out = {};
  if (!isMap(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (flagDefault(k, defaults) !== undefined && typeof v === 'boolean') out[k] = v;
  return out;
}

/**
 * The switches an answer (or a cache) holds. Only a schema-2 answer keeps a `true`; a flat legacy map keeps its kills,
 * so a server that predates toggles, which answers `true` for every key, never turns a toggle flag on.
 * @returns {Record<string, boolean> | null} null when it is not a switch map at all (corrupt)
 */
function remoteFrom(body, defaults = DEFAULTS) {
  if (!isMap(body)) return null;
  if (body.schema === SCHEMA) return isMap(body.flags) ? sanitize(body.flags, defaults) : null;
  return Object.fromEntries(Object.entries(sanitize(body, defaults)).filter(([, v]) => v === false));
}

/** The `@dev` preset: every `toggle` flag (a feature in development) not past its removal date, on. */
function devPreset(defs, today) {
  return Object.fromEntries(defs.filter((d) => d.mode === 'toggle' && !flagExpired(d, today)).map((d) => [d.key, true]));
}

/**
 * A local override for tests and development: JSON like {"harness.claude.enabled": false} or a list
 * like "harness.claude.enabled=0,shared.computerUse.unattended=1". In the list, `@dev` turns on every flag
 * in development (devPreset), and a key named beside it wins wherever it stands (`@dev,x=0` keeps x off).
 * Known keys only; an override wins over the build defaults and the server in both directions.
 * @param {unknown} raw
 * @param {{ now?: number, defs?: readonly any[] }} [o] the clock and definitions, for tests
 */
function parseOverride(raw, { now = Date.now(), defs = FLAG_DEFS } = {}) {
  const out = {};
  const text = String(raw ?? '').trim();
  if (!text) return out;
  /** @type {any} */
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    obj = {};
    let dev = false;
    for (const part of text.split(',')) {
      if (part.trim() === '@dev') dev = true;
      const [k, v] = part.split('=').map((x) => x.trim());
      if (k && v !== undefined) obj[k] = /^(1|true|on)$/i.test(v) ? true : /^(0|false|off)$/i.test(v) ? false : v;
    }
    if (dev) obj = { ...devPreset(defs, flagDay(now)), ...obj };
  }
  return sanitize(obj);
}

/** The override a launch gets: MOPILOT_FLAGS (with `@dev`) in an unpackaged build only, nothing in a packaged one. */
function localOverride(packaged, raw, o) {
  return packaged ? {} : parseOverride(raw, o);
}

class Flags {
  /**
   * @param {object} o
   * @param {string} o.file userData/flags.json
   * @param {string | null} o.url the flags endpoint, without a query; null keeps the built-in defaults (no MoPilot service)
   * @param {() => string} o.channel
   * @param {string} o.version the app version
   * @param {typeof fetch} [o.fetch]
   * @param {() => number} [o.now]
   * @param {(snap: Record<string, boolean>) => void} [o.onChange]
   * @param {Record<string, boolean>} [o.override] local override (parseOverride), for tests and development
   * @param {(key: string) => void} [o.onKill] a switch the server turned off took effect (telemetry)
   * @param {readonly any[]} [o.defs] the flag definitions, for tests
   * @param {string} [o.platform] for tests
   */
  constructor(o) {
    this.o = {
      fetch: globalThis.fetch,
      now: Date.now,
      onChange: () => {
        /* no listener */
      },
      onKill: () => {
        /* no telemetry listener */
      },
      override: {},
      ...o,
    };
    const defs = this.o.defs ?? FLAG_DEFS;
    const platform = this.o.platform ?? process.platform;
    this.defaults = defs === FLAG_DEFS && platform === process.platform ? DEFAULTS : defaultsFor(platform, defs);
    /** `toggle` flags the server may turn on; one a platform ships off (computer use on Windows) stays off there. */
    this.toggles = new Set(defs.filter((d) => d.mode === 'toggle' && !(platform === 'win32' && d.win32 === false)).map((d) => d.key));
    this.remote = {};
    this.fetchedAt = null;
    this.generation = 0;
    this.scope = null;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.load();
    this.published = this.snapshot();
  }

  /** The cached switches, unless they are too old or were fetched for another version or channel. */
  load() {
    this.scope = null;
    this.remote = {};
    this.fetchedAt = null;
    // no service to have fetched them from: a cache another build of the app left is not this one's
    if (!this.o.url) return;
    /** @type {any} the cache file's contents; undefined when there is none or it does not parse */
    let c;
    try {
      c = JSON.parse(fs.readFileSync(this.o.file, 'utf8'));
    } catch (error) {
      // no cache yet (ENOENT) or an unreadable one: start from the defaults and fetch
      noteIgnored('read the cached remote switches', error, ['ENOENT']);
    }
    const remote = isMap(c) && typeof c.fetchedAt === 'number' ? remoteFrom(c.schema === SCHEMA ? c : c.flags, this.defaults) : null;
    // a cache that parses but cannot be read as switches is corrupt: say so, and run as if there were none
    if (c !== undefined && !remote) noteIgnored('read the cached remote switches', new Error('the cached switches are not a switch map'));
    const fresh = remote && this.o.now() - c.fetchedAt < MAX_AGE_MS && c.fetchedAt <= this.o.now();
    if (fresh && c.version === this.o.version && c.channel === this.o.channel()) {
      this.scope = { channel: c.channel, version: c.version };
      this.remote = remote;
      this.fetchedAt = c.fetchedAt;
    }
  }

  isEnabled(key) {
    const shipped = flagDefault(key, this.defaults);
    if (shipped === undefined) return false;
    if (key in this.o.override) return this.o.override[key];
    if (!this.matchesScope(this.scope)) return shipped;
    if (this.fetchedAt !== null && this.o.now() - this.fetchedAt >= MAX_AGE_MS) return shipped;
    const remote = this.remote[key];
    // A kill always wins; only a declared toggle flag takes the server's true.
    if (remote === false) return false;
    return remote === true && this.toggles.has(key) ? true : shipped;
  }

  snapshot() {
    const out = {};
    for (const k of new Set([...Object.keys(this.defaults), ...ACP_IDS.map((id) => `harness.acp.${id}.enabled`)]))
      out[k] = this.isEnabled(k);
    return out;
  }

  /** Memory and delayed replies obey the same channel/version scope as the disk cache. */
  matchesScope(scope) {
    return !!scope && scope.channel === this.o.channel() && scope.version === this.o.version;
  }

  /** Publish scope changes even when the replacement fetch is offline or returns unchanged flags. */
  publish() {
    const snap = this.snapshot();
    if (JSON.stringify(snap) === JSON.stringify(this.published)) return;
    this.published = snap;
    this.o.onChange(snap);
  }

  /** Fetches the switches; on any failure keeps what it had. Returns whether it got an answer. */
  async refresh() {
    try {
      const generation = ++this.generation;
      const scope = { channel: this.o.channel(), version: this.o.version };
      const current = () => generation === this.generation && this.matchesScope(scope);
      this.publish();
      if (!this.o.url) return false;
      const q = new URLSearchParams({ ...scope, schema: String(SCHEMA) });
      const res = await this.o.fetch(`${this.o.url}?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!current() || !res.ok) return false;
      const flags = remoteFrom(await res.json(), this.defaults);
      // an answer from another channel or version, or one that settled after a newer refresh, is discarded unapplied
      if (!current()) return false;
      if (!flags) throw new Error('the switches are not a switch map');
      const before = this.snapshot();
      this.remote = flags;
      this.scope = scope;
      this.fetchedAt = this.o.now();
      saveCache(this.o.file, { fetchedAt: this.fetchedAt, ...scope, schema: SCHEMA, flags });
      this.reportKills(before);
      this.publish();
      return true;
    } catch (error) {
      // offline or an unreadable answer: the switches stay as they were and the next refresh asks again
      noteIgnored('fetch the remote switches', error);
      return false;
    }
  }

  /** Reports each switch that is off now because the server (or its cache) said so and was on in `before` (all on, when omitted). */
  reportKills(before) {
    for (const [key, on] of Object.entries(this.snapshot())) {
      if (on || !flagDefault(key, this.defaults) || key in this.o.override) continue;
      if (before && !before[key]) continue;
      try {
        this.o.onKill(key);
      } catch (error) {
        // a failing telemetry callback must not stop the kill switch from applying
        noteIgnored(`report the remote switch ${key}`, error);
      }
    }
  }

  start() {
    // a kill still held from the cache counts as applied for this run
    this.reportKills(null);
    // cannot reject: refresh records any failure and keeps the switches it had
    void this.refresh();
    clearInterval(/** @type {NodeJS.Timeout | undefined} */ (this.timer));
    if (!this.o.url) return;
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop() {
    this.generation++;
    // clearInterval ignores null
    clearInterval(/** @type {NodeJS.Timeout | undefined} */ (this.timer));
    this.timer = null;
  }
}

function saveCache(file, data) {
  try {
    writeAtomic(file, JSON.stringify(data, null, 2));
  } catch (error) {
    // the cache only speeds up the next launch; the switches are fetched again
    noteIgnored('cache the remote switches', error);
  }
}

// The app's one instance, so any main-process module can ask isEnabled(key).
/** @type {Flags | null} */
let current = null;

/** Creates and starts the app's flags. */
function initFlags(o) {
  current?.stop();
  const flags = new Flags(o);
  current = flags;
  flags.start();
  return flags;
}

/** Whether a feature may run: the built-in default until initFlags, then with the remote kills applied. */
function isEnabled(key) {
  return current ? current.isEnabled(key) : flagDefault(key) === true;
}

/** Refresh after a channel change, including before flags have been initialized at startup. */
async function refreshFlags() {
  return current ? current.refresh() : false;
}

/** flags:getSync, for the preload's synchronous isEnabled (it hears flags:changed for later changes). */
function registerFlags(ipcMain, flags) {
  ipcMain.on('flags:getSync', (e) => {
    e.returnValue = flags.snapshot();
  });
}

module.exports = {
  Flags,
  initFlags,
  isEnabled,
  refreshFlags,
  registerFlags,
  DEFAULTS,
  defaultsFor,
  devPreset,
  localOverride,
  sanitize,
  remoteFrom,
  parseOverride,
  SCHEMA,
  REFRESH_MS,
  MAX_AGE_MS,
};
