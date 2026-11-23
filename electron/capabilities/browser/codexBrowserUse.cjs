// Codex Browser Use settings (BU-06): how Codex's Browser plugin (the ChatGPT extension in the user's Chrome)
// asks before it uses a site, and the sites it may or may not use.
//
// The plugin keeps these in $CODEX_HOME/browser/config.toml, and the ChatGPT app's browser settings read and
// write the same file (its BrowserUseOriginState: approval_mode, history_approval_mode, download_approval_mode,
// upload_approval_mode, full_cdp_access_enabled, and the [origins] / [downloads] / [uploads] / [full_cdp]
// tables of `allowed` and `denied` origins; "Always allow" on a Browser Use card adds to [origins].allowed).
// The app syncs a changed file to the account itself, so editing the file is the supported local path.
//
// Managed values are never written: Codex's requirements (configRequirements/read: allowBrowserAndComputerUse,
// browserUse.allowGlobalPersistentApproval / allowHistoryAccess / origins / defaultOriginPolicy, and
// featureRequirements.browser_use_full_cdp_access) and the browser_use table of config.toml (config/read) are
// shown read only, and a write that a lock forbids is refused.
//
// The same blocks apply to MoPilot's own browser tools in every chat, whatever its harness (#1319 G13):
// browseBlock() says why Codex Browser Use refuses a site (browser use turned off, a managed or config.toml origin
// policy that denies access, a site the user blocked in Codex) and where that is set, and codexSiteBlocks.cjs keeps
// the rules and policy it reads, so origins.cjs refuses the site like a blocked one.
const { ownTable } = require('../../../shared/ownTable.mjs');
const { fs: nodeFs } = require('../../platform/ports/fs.cjs');
const { writeAtomic } = require('../../platform/fsutil.cjs');
const { siteOrigin: normalizeOrigin } = require('../../../shared/siteOrigin.mjs');
const path = require('node:path');
const { parse, stringify } = require('smol-toml');

const CONFIG_FILE = path.join('browser', 'config.toml');
const ASK = 'always_ask';
const NEVER = 'never_ask';
const DISABLED = 'disabled';

/** A site permission and the table that holds its allowed and denied origins. */
const TABLES = ownTable({ browse: 'origins', downloads: 'downloads', uploads: 'uploads', debug: 'full_cdp' });
const RESOURCES = Object.keys(TABLES);
/** The same permission in a requirements origin policy (camelCase) and in config.toml's browser_use (snake_case). */
const POLICY_FIELDS = {
  browse: ['access', 'access'],
  downloads: ['downloads', 'downloads'],
  uploads: ['uploads', 'uploads'],
  debug: ['fullCdpAccess', 'full_cdp_access'],
};

/** The preferences the settings show: their key in the file, their values, and the value when unset. */
const PREFS = ownTable({
  approvalMode: { key: 'approval_mode', values: [ASK, NEVER], unset: ASK },
  historyMode: { key: 'history_approval_mode', values: [ASK, NEVER, DISABLED], unset: ASK },
  downloadMode: { key: 'download_approval_mode', values: [ASK, NEVER], unset: ASK },
  uploadMode: { key: 'upload_approval_mode', values: [ASK, NEVER], unset: ASK },
  fullCdp: { key: 'full_cdp_access_enabled', values: [true, false], unset: false },
});

const isTable = (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

const coded = (code, message) => Object.assign(new Error(message), { code });

/** The trimmed, distinct strings of a list (the app's reading of `allowed` and `denied`). */
function listOf(table, kind) {
  if (!isTable(table) || !Array.isArray(table[kind])) return [];
  const out = [];
  for (const v of table[kind]) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The value a preference has in the file, or its default when the file has none it knows. */
function prefValue(data, name) {
  const p = PREFS[name];
  const v = data[p.key];
  if (name === 'fullCdp') return v === true;
  return p.values.includes(v) ? v : p.unset;
}

/**
 * What managed policy fixes. `requirements`: configRequirements/read's `requirements` (null: none, undefined:
 * unknown). `config`: config/read's `config`.
 */
function locksOf(requirements, config) {
  const r = requirements ?? {};
  const bu = r.browserUse ?? {};
  const own = isTable(config?.browser_use) ? config.browser_use : {};
  /** @typedef {{ value: string | boolean, reason: string } | null} Lock */
  /** @type {{ all: string | null, approvalMode: Lock, historyMode: Lock, downloadMode: Lock, uploadMode: Lock, fullCdp: Lock, neverAsk: boolean }} */
  const locks = { all: null, approvalMode: null, historyMode: null, downloadMode: null, uploadMode: null, fullCdp: null, neverAsk: true };
  if (r.allowBrowserAndComputerUse === false) locks.all = 'Your organization turned off browser use for Codex.';
  if (bu.allowGlobalPersistentApproval === false) {
    // the plugin only auto-approves when global grants are allowed
    locks.neverAsk = false;
    const reason = 'Your organization requires Codex to ask each time.';
    locks.approvalMode = { value: ASK, reason };
    locks.downloadMode = { value: ASK, reason };
    locks.uploadMode = { value: ASK, reason };
  }
  if (bu.allowHistoryAccess === false)
    locks.historyMode = { value: DISABLED, reason: 'Your organization turned off browsing history access.' };
  else if (own.allow_history_access === false)
    locks.historyMode = { value: DISABLED, reason: 'Turned off in config.toml (browser_use.allow_history_access).' };
  if (r.featureRequirements?.browser_use_full_cdp_access === false)
    locks.fullCdp = { value: false, reason: 'Your organization turned off full CDP access.' };
  return locks;
}

/** One origin policy as allow / deny per permission; null when it sets none of them. */
function policyCells(policy, field) {
  if (!isTable(policy)) return null;
  const cells = {};
  let any = false;
  for (const res of RESOURCES) {
    const v = policy[POLICY_FIELDS[res][field]];
    cells[res] = v === 'allow' || v === 'deny' ? v : null;
    if (cells[res]) any = true;
  }
  return any ? cells : null;
}

/** The managed and config.toml origin policies, read only, each with where it comes from. */
function policiesOf(requirements, config) {
  const out = [];
  const add = (pattern, policy, source, field) => {
    const cells = policyCells(policy, field);
    if (cells) out.push({ pattern, source, ...cells });
  };
  const bu = requirements?.browserUse ?? {};
  add('*', bu.defaultOriginPolicy, 'managed', 0);
  for (const [pattern, policy] of Object.entries(isTable(bu.origins) ? bu.origins : {})) add(pattern, policy, 'managed', 0);
  const own = isTable(config?.browser_use) ? config.browser_use : {};
  add('*', own.default_origin_policy, 'config', 1);
  for (const [pattern, policy] of Object.entries(isTable(own.origins) ? own.origins : {})) add(pattern, policy, 'config', 1);
  return out;
}

/** The saved per-site rules, one entry per origin, allow / deny / null per permission. */
function sitesOf(data) {
  const sites = new Map();
  for (const res of RESOURCES) {
    const table = data[TABLES[res]];
    for (const [kind, decision] of [
      ['allowed', 'allow'],
      ['denied', 'deny'],
    ]) {
      for (const origin of listOf(table, kind)) {
        if (!sites.has(origin)) sites.set(origin, { origin, browse: null, downloads: null, uploads: null, debug: null });
        const site = sites.get(origin);
        // the plugin lets a denial win over an allowance of the same origin
        if (site[res] !== 'deny') site[res] = decision;
      }
    }
  }
  return [...sites.values()].sort((a, b) => a.origin.localeCompare(b.origin));
}

/**
 * The settings view: each preference with its value, choices and lock, the saved sites and the read-only
 * policies. `requirementsKnown` is false when Codex's requirements could not be read.
 * @param data the parsed config.toml
 * @param {{ requirements?: any, config?: any, requirementsKnown?: boolean }} [limits]
 */
function browserUseView(data, { requirements, config, requirementsKnown = true } = {}) {
  const locks = locksOf(requirements, config);
  const prefs = {};
  for (const name of Object.keys(PREFS)) {
    const lock = locks[name];
    const values = PREFS[name].values.filter((v) => v !== NEVER || locks.neverAsk);
    prefs[name] = lock
      ? { value: lock.value, options: values, locked: lock.reason }
      : { value: prefValue(data, name), options: values, locked: locks.all };
  }
  return {
    file: CONFIG_FILE,
    disabled: locks.all,
    requirementsKnown,
    prefs,
    sites: sitesOf(data),
    policies: policiesOf(requirements, config),
  };
}

/** The file's contents with one preference changed; refused when policy fixes it or the value isn't one. */
function withPreference(data, name, value, locks) {
  const p = PREFS[name];
  if (!p) throw coded('invalid', `Unknown browser setting: ${name}`);
  if (!p.values.includes(value)) throw coded('invalid', `Not a value for ${name}: ${value}`);
  if (locks.all) throw coded('locked', locks.all);
  if (locks[name] && locks[name].value !== value) throw coded('locked', locks[name].reason);
  if (value === NEVER && !locks.neverAsk) throw coded('locked', 'Your organization requires Codex to ask each time.');
  return { ...data, [p.key]: value };
}

/**
 * The file's contents with one origin's rule for one permission set: 'allow' adds it to `allowed` (and takes
 * it out of `denied`), 'deny' the other way round, null takes it out of both. A new origin is saved the way
 * the app saves one; an origin already in a list keeps its spelling.
 */
function withRule(data, resource, origin, decision, locks = { all: null }) {
  const name = TABLES[resource];
  if (!name) throw coded('invalid', `Unknown site permission: ${resource}`);
  if (decision !== 'allow' && decision !== 'deny' && decision !== null) throw coded('invalid', `Not a decision: ${decision}`);
  if (locks.all) throw coded('locked', locks.all);
  const prev = data[name];
  if (prev !== undefined && !isTable(prev)) throw coded('unreadable', `browser/config.toml: ${name} is not a table`);
  const table = { ...(prev ?? {}) };
  const known = listOf(table, 'allowed').includes(origin) || listOf(table, 'denied').includes(origin);
  const key = known || decision === null ? String(origin) : normalizeOrigin(origin);
  if (!key) throw coded('invalid', `Not a site address: ${String(origin).slice(0, 200)}`);
  for (const kind of ['allowed', 'denied']) {
    if (table[kind] !== undefined && !Array.isArray(table[kind]))
      throw coded('unreadable', `browser/config.toml: ${name}.${kind} is not a list`);
    const list = listOf(table, kind).filter((o) => o !== key);
    if ((kind === 'allowed' && decision === 'allow') || (kind === 'denied' && decision === 'deny')) list.push(key);
    table[kind] = list;
  }
  return { ...data, [name]: table };
}

/** The file's contents with every saved rule for an origin removed (Remove in the Sites table). */
function withoutSite(data, origin, locks = { all: null }) {
  let next = data;
  for (const res of RESOURCES) if (data[TABLES[res]] !== undefined) next = withRule(next, res, origin, null, locks);
  return next;
}

/**
 * A URL's parts a Browser Use origin pattern is compared with, or null for a page that isn't http(s). The host's
 * trailing dot ("example.com.", the same site) is dropped; URL already reports a default port as none.
 */
function urlParts(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:'
      ? { protocol: u.protocol, host: u.hostname.toLowerCase().replace(/\.$/, ''), port: u.port }
      : null;
  } catch {
    return null;
  }
}

/** A host glob as the plugin reads one: `*` any run of characters, `?` one character. */
const hostGlob = (glob) =>
  new RegExp(
    `^${glob
      .toLowerCase()
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  );

/**
 * Whether a Browser Use origin pattern ("https://*.example.com", "http://localhost:3000", "*") covers a URL:
 * the same scheme and port, and the host matching its glob.
 */
function patternCovers(pattern, url) {
  const at = urlParts(url);
  if (!at || typeof pattern !== 'string') return false;
  if (pattern === '*') return true;
  const i = pattern.indexOf('://');
  if (i <= 0) return false;
  const protocol = `${pattern.slice(0, i).toLowerCase()}:`;
  const rest = pattern.slice(i + 3);
  const m = /^([^:/?#]+)(?::(\d+))?$/.exec(rest);
  if (!m) return false;
  // a pattern that spells out its scheme's default port means no port, as the URL reports it
  const port = (protocol === 'https:' && m[2] === '443') || (protocol === 'http:' && m[2] === '80') ? '' : (m[2] ?? '');
  return protocol === at.protocol && port === at.port && hostGlob(m[1].replace(/\.$/, '')).test(at.host);
}

/** What one source's origin policies decide for site access: a matching deny wins, then a matching allow, then the default. */
function accessOf(policies, fallback, field, url) {
  let allowed = false;
  for (const [pattern, policy] of Object.entries(isTable(policies) ? policies : {})) {
    if (!isTable(policy) || !patternCovers(pattern, url)) continue;
    if (policy[POLICY_FIELDS.browse[field]] === 'deny') return 'deny';
    if (policy[POLICY_FIELDS.browse[field]] === 'allow') allowed = true;
  }
  if (allowed) return 'allow';
  return isTable(fallback) ? (fallback[POLICY_FIELDS.browse[field]] ?? null) : null;
}

/** Where MoPilot applies a Codex Browser Use block, as each refusal says. */
const EVERY_CHAT = 'which MoPilot applies in every chat';
const ADMIN = 'Only your administrator can change it.';

/**
 * Why Codex Browser Use refuses `url`, or null: browser use is off for Codex, a managed or config.toml origin
 * policy denies access, or the user blocked the site in Codex (config.toml [origins].denied). Each reason says
 * where the block is set and what the user can do about it.
 * @param data the parsed browser/config.toml
 * @param {{ requirements?: any, config?: any }} limits
 * @param {string} url
 * @param {{ configFile?: string }} [where] config.toml as the user knows it
 */
function browseBlock(data, { requirements, config }, url, { configFile = '~/.codex/config.toml' } = {}) {
  if (!urlParts(url)) return null;
  if (requirements?.allowBrowserAndComputerUse === false)
    return `Your organization's Codex policy turns off browser use, ${EVERY_CHAT}. ${ADMIN}`;
  const bu = requirements?.browserUse ?? {};
  if (accessOf(bu.origins, bu.defaultOriginPolicy, 0, url) === 'deny')
    return `Your organization's Codex Browser Use policy blocks this site, ${EVERY_CHAT}. ${ADMIN}`;
  const own = isTable(config?.browser_use) ? config.browser_use : {};
  if (accessOf(own.origins, own.default_origin_policy, 1, url) === 'deny')
    return `A Codex Browser Use policy in ${configFile} (browser_use) blocks this site, ${EVERY_CHAT}. Change it there to allow the site.`;
  // an exact site compares through the same rules as a pattern (a trailing dot or a default port is the same site)
  const covers = (o) => {
    const site = o.includes('*') ? o : normalizeOrigin(o);
    return !!site && patternCovers(site, url);
  };
  if (listOf(data?.[TABLES.browse], 'denied').some(covers))
    return `You blocked this site in Codex Browser Use, ${EVERY_CHAT}. Remove the block in Settings → Browser → Sites to allow it.`;
  return null;
}

/**
 * The settings file of one CODEX_HOME, with the policy that limits it.
 * @param {{ home: () => string, fs?: typeof nodeFs, policy: () => Promise<{ requirements?: any, config?: any, requirementsKnown?: boolean }> }} o
 */
class CodexBrowserUse {
  constructor(o) {
    this.home = o.home;
    this.fs = o.fs ?? nodeFs;
    this.policy = o.policy;
    /** writes run one after another, each on the file as the last one left it */
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
  }

  file() {
    return path.join(this.home(), CONFIG_FILE);
  }

  /** The file's contents: {} when there is none; an error when it can't be read as TOML. */
  read() {
    let text;
    try {
      text = this.fs.readFileSync(this.file(), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw coded('unreadable', `Couldn't read ${CONFIG_FILE}: ${e.message}`);
    }
    let data;
    try {
      data = parse(text);
    } catch (e) {
      throw coded('unreadable', `${CONFIG_FILE} isn't valid TOML: ${e.message}`);
    }
    return data;
  }

  write(data) {
    const file = this.file();
    try {
      // smol-toml ends its output with a newline, as the app's file does
      writeAtomic(file, stringify(data), this.fs);
    } catch (e) {
      throw coded('save_failed', `Couldn't save ${CONFIG_FILE}: ${e.message}`);
    }
  }

  async limits() {
    try {
      const p = (await this.policy()) ?? {};
      return { requirements: p.requirements ?? null, config: p.config ?? null, requirementsKnown: p.requirementsKnown !== false };
    } catch {
      return { requirements: null, config: null, requirementsKnown: false };
    }
  }

  /** The settings view, or {error} when the file can't be read (nothing is written then). */
  async state() {
    const limits = await this.limits();
    try {
      return browserUseView(this.read(), limits);
    } catch (e) {
      return { error: String(e.message), file: CONFIG_FILE };
    }
  }

  /** Applies one change to the file as it is now, then answers with the new view. */
  change(edit) {
    const run = this.queue.then(async () => {
      const limits = await this.limits();
      const locks = locksOf(limits.requirements, limits.config);
      this.write(edit(this.read(), locks));
      return browserUseView(this.read(), limits);
    });
    // the next change waits for this one to settle; its error reaches the caller through run
    this.queue = Promise.allSettled([run]);
    return run;
  }

  setPreference(name, value) {
    return this.change((data, locks) => withPreference(data, name, value, locks));
  }

  setRule(resource, origin, decision) {
    return this.change((data, locks) => withRule(data, resource, origin, decision ?? null, locks));
  }

  forget(origin) {
    return this.change((data, locks) => withoutSite(data, String(origin), locks));
  }
}

module.exports = {
  CodexBrowserUse,
  browseBlock,
  patternCovers,
  browserUseView,
  locksOf,
  policiesOf,
  sitesOf,
  withPreference,
  withRule,
  withoutSite,
  normalizeOrigin,
  listOf,
  CONFIG_FILE,
  TABLES,
  PREFS,
  ASK,
  NEVER,
  DISABLED,
};
