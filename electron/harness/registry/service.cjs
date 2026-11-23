// Main-owned registry discovery and explicit installations: serial publication, per-agent coalescing and persisted admission contracts.
const path = require('node:path');
const crypto = require('node:crypto');
const { fs } = require('../../platform/ports/fs.cjs');
const { writeAtomic } = require('../../platform/fsutil.cjs');
const { noteIgnored, messageOf } = require('../../ignored.cjs');
const { registryAgent, registryAgents, registryDistribution } = require('../../../shared/acpRegistry.mjs');
const { registerRegistryAgents, ACP_CATALOG } = require('../../../shared/harnessCatalog.mjs');
const { RegistryCatalog } = require('./catalog.cjs');
const { installDistribution, writeLauncher } = require('./install.cjs');

class RegistryHarnesses {
  /** @param {{ dir: string, which: (name: string) => string | null, platform?: string, arch?: string,
   *   catalog?: InstanceType<typeof RegistryCatalog>, install?: typeof installDistribution, onInstalled?: (id: string) => Promise<unknown> }} o */
  constructor({
    dir,
    which,
    platform = process.platform,
    arch = process.arch,
    catalog,
    install = installDistribution,
    onInstalled = async () => undefined,
  }) {
    this.dir = dir;
    this.which = which;
    this.platform = platform;
    this.arch = arch;
    this.catalog = catalog ?? new RegistryCatalog({ file: path.join(dir, 'catalog.json') });
    this.installer = install;
    this.onInstalled = onInstalled;
    this.installed = new Map();
    this.locations = new Map();
    this.inflight = new Map();
    /** @type {Promise<unknown>} */
    this.tail = Promise.resolve();
    this.closed = false;
    this.abort = new AbortController();
    this.file = path.join(dir, 'installed.json');
    this.loadError = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const agents = registryAgents(saved);
      for (const agent of agents) {
        const location = saved.locations?.[agent.id];
        if (typeof location !== 'string' || !new RegExp(`^${agent.version.replaceAll('.', '\\.')}--[a-f0-9-]{36}$`).test(location))
          throw new Error('An installed ACP agent has an invalid location.');
      }
      registerRegistryAgents(agents);
      for (const agent of agents) {
        this.installed.set(`registry-${agent.id}`, agent);
        this.locations.set(agent.id, saved.locations[agent.id]);
      }
    } catch (error) {
      noteIgnored('read the installed ACP registry agents', error, ['ENOENT']);
      if (error.code !== 'ENOENT')
        this.loadError =
          'The installed ACP agent records could not be read. Restore registry-agents/installed.json from a backup before installing another agent.';
    }
  }

  distribution(agent) {
    return registryDistribution(agent, {
      platform: this.platform,
      arch: this.arch,
      npm: !!this.which('npm') && !!this.which('npx'),
      uv: !!this.which('uv') && !!this.which('uvx'),
    });
  }

  async list(options) {
    const snapshot = await this.catalog.list(options);
    const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    for (const installed of this.installed.values()) if (!agents.has(installed.id)) agents.set(installed.id, installed);
    return {
      ...snapshot,
      error: this.loadError ?? snapshot.error,
      agents: [...agents.values()].map((agent) => ({
        ...agent,
        installed: !!this.resolve(`registry-${agent.id}`),
        installedVersion: this.installed.get(`registry-${agent.id}`)?.version ?? null,
        needsUpdate:
          this.installed.has(`registry-${agent.id}`) &&
          JSON.stringify(this.installed.get(`registry-${agent.id}`)) !== JSON.stringify(agent),
        repairAvailable:
          this.platform !== 'win32' &&
          !!this.installed.get(`registry-${agent.id}`) &&
          !!this.distribution(this.installed.get(`registry-${agent.id}`)),
        available: this.platform !== 'win32' && !!this.distribution(agent),
      })),
    };
  }

  resolve(id) {
    const agent = this.installed.get(id);
    if (!agent) return null;
    const file = path.join(this.dir, agent.id, this.locations.get(agent.id), 'launch');
    return fs.existsSync(file) ? file : null;
  }

  resolveAuth(id) {
    const binary = this.resolve(id);
    const file = binary && path.join(path.dirname(binary), 'authenticate');
    return file && fs.existsSync(file) ? file : null;
  }

  /** Only an id is accepted from the window; executable metadata is read again from main's validated snapshot. */
  install(id, runPackage, { repair = false } = {}) {
    if (this.closed) return Promise.reject(new Error('The ACP registry is closed.'));
    if (this.loadError) return Promise.reject(new Error(this.loadError));
    if (this.inflight.has(id)) return this.inflight.get(id);
    const agent = repair ? this.installed.get(`registry-${id}`) : this.catalog.agents.find((candidate) => candidate.id === id);
    if (!agent) return Promise.reject(new Error('Choose an agent from the current ACP registry.'));
    const work = this.tail.then(() => this.perform(agent, runPackage, repair));
    this.inflight.set(id, work);
    this.tail = work.catch((error) => ({ ok: false, error: messageOf(error) }));
    work.then(
      () => this.inflight.delete(id),
      () => this.inflight.delete(id),
    );
    return work;
  }

  async perform(raw, runPackage, repair) {
    if (this.closed) throw new Error('The ACP registry is closed.');
    const agent = registryAgent(raw);
    const id = `registry-${agent.id}`;
    const existing = ACP_CATALOG[id];
    if (existing && !existing.registry) throw new Error('The ACP registry cannot replace a native harness.');
    const distribution = this.distribution(agent);
    if (this.platform === 'win32' || !distribution)
      throw new Error(
        'This ACP agent has no usable distribution on this computer. Install its required package manager or choose another agent.',
      );
    const resolved = this.resolve(id);
    if (!repair && resolved && JSON.stringify(this.installed.get(id)) === JSON.stringify(agent)) {
      await this.onInstalled(id);
      return { id, file: resolved };
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stage = fs.mkdtempSync(path.join(this.dir, '.install-'));
    const location = `${agent.version}--${crypto.randomUUID()}`;
    const target = path.join(this.dir, agent.id, location);
    // Package environments may contain absolute paths, so their private cache stays put when staging is published.
    const packageCache = path.join(this.dir, '.packages', agent.id, location);
    let moved = false;
    let committed = false;
    try {
      const spec = await this.installer({
        agent,
        distribution,
        stage,
        packageCache,
        which: this.which,
        runPackage,
        signal: this.abort.signal,
      });
      if (this.closed) throw new Error('The ACP registry closed before installation completed.');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.renameSync(stage, target);
      moved = true;
      const relocated = (value) =>
        typeof value === 'string' && (value === stage || value.startsWith(`${stage}${path.sep}`))
          ? target + value.slice(stage.length)
          : value;
      const file = path.join(target, 'launch');
      writeLauncher(file, {
        program: relocated(spec.program),
        args: [...spec.prefix, ...spec.args].map(relocated),
        env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, relocated(value)])),
      });
      writeLauncher(path.join(target, 'authenticate'), { program: relocated(spec.program), args: spec.prefix.map(relocated), env: {} });
      const next = new Map(this.installed);
      next.set(id, agent);
      const locations = new Map(this.locations);
      locations.set(agent.id, location);
      writeAtomic(this.file, JSON.stringify({ agents: [...next.values()], locations: Object.fromEntries(locations) }), fs, 0o600);
      registerRegistryAgents([agent]);
      this.installed = next;
      this.locations = locations;
      committed = true;
      await this.onInstalled(id);
      return { id, file };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      if (moved && !committed) fs.rmSync(target, { recursive: true, force: true });
      if (!committed) fs.rmSync(packageCache, { recursive: true, force: true });
    }
  }

  dispose() {
    if (!this.closed) {
      this.closed = true;
      this.abort.abort();
      this.catalog.dispose();
    }
    return this.tail;
  }
}

module.exports = { RegistryHarnesses };
