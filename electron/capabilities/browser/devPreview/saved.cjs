// Approved local preview recipes survive app shutdown and coalesce restoration for the owning chat.
const path = require('node:path');
const { readStoreFile, writeAtomic } = require('../../../platform/fsutil.cjs');
const { isJsonRecord } = require('../../../../shared/jsonRecord.mjs');

/** @param {unknown} v @returns {v is string} */
const text = (v) => typeof v === 'string' && v.length > 0;
/** @param {unknown} v @returns {v is string[]} */
const strings = (v) => Array.isArray(v) && v.length > 0 && v.every(text);
const localOrigin = (url) => {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? u.origin : null;
  } catch {
    return null;
  }
};
const valid = (v) =>
  isJsonRecord(v) &&
  v.version === 1 &&
  Array.isArray(v.servers) &&
  v.servers.every(
    (s) =>
      isJsonRecord(s) &&
      text(s.id) &&
      text(s.chatId) &&
      localOrigin(s.url) &&
      strings(s.origins) &&
      s.origins.every((origin) => localOrigin(origin) === origin) &&
      isJsonRecord(s.launch) &&
      strings(s.launch.run) &&
      text(s.launch.display) &&
      text(s.launch.cwd) &&
      path.isAbsolute(s.launch.cwd) &&
      (s.launch.project === null || text(s.launch.project)) &&
      (s.launch.port === null ||
        (typeof s.launch.port === 'number' && Number.isInteger(s.launch.port) && s.launch.port > 0 && s.launch.port < 65536)) &&
      (s.launch.url === null || !!localOrigin(s.launch.url)) &&
      (s.launch.name === null || text(s.launch.name)) &&
      typeof s.launch.verbatim === 'boolean' &&
      isJsonRecord(s.launch.env) &&
      Object.values(s.launch.env).every((v) => typeof v === 'string'),
  );

class SavedPreviews {
  constructor(file) {
    this.file = file;
    const { data, error } = readStoreFile(file, 'saved preview servers', valid);
    this.error = error;
    this.records = new Map((data?.servers ?? []).map((s) => [s.id, s]));
    this.restoring = new Map();
  }

  #commit(records) {
    if (this.error) throw new Error('Saved previews could not be read. Their previous launch details have been preserved.');
    writeAtomic(this.file, JSON.stringify({ version: 1, servers: [...records.values()] }), undefined, 0o600);
    this.records = records;
  }

  remember(s) {
    // A terminal's attached server has no approved launch recipe. Nonlocal sites need no local process restoration.
    if (!s.launch || !localOrigin(s.url)) return;
    const origins = [...new Set([...(this.records.get(s.id)?.origins ?? []), localOrigin(s.url)])];
    const next = new Map(this.records);
    next.delete(s.id);
    this.#commit(next.set(s.id, { id: s.id, chatId: s.chatId, url: s.url, origins, launch: s.launch }));
  }

  forget(accept) {
    const next = new Map([...this.records].filter(([, s]) => !accept(s)));
    if (next.size !== this.records.size) this.#commit(next);
  }

  /** Null for an ordinary page; otherwise a bounded restoration whose result keeps this tab's route. */
  prepare(previews, chatId, url) {
    const origin = localOrigin(url);
    const record = origin && [...this.records.values()].findLast((s) => s.chatId === chatId && s.origins.includes(origin));
    if (!record) return null;
    let work = this.restoring.get(record.id);
    if (!work) {
      work = this.#restore(previews, record);
      this.restoring.set(record.id, work);
      const settled = () => this.restoring.delete(record.id);
      work.then(settled, settled);
    }
    return work.then((base) => {
      const route = new URL(url);
      const target = new URL(base);
      target.pathname = route.pathname;
      target.search = route.search;
      target.hash = route.hash;
      return target.href;
    });
  }

  async #restore(previews, record) {
    const current = async () => {
      const allowed = await previews.canRestore(record);
      if (previews.closing || !this.records.has(record.id) || !allowed)
        throw new Error('This preview can no longer restart in this chat. Start it again from the current project.');
    };
    await current();
    let s = previews.list(record.chatId).find((s) => s.id === record.id && s.live);
    if (!s) {
      const u = new URL(record.url);
      // A server the user already started is left alone; quitting MoPilot must not stop that process.
      const serving = await previews.probe(Number(u.port) || (u.protocol === 'https:' ? 443 : 80), u.hostname.replace(/^\[|\]$/g, ''));
      await current();
      if (serving) return record.url;
      s = previews.start(record.chatId, record.launch, record.id);
    }
    const outcome = await previews.waitReady(s);
    await current();
    if (outcome !== 'ready' || !s.live)
      throw new Error('The preview server could not restart. Check its preview logs, then retry this page.');
    return s.url;
  }
}

module.exports = { SavedPreviews };
