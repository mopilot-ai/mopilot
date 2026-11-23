// The marketplaces MoPilot's plugin store installs from (~/.mopilot/plugins/marketplaces): local folders and
// git sources in either vendor layout, added, upgraded and removed here, and a plugin entry fetched to a folder
// the store installs from. Git work happens in a staging folder that is renamed into place, so a failed fetch
// never leaves a half-written marketplace.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeAtomic, readStoreFile } = require('../platform/fsutil.cjs');
const { git } = require('../platform/gitRun.cjs');
const shellEnv = require('../platform/env.cjs');
const { readFirst, inside } = require('./read.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { isPluginName } = require('../../shared/plugins/manifest.mjs');
const { MARKETPLACE_FILES, readMarketplace, parseMarketplaceSource } = require('../../shared/plugins/marketplace.mjs');

const GIT_TIMEOUT_MS = 120_000;

/** git without a terminal to prompt on: a source that needs credentials fails instead of hanging. */
const runGit = (args, cwd) => git(args, cwd, GIT_TIMEOUT_MS, { ...shellEnv.gitEnv(), GIT_TERMINAL_PROMPT: '0' });

class Marketplaces {
  /**
   * @param {object} o
   * @param {() => string} o.dir ~/.mopilot/plugins
   * @param {string} o.home the user's home, for "~/" sources
   * @param {(args: string[], cwd: string) => Promise<{ok: boolean, stdout: string, stderr: string}>} [o.git]
   * @param {() => void} [o.onChange]
   * @param {() => number} [o.now]
   */
  constructor(o) {
    this.o = o;
    this.git = o.git ?? runGit;
    this.now = o.now ?? Date.now;
    this.chain = Promise.resolve();
  }

  knownFile() {
    return path.join(this.o.dir(), 'known.json');
  }
  clonesDir() {
    return path.join(this.o.dir(), 'marketplaces');
  }
  staging() {
    return path.join(this.o.dir(), `.staging-${crypto.randomUUID()}`);
  }

  readKnown() {
    const { data, error } = readStoreFile(this.knownFile(), 'the plugin marketplaces', isJsonRecord);
    return { known: error ? {} : (data ?? {}), error };
  }

  /** Run one change to known.json alone; an unreadable file is never written over. */
  mutate(action) {
    const run = async () => {
      const { known, error } = this.readKnown();
      if (error) throw new Error(`The marketplaces list couldn't be read, so it wasn't changed: ${error.message}`);
      const out = await action(known);
      if (out.known) {
        writeAtomic(this.knownFile(), JSON.stringify(out.known, null, 2));
        this.o.onChange?.();
      }
      return out.result;
    };
    // the next change waits for this one either way; its failure is the caller's, through `next`
    const next = this.chain.then(run, run);
    this.chain = next;
    return next;
  }

  /** A fresh shallow checkout of `url` at `ref` (a branch, tag or commit; the default branch without one) in `dir`. */
  async checkout(url, ref, dir) {
    await fs.promises.mkdir(dir, { recursive: true });
    for (const args of [
      ['init', '--quiet'],
      ['fetch', '--quiet', '--depth', '1', url, ref ?? 'HEAD'],
      ['checkout', '--quiet', '--detach', 'FETCH_HEAD'],
    ]) {
      const r = await this.git(args, dir);
      if (!r.ok) throw new Error(`git ${args[0]} failed for ${url}: ${r.stderr.trim() || 'no output'}`);
    }
  }

  /**
   * A marketplace folder's manifest, in either layout.
   * @returns {Promise<ReturnType<typeof readMarketplace>>}
   */
  async readAt(root) {
    const found = await readFirst(root, MARKETPLACE_FILES);
    if (!found) return { ok: false, error: 'No .claude-plugin/marketplace.json or .agents/plugins/marketplace.json' };
    return 'error' in found ? { ok: false, error: `${found.file}: ${found.error}` } : readMarketplace(found.text);
  }

  /** Where a known marketplace's files are. */
  rootOf(name, entry) {
    return entry.source.kind === 'local' ? entry.source.path : path.join(this.clonesDir(), name);
  }

  /** Add a marketplace from what the user typed; its name comes from its manifest. */
  add(input) {
    return this.mutate(async (known) => {
      const source = parseMarketplaceSource(input, this.o.home, process.platform);
      if (!source) throw new Error(`"${String(input)}" isn't a folder, owner/repo or git URL MoPilot can add`);
      if (source.kind === 'local') {
        const read = await this.readAt(source.path);
        if (!read.ok) throw new Error(read.error);
        const { name } = read.marketplace;
        if (known[name]) throw new Error(`A marketplace named "${name}" is already added`);
        return { known: { ...known, [name]: { source, addedAt: this.now() } }, result: name };
      }
      const stage = this.staging();
      try {
        await this.checkout(source.url, source.ref, stage);
        const read = await this.readAt(stage);
        if (!read.ok) throw new Error(read.error);
        const { name } = read.marketplace;
        if (known[name]) throw new Error(`A marketplace named "${name}" is already added`);
        await fs.promises.mkdir(this.clonesDir(), { recursive: true });
        await fs.promises.rm(path.join(this.clonesDir(), name), { recursive: true, force: true });
        await fs.promises.rename(stage, path.join(this.clonesDir(), name));
        return { known: { ...known, [name]: { source, addedAt: this.now(), updatedAt: this.now() } }, result: name };
      } finally {
        await fs.promises.rm(stage, { recursive: true, force: true });
      }
    });
  }

  /** Fetch a git marketplace again and swap it in; a local one is read in place and has nothing to fetch. */
  upgrade(name) {
    return this.mutate(async (known) => {
      const entry = known[name];
      if (!entry) throw new Error(`No marketplace named "${name}"`);
      if (entry.source.kind === 'local') return { result: false };
      const stage = this.staging();
      const dest = path.join(this.clonesDir(), name);
      const old = `${dest}.old-${crypto.randomUUID()}`;
      try {
        await this.checkout(entry.source.url, entry.source.ref, stage);
        const read = await this.readAt(stage);
        if (!read.ok) throw new Error(read.error);
        if (read.marketplace.name !== name) throw new Error(`The source is now named "${read.marketplace.name}", not "${name}"`);
        let moved = false;
        await fs.promises.rename(dest, old).then(
          () => {
            moved = true;
          },
          (e) => {
            if (e?.code !== 'ENOENT') throw e;
          },
        );
        try {
          await fs.promises.rename(stage, dest);
        } catch (e) {
          // the previous checkout goes back, so a failed swap leaves the marketplace as it was
          if (moved) await fs.promises.rename(old, dest);
          throw e;
        }
        return { known: { ...known, [name]: { ...entry, updatedAt: this.now() } }, result: true };
      } finally {
        await fs.promises.rm(stage, { recursive: true, force: true });
        await fs.promises.rm(old, { recursive: true, force: true });
      }
    });
  }

  /** Forget a marketplace; a clone MoPilot made is deleted, a local folder is left alone. */
  remove(name) {
    return this.mutate(async (known) => {
      const entry = known[name];
      if (!entry) return { result: false };
      if (entry.source.kind !== 'local') await fs.promises.rm(path.join(this.clonesDir(), name), { recursive: true, force: true });
      return { known: Object.fromEntries(Object.entries(known).filter(([k]) => k !== name)), result: true };
    });
  }

  /** Every known marketplace with its entries, or why it can't be read. */
  async catalog() {
    const { known, error } = this.readKnown();
    const out = [];
    for (const name of Object.keys(known).sort()) {
      const entry = known[name];
      const read = await this.readAt(this.rootOf(name, entry));
      out.push({
        name,
        source: entry.source,
        updatedAt: entry.updatedAt,
        ...(read.ok ? { marketplace: read.marketplace, error: null } : { marketplace: null, error: read.error }),
      });
    }
    return { marketplaces: out, error: error ? error.message : null };
  }

  /**
   * One entry's plugin as a local folder to install from, and `done()` to call once installed. A path inside the
   * marketplace is used in place; a git source is checked out into a staging folder that done() deletes.
   */
  async fetchPlugin(marketplace, pluginName) {
    if (!isPluginName(marketplace) || !isPluginName(pluginName)) throw new Error('Not a marketplace plugin');
    const { known } = this.readKnown();
    const entry = known[marketplace];
    if (!entry) throw new Error(`No marketplace named "${marketplace}"`);
    const root = this.rootOf(marketplace, entry);
    const read = await this.readAt(root);
    if (!read.ok) throw new Error(read.error);
    const plugin = read.marketplace.plugins.find((p) => p.name === pluginName);
    if (!plugin) throw new Error(`"${pluginName}" isn't in ${marketplace}`);
    const keep = async () => undefined;
    if (plugin.source.kind === 'path') {
      const dir = path.join(root, plugin.source.path);
      if (!(await inside(root, dir))) throw new Error(`"${pluginName}" points outside its marketplace`);
      return { dir, entry: plugin, done: keep };
    }
    const stage = this.staging();
    const done = () => fs.promises.rm(stage, { recursive: true, force: true });
    try {
      await this.checkout(plugin.source.url, plugin.source.sha ?? plugin.source.ref, stage);
      const dir = plugin.source.path ? path.join(stage, plugin.source.path) : stage;
      if (!(await inside(stage, dir))) throw new Error(`"${pluginName}" points outside its source`);
      return { dir, entry: plugin, done };
    } catch (e) {
      await done();
      throw e;
    }
  }
}

module.exports = { Marketplaces, runGit };
