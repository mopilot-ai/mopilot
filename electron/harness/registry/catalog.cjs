// Holds one validated ACP registry snapshot in main; refreshes coalesce, failed refreshes retain the cache, disposal retires pending reads.
const { fs } = require('../../platform/ports/fs.cjs');
const { writeAtomic } = require('../../platform/fsutil.cjs');
const { ACP_REGISTRY_URL, registryAgents } = require('../../../shared/acpRegistry.mjs');
const { messageOf, noteIgnored } = require('../../ignored.cjs');

const MAX_BYTES = 2 * 1024 * 1024;
const FRESH_MS = 24 * 60 * 60 * 1000;

class RegistryCatalog {
  /** @param {{ file: string, fetch?: typeof fetch, now?: () => number }} o */
  constructor({ file, fetch: fetchFn = fetch, now = Date.now }) {
    this.file = file;
    this.fetch = fetchFn;
    this.now = now;
    this.agents = [];
    this.checkedAt = 0;
    this.error = null;
    this.inflight = null;
    this.closed = false;
    this.abort = new AbortController();
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isFinite(cached.checkedAt) && cached.checkedAt <= now()) {
        this.agents = registryAgents(cached);
        this.checkedAt = cached.checkedAt;
      }
    } catch (error) {
      // A missing or invalid cache is refreshed only when the user opens the registry.
      noteIgnored('read the cached ACP registry', error, ['ENOENT']);
    }
  }

  snapshot() {
    return { agents: this.agents, error: this.error };
  }

  /** Discovery never starts an agent, package manager or download of executable code. */
  list({ force = false } = {}) {
    if (this.closed) return Promise.reject(new Error('The ACP registry is closed.'));
    if (this.inflight) return this.inflight;
    if (!force && this.checkedAt && this.now() - this.checkedAt < FRESH_MS) return Promise.resolve(this.snapshot());
    const work = this.refresh().finally(() => {
      if (this.inflight === work) this.inflight = null;
    });
    this.inflight = work;
    return work;
  }

  async refresh() {
    try {
      const response = await this.fetch(ACP_REGISTRY_URL, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]) });
      if (!response.ok) throw new Error(`The ACP registry answered HTTP ${response.status}.`);
      const body = await response.text();
      if (body.length > MAX_BYTES) throw new Error('The ACP registry response is too large.');
      const agents = registryAgents(JSON.parse(body));
      if (this.closed) return this.snapshot();
      const checkedAt = this.now();
      writeAtomic(this.file, JSON.stringify({ agents, checkedAt }), fs, 0o600);
      this.agents = agents;
      this.checkedAt = checkedAt;
      this.error = null;
    } catch (error) {
      if (!this.closed) this.error = `Could not refresh the ACP registry: ${messageOf(error)}`;
    }
    return this.snapshot();
  }

  dispose() {
    this.closed = true;
    this.abort.abort();
  }
}

module.exports = { RegistryCatalog, FRESH_MS };
