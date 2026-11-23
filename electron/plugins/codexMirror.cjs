// Delivers the plugin store to Codex: Codex installs a plugin only from a marketplace it has registered, so each
// store marketplace gets a local Codex marketplace over its install folders (cache/<marketplace>, named
// mopilot-<marketplace>), and the plugins the store gives Codex are installed there with Codex's own
// plugin/install (Codex copies them into its cache). The mirror follows the store: installed, upgraded and
// removed as it changes. Codex threads switch them off per thread while plugins.codex is off.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { writeAtomic, readJsonRecord } = require('../platform/fsutil.cjs');
const { readMarketplaces, addedMarketplacePath, ownedManifestPath } = require('./codexMirrorBoundary.cjs');
const { parsePluginId, pluginId } = require('../../shared/plugins/manifest.mjs');
const { userError } = require('../../shared/userError.mjs');
const { agentSkillName, agentSkillText, agentNameTaken } = require('../../shared/plugins/agentSkill.mjs');

/** The Codex marketplace a store marketplace's plugins go to Codex through. */
const PREFIX = 'mopilot-';
const codexMarketplace = (marketplace) => `${PREFIX}${marketplace}`;
/** The Codex id of a store plugin ("tidy@acme" → "tidy@mopilot-acme"). */
function codexId(id) {
  const { name, marketplace } = /** @type {{name: string, marketplace: string}} */ (parsePluginId(id));
  return pluginId(name, codexMarketplace(marketplace));
}

/** Where a marketplace's derived plugin copies live (Codex loads no agents, so each agent gets a skill in a copy). */
const DERIVED = '.codex-agents';

/**
 * The folder Codex installs a plugin from. A plugin with agents is copied whole to cache/<marketplace>/.codex-agents/
 * <plugin>/<install folder> with each agent added as skills/agent-<name>/SKILL.md (a skill of that name already there
 * wins), since Codex loads skills and commands but not agents. Any other plugin is installed from its own folder.
 */
function sourceFolder(root, p) {
  if (!p.spec.agents.length) return p.path;
  const out = path.join(root, DERIVED, p.name, path.basename(p.path));
  if (!fs.existsSync(out)) {
    const staging = `${out}.tmp`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(p.path, staging, { recursive: true, dereference: true });
    for (const agent of p.spec.agents) {
      if (agentNameTaken(p.spec, agent.name)) continue;
      const file = path.join(staging, 'skills', agentSkillName(agent.name), 'SKILL.md');
      if (fs.existsSync(file)) continue;
      writeAtomic(file, agentSkillText(agent.name, fs.readFileSync(agent.file, 'utf8')));
    }
    fs.renameSync(staging, out);
  }
  return out;
}

/** Derived copies nothing wants any more go (`keep`: the folders still wanted). */
function pruneDerived(root, keep) {
  const base = path.join(root, DERIVED);
  for (const plugin of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    for (const version of fs.readdirSync(path.join(base, plugin))) {
      const dir = path.join(base, plugin, version);
      if (!keep.has(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    if (!fs.readdirSync(path.join(base, plugin)).length) fs.rmdirSync(path.join(base, plugin));
  }
  if (fs.existsSync(base) && !fs.readdirSync(base).length) fs.rmdirSync(base);
}

const message = (e) => (e instanceof Error ? e.message : String(e));

/** A file's text, or null when it isn't there. */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
    return null;
  }
}

class CodexPluginMirror {
  /**
   * @param {object} o
   * @param {Pick<InstanceType<typeof import('./store.cjs').PluginStore>, 'reserveFor' | 'release' | 'o'>} o.store
   * @param {(method: string, params: object) => Promise<any>} [o.request] the Codex app-server (or attach() later)
   * @param {() => boolean} [o.connected] whether the app-server is up (the mirror never starts it)
   * @param {() => boolean} [o.enabled] plugins.codex
   * @param {(line: string) => void} [o.log]
   */
  constructor(o) {
    this.o = o;
    this.request = o.request ?? (() => Promise.reject(new Error("Codex isn't connected")));
    this.connected = o.connected ?? (() => false);
    this.enabled = o.enabled ?? (() => true);
    this.log = o.log ?? (() => undefined);
    /** @type {Promise<boolean>} */
    this.chain = Promise.resolve(false);
    /** what the last sync left, by store id: {codexId, path, state: 'installed' | 'alreadyOn' | 'failed', error?} */
    this.states = this.readStates();
  }

  /** The Codex adapter main runs, once it exists: the mirror talks to it only while it is up. */
  attach({ request, connected }) {
    this.request = request;
    this.connected = connected;
  }

  dir() {
    return this.o.store.o.dir();
  }
  stateFile() {
    return path.join(this.dir(), 'codex-mirror.json');
  }
  readStates() {
    return /** @type {Record<string, {codexId: string, path: string, state: string, error?: string}>} */ (
      readJsonRecord(this.stateFile()) ?? {}
    );
  }

  /** Bring Codex in line with the store, one sync at a time; nothing while Codex isn't running. */
  sync() {
    // switched off (plugins.codex), what MoPilot gave Codex is taken out again: Codex shares the install with
    // its own app and CLI, which no per-thread switch reaches
    const run = () => (this.connected() ? this.reconcile() : Promise.resolve(false));
    const next = this.chain.then(run, run);
    this.chain = next;
    return next;
  }

  async reconcile() {
    const selected = this.enabled() ? await this.o.store.reserveFor('codex') : { deliver: [], error: null };
    const { deliver, error } = selected;
    try {
      return await this.reconcileSelected(deliver, error);
    } finally {
      await this.o.store.release(deliver.map((entry) => entry.path));
    }
  }

  async reconcileSelected(deliver, error) {
    // a store that can't be read says nothing about what Codex should have: Codex is left as it is
    if (error) throw new Error(`The plugin store couldn't be read, so Codex was left as it is: ${error}`);
    const listed = await this.request('plugin/list', {});
    const marketplaces = readMarketplaces(listed, this.dir());
    const ours = (market) => market.owned;
    // a plugin Codex already has from a marketplace of its own: left to it, so it never loads twice
    const nativeNames = new Set(
      marketplaces.filter((m) => !ours(m)).flatMap((m) => m.plugins.filter((p) => p.installed && p.enabled).map((p) => p.name)),
    );
    const installedHere = new Map(
      marketplaces.filter(ours).flatMap((m) => m.plugins.filter((p) => p.installed).map((p) => [p.id, m.name])),
    );
    const registered = new Map(marketplaces.filter(ours).map((m) => [m.name, m.path]));

    // each store marketplace's Codex marketplace lists exactly what Codex gets from it
    const byMarketplace = new Map();
    for (const d of deliver) {
      const { name, marketplace } = /** @type {{name: string, marketplace: string}} */ (parsePluginId(d.id));
      if (!byMarketplace.has(marketplace)) byMarketplace.set(marketplace, []);
      if (!nativeNames.has(name)) byMarketplace.get(marketplace).push({ ...d, name });
    }
    const states = {};
    for (const [marketplace, plugins] of byMarketplace) {
      const root = path.join(this.dir(), 'cache', marketplace);
      const manifest = ownedManifestPath(this.dir(), marketplace);
      const sources = plugins.map((p) => sourceFolder(root, p));
      pruneDerived(root, new Set(sources));
      const entries = plugins.map((p, i) => ({ name: p.name, source: { source: 'local', path: `./${path.relative(root, sources[i])}` } }));
      const text = JSON.stringify({ name: codexMarketplace(marketplace), plugins: entries }, null, 2);
      if (readText(manifest) !== text) writeAtomic(manifest, text);
      let marketplacePath = registered.get(codexMarketplace(marketplace));
      try {
        if (!marketplacePath && plugins.length) {
          const added = await this.request('marketplace/add', { source: root });
          // Codex names the file under the root it resolved (links followed), and installs by that path
          marketplacePath = addedMarketplacePath(added, this.dir(), marketplace);
        }
      } catch (e) {
        // the row says why in a sentence; the RPC method and Codex's own words go to the log
        this.log(`Couldn't add the ${marketplace} marketplace to Codex (marketplace/add): ${message(e)}`);
        for (const p of plugins) states[p.id] = { codexId: codexId(p.id), path: p.path, state: 'failed', error: userError(e) };
        continue;
      }
      for (const p of plugins) {
        const id = codexId(p.id);
        const prev = this.states[p.id];
        // installed from this very folder already, or found installed with no record of where from (the record
        // was lost): nothing to do. A new install folder is an upgrade.
        if (installedHere.has(id) && (!prev || (prev.state === 'installed' && prev.path === p.path))) {
          states[p.id] = { codexId: id, path: p.path, state: 'installed' };
          continue;
        }
        try {
          // an upgrade: Codex keeps its copy by version, so the old one goes first and the new folder is copied whole
          if (installedHere.has(id)) {
            await this.request('plugin/uninstall', { pluginId: id });
            installedHere.delete(id);
          }
          await this.request('plugin/install', { marketplacePath, pluginName: p.name });
          states[p.id] = { codexId: id, path: p.path, state: 'installed' };
        } catch (e) {
          this.log(`Couldn't install ${id} in Codex (plugin/install): ${message(e)}`);
          states[p.id] = { codexId: id, path: p.path, state: 'failed', error: userError(e) };
        }
      }
    }
    for (const d of deliver) {
      const { name } = /** @type {{name: string}} */ (parsePluginId(d.id));
      if (nativeNames.has(name)) states[d.id] = { codexId: codexId(d.id), path: d.path, state: 'alreadyOn' };
    }

    // what Codex has from our marketplaces that the store no longer gives it goes
    const wanted = new Set(
      Object.values(states)
        .filter((s) => s.state === 'installed')
        .map((s) => s.codexId),
    );
    const retainedMarkets = new Set();
    for (const id of installedHere.keys()) {
      if (wanted.has(id)) continue;
      try {
        await this.request('plugin/uninstall', { pluginId: id });
      } catch (e) {
        this.log(`Couldn't remove ${id} from Codex: ${message(e)}`);
        const { name, marketplace } = /** @type {{name: string, marketplace: string}} */ (parsePluginId(id));
        const storeId = pluginId(name, marketplace.slice(PREFIX.length));
        states[storeId] = { codexId: id, path: this.states[storeId]?.path ?? '', state: 'removeFailed', error: message(e) };
        retainedMarkets.add(marketplace);
      }
    }
    // and a Codex marketplace with nothing left in it is forgotten
    for (const name of registered.keys()) {
      const marketplace = name.slice(PREFIX.length);
      if (byMarketplace.get(marketplace)?.length || retainedMarkets.has(name)) continue;
      try {
        await this.request('marketplace/remove', { marketplaceName: name });
      } catch (e) {
        this.log(`Couldn't remove the ${name} marketplace from Codex: ${message(e)}`);
        continue;
      }
      const manifest = ownedManifestPath(this.dir(), marketplace);
      fs.rmSync(path.dirname(path.dirname(manifest)), { recursive: true, force: true });
    }
    // a derived copy outlives neither its plugin nor its marketplace, even one that was never registered with Codex
    const cache = path.join(this.dir(), 'cache');
    for (const marketplace of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
      if (!byMarketplace.get(marketplace)?.length) pruneDerived(path.join(cache, marketplace), new Set());
    }
    this.states = states;
    writeAtomic(this.stateFile(), JSON.stringify(states, null, 2));
    return true;
  }

  /**
   * The thread config fragment for a Codex thread: every plugin the mirror installed is switched off in a helper
   * thread, and in every thread while plugins.codex is off (until the next sync takes them out of Codex).
   */
  threadConfig({ helper = false } = {}) {
    // a thread MoPilot runs for itself (a title, a handoff note) never needs them
    if (this.enabled() && !helper) return {};
    const off = Object.values(this.states).filter((s) => s.state === 'installed' || s.state === 'removeFailed');
    return off.length ? { plugins: Object.fromEntries(off.map((s) => [s.codexId, { enabled: false }])) } : {};
  }
}

module.exports = { CodexPluginMirror, codexId, codexMarketplace };
