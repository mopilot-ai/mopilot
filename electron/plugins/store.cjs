// MoPilot's own plugin store, ~/.mopilot/plugins: a plugin installed once here is delivered to every
// harness (electron/plugins/delivery). installed.json says what is installed, enabled and trusted; each install
// is a fresh folder under cache/<marketplace>/<plugin>/, so a folder a running session loaded never changes.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeAtomic, writePrivate, readStoreFile } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { isPluginName, parsePluginId, pluginId, whatRuns, trustConfiguration } = require('../../shared/plugins/manifest.mjs');
const { readPlugin, inside, missing } = require('./read.cjs');

const STORE_VERSION = 1;
/** The harness families a plugin can be turned off for, one by one. */
const FAMILIES = ['codex', 'claude', 'acp'];

/** Trust keys the structured execution configuration, never its lossy display summary. */
const trustDigest = (spec) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(trustConfiguration(spec)))
    .digest('hex');

/** A record a store file may hold: anything else in the file is dropped on the next write. */
function validRecord(r) {
  return (
    isJsonRecord(r) &&
    typeof r.path === 'string' &&
    typeof r.enabled === 'boolean' &&
    typeof r.trusted === 'string' &&
    (r.harnesses === undefined || isJsonRecord(r.harnesses))
  );
}

/**
 * Copy a plugin folder into `dest`, without .git. Links are copied as what they point at, so the install doesn't
 * depend on the folder it came from (a git checkout is deleted right after); a link that leads out of the plugin
 * fails the copy, and a broken one is left out.
 */
async function copyPlugin(source, dest) {
  const filter = async (p) => {
    if (path.basename(p) === '.git') return false;
    if (!(await fs.promises.lstat(p)).isSymbolicLink()) return true;
    try {
      if (await inside(source, p)) return true;
    } catch (e) {
      if (missing(e)) return false;
      throw e;
    }
    throw new Error(`${path.relative(source, p)} links outside the plugin`);
  };
  await fs.promises.cp(source, dest, { recursive: true, dereference: true, filter });
}

/** A digest of every file under `dir`, by relative path, so any edit to a bundled plugin's text is noticed. */
function folderDigest(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else hash.update(path.relative(dir, full)).update('\0').update(fs.readFileSync(full)).update('\0');
    }
  };
  walk(dir);
  return hash.digest('hex');
}

/**
 * Copy a folder with plain reads and writes. A folder inside the app's asar can be read this way but not copied by
 * fs.cp, which goes around the asar layer.
 */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o755 });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dest = path.join(to, e.name);
    if (e.isDirectory()) copyTree(src, dest);
    else writePrivate(dest, fs.readFileSync(src));
  }
}

/** A folder name for one install: the version when it is a safe name, and a random suffix so it is never reused. */
const installFolder = (version) => `${isPluginName(version) ? version : 'local'}-${crypto.randomUUID().slice(0, 8)}`;

class PluginStore {
  /**
   * @param {object} o
   * @param {() => string} o.dir ~/.mopilot/plugins
   * @param {(ids: string[]) => void} [o.onChange] after any change, with the plugin ids it touched
   * @param {() => number} [o.now]
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    /** One chain for every mutation: they all rewrite installed.json. */
    /** @type {Promise<unknown>} */
    this.chain = Promise.resolve();
    /** Install folders a live session loaded, with how many sessions hold each. */
    this.inUse = new Map();
  }

  file() {
    return path.join(this.o.dir(), 'installed.json');
  }
  cacheDir(id) {
    const { name, marketplace } = /** @type {{name: string, marketplace: string}} */ (parsePluginId(id));
    return path.join(this.o.dir(), 'cache', marketplace, name);
  }

  /** The records, or an error when the file is there but unreadable (nothing is then written over it). */
  readRecords() {
    const { data, error } = readStoreFile(this.file(), 'the installed plugins', (d) => isJsonRecord(d) && isJsonRecord(d.plugins));
    if (error) return { records: {}, error };
    // a newer MoPilot wrote it: read nothing rather than rewrite it without what this one doesn't know
    if (typeof data?.version === 'number' && data.version > STORE_VERSION) {
      return { records: {}, error: new Error('A newer MoPilot saved the installed plugins. Update MoPilot to use them.') };
    }
    const records = {};
    for (const [id, r] of Object.entries(data?.plugins ?? {})) if (parsePluginId(id) && validRecord(r)) records[id] = r;
    return { records, error: null };
  }

  writeRecords(records) {
    writeAtomic(this.file(), JSON.stringify({ version: STORE_VERSION, plugins: records }, null, 2));
  }

  /** Run `action(records)` alone; what it returns as `records` is written, and `changed` ids are announced. */
  mutate(action) {
    const run = async () => {
      const { records, error } = this.readRecords();
      if (error) throw new Error(`The installed plugins list couldn't be read, so it wasn't changed: ${error.message}`);
      const out = await action(records);
      if (out.records) this.writeRecords(out.records);
      if (out.changed?.length) this.o.onChange?.(out.changed);
      return out.result;
    };
    return this.enqueue(run);
  }

  /** Reads that reserve folders share the mutation queue, so pruning cannot retire a selected copy. */
  /** @template T @param {() => Promise<T>} run @returns {Promise<T>} */
  enqueue(run) {
    const next = this.chain.then(run, run);
    this.chain = next;
    return next;
  }

  /** Select and retain one delivery snapshot before uninstall/reinstall can prune any selected folder. */
  reserveFor(family) {
    return this.enqueue(async () => {
      const selected = await this.enabledFor(family);
      this.hold(selected.deliver.map((entry) => entry.path));
      return selected;
    });
  }

  /**
   * What installing the plugin in `source` would bring: its spec and the trust digest the install must name.
   * The trust card shows `runs`; the install is refused if the folder changed since.
   */
  async preview(source) {
    const read = await readPlugin(source);
    if (!read.ok) return read;
    return { ok: true, spec: read.spec, runs: whatRuns(read.spec), trust: trustDigest(read.spec) };
  }

  /**
   * Install (or reinstall over) a plugin from a local folder, as `<name>@<marketplace>`. `trust` is the digest
   * the user accepted on the trust card for this folder; a folder whose commands differ is refused. The plugin's
   * on/off choices carry over a reinstall.
   */
  install(source, opts) {
    return this.mutate((records) => this.installOver(records, source, opts));
  }

  /** install()'s work, for a caller that already holds the mutation queue with `records` read. */
  async installOver(records, source, { marketplace, trust, origin }) {
    if (!isPluginName(marketplace)) throw new Error(`"${marketplace}" isn't a usable marketplace name`);
    // a folder that isn't a plugin says so before anything is copied
    const original = await readPlugin(source);
    if (!original.ok) throw new Error(original.error);
    const staging = path.join(this.o.dir(), 'cache', `.staging-${crypto.randomUUID()}`);
    let read;
    let dest;
    try {
      await copyPlugin(source, staging);
      // what is checked is the copy that will be installed, so the source changing meanwhile can't slip past
      read = await readPlugin(staging, original.spec.name);
      if (!read.ok || trustDigest(read.spec) !== trust)
        throw new Error('The plugin changed since you reviewed what it runs. Review it again.');
      dest = path.join(this.cacheDir(pluginId(read.spec.name, marketplace)), installFolder(read.spec.version));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.rename(staging, dest);
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
    const id = pluginId(read.spec.name, marketplace);
    const prev = records[id];
    const record = {
      path: dest,
      version: read.spec.version,
      enabled: prev?.enabled ?? true,
      harnesses: prev?.harnesses ?? {},
      trusted: trust,
      origin: origin ?? prev?.origin,
      installedAt: prev?.installedAt ?? this.now(),
      updatedAt: this.now(),
    };
    const next = { ...records, [id]: record };
    this.writeRecords(next);
    await this.prune(id, dest);
    return { changed: [id], result: { id, record } };
  }

  /**
   * Keep a plugin MoPilot ships (`source`, a folder in the app) installed as `<name>@<marketplace>`, origin
   * 'builtin', in step with the shipped files (builtin.json records the digest last installed). Nothing is touched
   * when the store or builtin.json can't be read, when a plugin the user installed holds the same id, or when the
   * user removed the bundled copy; a changed copy replaces the old install and keeps the user's on/off choices.
   * The decision and the install run as one mutation, so a change from the Plugins page can't interleave.
   * @returns {Promise<'installed' | 'current' | 'removed' | 'foreign' | 'unreadable'>}
   */
  async seedBundled(source, { name, marketplace }) {
    const id = pluginId(name, marketplace);
    const stateFile = path.join(this.o.dir(), 'builtin.json');
    // read in place: `source` is inside app.asar in a packaged app
    const digest = folderDigest(source);
    if (this.readRecords().error) return 'unreadable';
    return this.mutate(async (records) => {
      const { data: seeded, error } = readStoreFile(stateFile, 'the bundled plugins', isJsonRecord);
      const prior = typeof seeded?.[id] === 'string' ? seeded[id] : null;
      const record = records[id];
      if (record && record.origin !== 'builtin') return { result: 'foreign' };
      if (record && prior === digest) return { result: 'current' };
      if (!record && prior) return { result: 'removed' };
      // a state file that can't be read can't say whether the user removed it
      if (!record && error) return { result: 'unreadable' };
      // copied out of the asar with plain reads: fs.cp, which install uses, can't read inside it
      const staged = path.join(this.o.dir(), 'cache', `.bundled-${crypto.randomUUID()}`);
      try {
        copyTree(source, staged);
        const preview = await this.preview(staged);
        if (!preview.ok) throw new Error(`The bundled plugin couldn't be read: ${/** @type {{error: string}} */ (preview).error}`);
        if (preview.spec.name !== name) throw new Error(`The bundled plugin is named ${preview.spec.name}, not ${name}`);
        const out = await this.installOver(records, staged, { marketplace, trust: preview.trust, origin: 'builtin' });
        writeAtomic(stateFile, JSON.stringify({ ...seeded, [id]: digest }, null, 2));
        return { changed: out.changed, result: 'installed' };
      } finally {
        await fs.promises.rm(staged, { recursive: true, force: true });
      }
    });
  }

  /** Remove a plugin; its folders go once no session holds them. */
  uninstall(id) {
    return this.mutate(async (records) => {
      if (!records[id]) return { result: false };
      this.writeRecords(Object.fromEntries(Object.entries(records).filter(([k]) => k !== id)));
      await this.prune(id, null);
      return { changed: [id], result: true };
    });
  }

  /** Turn a plugin on or off everywhere, or (with `family`) for one harness family. */
  setEnabled(id, enabled, family) {
    return this.mutate(async (records) => {
      const r = records[id];
      if (!r) throw new Error(`${id} isn't installed`);
      if (family !== undefined && !FAMILIES.includes(family)) throw new Error(`Unknown harness family "${family}"`);
      const next = family === undefined ? { ...r, enabled } : { ...r, harnesses: { ...r.harnesses, [family]: enabled } };
      return { records: { ...records, [id]: next }, changed: [id], result: next };
    });
  }

  /** Every installed plugin with its spec (or why it can't be read), sorted by id. */
  async list() {
    const { records, error } = this.readRecords();
    // read fresh every time: the trust check must see what the folder holds now, not what it held once
    const plugins = await Promise.all(
      Object.keys(records)
        .sort()
        .map(async (id) => {
          const read = await readPlugin(records[id].path, /** @type {{name: string}} */ (parsePluginId(id)).name);
          return { id, ...records[id], spec: read.ok ? read.spec : null, error: read.ok ? null : read.error };
        }),
    );
    return { plugins, error: error ? error.message : null };
  }

  /**
   * The plugins a session of `family` gets: enabled, not turned off for the family, readable, and still running
   * exactly what the user trusted. Ones left out for a reason are returned in `withheld`, so nothing is dropped
   * silently.
   */
  async enabledFor(family) {
    const { plugins, error } = await this.list();
    const deliver = [];
    const withheld = [];
    for (const p of plugins) {
      if (!p.enabled || p.harnesses?.[family] === false) continue;
      if (!p.spec) withheld.push({ id: p.id, why: p.error });
      else if (trustDigest(p.spec) !== p.trusted) withheld.push({ id: p.id, why: 'What this plugin runs changed since you trusted it.' });
      else if (p.spec.execution?.plans[family]?.state === 'withheld')
        withheld.push({ id: p.id, why: p.spec.execution.plans[family].reasons.join(' ') });
      else deliver.push({ id: p.id, path: p.path, spec: p.spec });
    }
    return { deliver, withheld, error };
  }

  /** A session loaded these install folders: keep them until release() with the same list. */
  hold(folders) {
    for (const f of folders) this.inUse.set(f, (this.inUse.get(f) ?? 0) + 1);
  }
  /** The session ended: folders no session holds and no record names any more (replaced, uninstalled) go. */
  release(folders) {
    const freed = [];
    for (const f of folders) {
      const n = (this.inUse.get(f) ?? 0) - 1;
      if (n > 0) this.inUse.set(f, n);
      else if (this.inUse.delete(f)) freed.push(f);
    }
    if (!freed.length) return Promise.resolve();
    // the session is over either way: a folder that can't be cleaned now goes on the next install's prune
    return this.mutate(async (records) => {
      const current = new Set(Object.values(records).map((r) => r.path));
      for (const f of freed) {
        if (current.has(f) || this.inUse.has(f)) continue;
        await fs.promises.rm(f, { recursive: true, force: true });
      }
      return {};
    }).catch((e) => noteIgnored('clean up plugin folders a session released', e));
  }

  /** Delete a plugin's install folders other than `keep`, except ones a session holds. */
  async prune(id, keep) {
    const dir = this.cacheDir(id);
    let names = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const full = path.join(dir, n);
      if (full === keep || this.inUse.has(full)) continue;
      // the install or uninstall itself is done; a folder that can't go now goes on the next prune
      await fs.promises.rm(full, { recursive: true, force: true }).catch((e) => noteIgnored('remove an old plugin folder', e));
    }
  }
}

module.exports = { PluginStore, trustDigest, folderDigest, FAMILIES };
