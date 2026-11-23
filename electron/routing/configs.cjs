// The user's library of named model configs for routed chats (plan Part B): provider, model, Claude tier models and ordered fallbacks, kept in userData/llm-configs.json and validated on every read and write. A save or remove reads the file again and changes only its own config, so edits from two windows never drop each other; a file that can't be read is kept as it is, reported, and never read as empty.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fs } = require('../platform/ports/fs.cjs');
const { writePrivate, readStoreFile } = require('../platform/fsutil.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { llmProvider, checkBaseUrl } = require('../../shared/llmProviders.mjs');

/** The file's name in userData. */
const CONFIGS_FILE = 'llm-configs.json';
/** A config's id: it names the config in the router's URL path (B3), so it carries no delimiter. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A model id as providers spell them (`gpt-5.5`, `anthropic/claude-sonnet-4.5`, `llama3.1:8b`): printable, no spaces. */
const MODEL = /^[\x21-\x7e]{1,200}$/;
/** The Claude Code model families a request may name, each answered by the config's tier model when it has one. */
const TIERS = Object.freeze(['opus', 'sonnet', 'haiku']);
const MAX_NAME = 80;
const MAX_FALLBACKS = 8;
const MAX_CONFIGS = 100;
/** The fields this version reads; any other a newer version wrote is kept on disk as it was. */
const FIELDS = ['id', 'name', 'provider', 'baseUrl', 'model', 'tierModels', 'fallbacks'];

/**
 * @typedef {{ provider: string, model: string }} Fallback
 * @typedef {{ id: string, name: string, provider: string, baseUrl?: string, model: string,
 *   tierModels: { opus?: string, sonnet?: string, haiku?: string }, fallbacks: Fallback[] }} ModelConfig
 */

/** A refusal the window shows as it is. @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });

/** @param {unknown} v */
const modelOf = (v) => (typeof v === 'string' && MODEL.test(v.trim()) ? v.trim() : null);

/**
 * `value` as a config, or why it is not one. Absent optional fields take their defaults; fields this version does not read are left out.
 * @param {unknown} value
 * @returns {{ ok: true, config: ModelConfig } | { ok: false, error: string }}
 */
function checkConfig(value) {
  if (!isJsonRecord(value)) return { ok: false, error: 'A config must be an object.' };
  const v = /** @type {Record<string, unknown>} */ (value);
  if (typeof v.id !== 'string' || !ID.test(v.id)) return { ok: false, error: 'The config’s id is not valid.' };
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name || name.length > MAX_NAME || /[\x00-\x1f\x7f]/.test(name))
    return { ok: false, error: `Give the config a name of up to ${MAX_NAME} characters.` };
  const provider = llmProvider(v.provider);
  if (!provider) return { ok: false, error: 'Choose a provider.' };
  /** @type {string | undefined} */
  let baseUrl;
  if (provider.customBase) {
    const base = checkBaseUrl(v.baseUrl);
    if (!base.ok) return base;
    baseUrl = base.url;
  } else if (v.baseUrl !== undefined && v.baseUrl !== null && v.baseUrl !== '') {
    return { ok: false, error: `${provider.label} is reached at its own address; only an OpenAI-compatible server takes a URL.` };
  }
  const model = modelOf(v.model);
  if (!model) return { ok: false, error: 'Enter the model’s id.' };
  if (v.tierModels !== undefined && v.tierModels !== null && !isJsonRecord(v.tierModels))
    return { ok: false, error: 'Tier models must be an object.' };
  /** @type {ModelConfig['tierModels']} */
  const tierModels = {};
  for (const [tier, id] of Object.entries(/** @type {Record<string, unknown>} */ (v.tierModels ?? {}))) {
    if (!TIERS.includes(tier)) return { ok: false, error: `“${tier.slice(0, 20)}” is not a Claude model family (opus, sonnet or haiku).` };
    if (id === undefined || id === null || id === '') continue;
    const m = modelOf(id);
    if (!m) return { ok: false, error: `Enter the ${tier} model’s id.` };
    tierModels[/** @type {'opus' | 'sonnet' | 'haiku'} */ (tier)] = m;
  }
  if (v.fallbacks !== undefined && v.fallbacks !== null && !Array.isArray(v.fallbacks))
    return { ok: false, error: 'Fallbacks must be a list.' };
  const list = /** @type {unknown[]} */ (v.fallbacks ?? []);
  if (list.length > MAX_FALLBACKS) return { ok: false, error: `A config takes at most ${MAX_FALLBACKS} fallbacks.` };
  /** @type {Fallback[]} */
  const fallbacks = [];
  const seen = new Set([JSON.stringify([provider.id, model])]);
  for (const f of list) {
    const fp = isJsonRecord(f) ? llmProvider(/** @type {any} */ (f).provider) : null;
    const fm = isJsonRecord(f) ? modelOf(/** @type {any} */ (f).model) : null;
    if (!fp || !fm) return { ok: false, error: 'Each fallback needs a provider and a model.' };
    // a server the user names is reached at the config's own URL, so only a config on it may fall back to it
    if (fp.customBase && fp.id !== provider.id) return { ok: false, error: `A fallback can use ${fp.label} only in a config that does.` };
    const key = JSON.stringify([fp.id, fm]);
    if (seen.has(key)) return { ok: false, error: `${fp.label} ${fm} is listed twice.` };
    seen.add(key);
    fallbacks.push({ provider: fp.id, model: fm });
  }
  return { ok: true, config: { id: v.id, name, provider: provider.id, ...(baseUrl ? { baseUrl } : {}), model, tierModels, fallbacks } };
}

/**
 * @param {{ file: string, newId?: () => string, write?: (file: string, data: string) => void }} o
 *   write: publishes the file atomically (tests fail it)
 */
function createConfigs({ file, newId = randomUUID, write = (f, d) => writePrivate(f, d, fs, { durable: true }) }) {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** The configs as last read whole, shown while the file can't be read. @type {ModelConfig[]} */
  let lastGood = [];
  /** The file's fields beside `configs`, as last read. @type {Record<string, unknown>} */
  let root = { v: 1 };
  /**
   * The file's entries as written, each with its config when it is one. An unreadable file (not JSON, not `{configs: [...]}`) is
   * copied to `<file>.unreadable` and reported (fsutil readStoreFile), and nothing is written over it.
   * @returns {{ ok: true, entries: { raw: unknown, config: ModelConfig | null }[] } | { ok: false }}
   */
  const read = () => {
    const { data, error } = readStoreFile(file, 'the model configs', (d) => isJsonRecord(d) && Array.isArray(d.configs));
    if (error) return { ok: false };
    // the file's other fields (a newer version's) are written back as they were
    root = { v: 1, ...Object.fromEntries(Object.entries(data ?? {}).filter(([k]) => k !== 'configs')) };
    return { ok: true, entries: entriesOf(data?.configs ?? []) };
  };
  /** The entries of `raws`, which become the configs last read whole. @param {unknown[]} raws */
  const entriesOf = (raws) => {
    const seen = new Set();
    const entries = raws.map((raw) => {
      const checked = checkConfig(raw);
      // a second entry with an id already listed is not shown; it stays on disk until that id is saved or removed
      const config = checked.ok && !seen.has(checked.config.id) ? checked.config : null;
      if (config) seen.add(config.id);
      return { raw, config };
    });
    lastGood = entries.flatMap((e) => (e.config ? [e.config] : []));
    return entries;
  };
  /** The entries as they are now, for a change: refused while the file can't be read. */
  const current = () => {
    const now = read();
    if (!now.ok) throw refusal('The saved model configs can’t be read, so nothing was changed.', 'unreadable');
    return now.entries;
  };
  /** @param {unknown[]} raws */
  const publish = (raws) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      write(file, `${JSON.stringify({ ...root, configs: raws }, null, 2)}\n`);
    } catch {
      throw refusal('The model configs could not be saved.', 'write_failed');
    }
    entriesOf(raws);
    for (const fn of [...listeners]) fn();
  };
  /** @param {unknown} raw @param {string} id */
  const isId = (raw, id) => isJsonRecord(raw) && /** @type {any} */ (raw).id === id;
  return {
    /**
     * Every config, in the file's order. `state` 'unreadable': the file can't be read, and `configs` are the ones last read from it.
     * `invalid`: entries that are not a config this version takes, kept on disk as they are.
     * @returns {{ configs: ModelConfig[], invalid: number, state: 'ok' | 'unreadable' }}
     */
    list() {
      const now = read();
      if (!now.ok) return { configs: lastGood.map((c) => structuredClone(c)), invalid: 0, state: 'unreadable' };
      return { configs: lastGood.map((c) => structuredClone(c)), invalid: now.entries.filter((e) => !e.config).length, state: 'ok' };
    },
    /** The config `id` names, or null; while the file can't be read, from the configs last read (the ones `list` shows). @param {unknown} id */
    get(id) {
      read();
      const hit = lastGood.find((c) => c.id === id);
      return hit ? structuredClone(hit) : null;
    },
    /**
     * Add a config, or replace the one with its id; the saved config. A config without an id gets a new one. Fields a newer version
     * wrote on the replaced config are kept.
     * @param {unknown} input
     * @returns {ModelConfig}
     */
    save(input) {
      const given = isJsonRecord(input) ? /** @type {Record<string, unknown>} */ (input) : null;
      const checked = checkConfig(
        given && (given.id === undefined || given.id === null || given.id === '') ? { ...given, id: newId() } : input,
      );
      if (!checked.ok) throw refusal(checked.error, 'invalid');
      const { config } = checked;
      const entries = current();
      const at = entries.findIndex((e) => isId(e.raw, config.id));
      const old = at < 0 ? {} : /** @type {Record<string, unknown>} */ (entries[at].raw);
      const kept = Object.fromEntries(Object.entries(old).filter(([k]) => !FIELDS.includes(k)));
      const raws = entries.filter((e) => !isId(e.raw, config.id)).map((e) => e.raw);
      if (at < 0 && raws.length >= MAX_CONFIGS) throw refusal(`Keep at most ${MAX_CONFIGS} model configs.`, 'invalid');
      raws.splice(at < 0 ? raws.length : at, 0, { ...kept, ...config });
      publish(raws);
      return structuredClone(config);
    },
    /** Forget the config `id` names; false when there was none. @param {unknown} id */
    remove(id) {
      if (typeof id !== 'string') return false;
      const entries = current();
      const raws = entries.filter((e) => !isId(e.raw, id)).map((e) => e.raw);
      if (raws.length === entries.length) return false;
      publish(raws);
      return true;
    },
    /** Told after a config is saved or removed. @param {() => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/** @typedef {ReturnType<typeof createConfigs>} ModelConfigs */

module.exports = { createConfigs, checkConfig, CONFIGS_FILE, TIERS };
