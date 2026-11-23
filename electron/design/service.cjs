// DesignService: a project's design systems and designs, kept as files (shared/designSystem.mjs), for the design tools
// on every harness. It lists the project's systems and the user's library (~/.mopilot/design-systems), picks the one a
// call means, reads files only from inside a system's folder, checks a system or design, and compiles a project system's
// _ds_manifest.json, one compile at a time per folder. Every read is fresh from disk; equal reads in flight are shared.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { readSystem, readHead } = require('./systemRead.cjs');
const { absentAsNull, byName } = require('./scan.cjs');
const { lexicalInside, realInside, realPathAsync } = require('../platform/pathInside.cjs');
const { writeAtomic } = require('../platform/fsutil.cjs');
const {
  DEFAULT_SYSTEMS_DIR,
  DEFAULT_DESIGNS_DIR,
  DESIGN_INDEX,
  MANIFEST,
  LIMITS,
  TEXT_EXTS,
  checkDesignIndex,
  isRelativeInside,
} = require('../../shared/designSystem.mjs');

/** A refusal with a fixed code the tools pass on: not_found, ambiguous, invalid, outside, too_large, read_only. */
class DesignError extends Error {
  constructor(/** @type {string} */ message, /** @type {string} */ code) {
    super(message);
    this.code = code;
  }
}

/** `fsp[how](p)`, or null when nothing is there; any other failure is thrown. */
const statOrNull = (/** @type {string} */ p, fsp, how = 'stat') => fsp[how](p).catch(absentAsNull);
const exists = async (/** @type {string} */ p, fsp) => !!(await statOrNull(p, fsp));
/** A path as the tools write it: forward slashes on every platform (design.json, isRelativeInside). */
const posix = (/** @type {string} */ p) => p.split(path.sep).join('/');
/** What a model reads about a folder that could not be read. */
const unreadable = (/** @type {string} */ at, /** @type {unknown} */ err) =>
  `${at} could not be read (${/** @type {Error} */ (err).message}), so it is left out.`;

class DesignService {
  /** @param {{ userDir: string, fsp?: typeof fs.promises }} o userDir: the user's library of systems */
  constructor(o) {
    this.userDir = o.userDir;
    this.fsp = o.fsp ?? fs.promises;
    /** @type {Map<string, Promise<any>>} real root -> the read in flight */
    this.reads = new Map();
    /** @type {Map<string, Promise<any>>} real root -> the last compile queued */
    this.compiles = new Map();
  }

  /** Where `cwd` keeps its systems and designs: .mopilot/design.json, else the defaults; what is wrong with it, in words. */
  async config(/** @type {string} */ cwd) {
    /** @type {{ systems: string[], designs: string, default: string | null, problems: string[] }} */
    const out = { systems: [DEFAULT_SYSTEMS_DIR], designs: DEFAULT_DESIGNS_DIR, default: null, problems: [] };
    const read = await readHead(path.join(cwd, '.mopilot', 'design.json'), LIMITS.file, this.fsp);
    if (!read) return out;
    let json;
    try {
      json = JSON.parse(read.text);
    } catch {
      out.problems.push('.mopilot/design.json is not valid JSON, so the default folders are used.');
      return out;
    }
    const systems = Array.isArray(json?.systems) ? json.systems.filter(isRelativeInside) : null;
    if (systems?.length) out.systems = systems;
    else if (json?.systems !== undefined) out.problems.push('.mopilot/design.json "systems" must list folders relative to the project.');
    if (isRelativeInside(json?.designs)) out.designs = json.designs;
    if (typeof json?.default === 'string' && json.default) out.default = json.default;
    return out;
  }

  /** The system at `root` (a real path), read once for every caller asking while the read runs. */
  system(/** @type {string} */ root) {
    const running = this.reads.get(root);
    if (running) return running;
    const read = readSystem(root, { fsp: this.fsp }).finally(() => this.reads.delete(root));
    this.reads.set(root, read);
    return read;
  }

  /**
   * The system folders directly in `dir` (one with a README.md or tokens.json), by real path. A folder that can't be
   * read is left out and named in `problems`, so one bad folder never hides the others.
   * @param {string} dir
   * @param {string[]} problems
   */
  async foldersIn(dir, problems) {
    // `dir` is a real path the caller just resolved: a failure to list it is reported, not read as empty
    const entries = await this.fsp.readdir(dir, { withFileTypes: true });
    const roots = [];
    for (const e of entries.sort(byName)) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      try {
        if ((await exists(path.join(full, 'README.md'), this.fsp)) || (await exists(path.join(full, 'tokens.json'), this.fsp)))
          roots.push(full);
      } catch (err) {
        problems.push(unreadable(full, err));
      }
    }
    return roots;
  }

  /**
   * The project's systems and the user's library, each with its card and problem counts; `default` marks the one a
   * call without a name means. Ids are `<scope>:<folder name>`, or `<scope>:<path>` for a second folder of that name.
   * @param {string | null} cwd the chat's folder (null: the library only)
   */
  async list(cwd) {
    const config = cwd ? await this.config(cwd) : null;
    /** @type {string[]} */
    const problems = [...(config?.problems ?? [])];
    /** @type {{ scope: 'project' | 'user', root: string, at: string }[]} */
    const entries = [];
    const project = cwd ? await realPathAsync(cwd) : null;
    for (const dir of config?.systems ?? []) {
      // a systems folder that is a link out of the project is not the project's
      const real = project ? await realInside(project, path.join(project, dir)) : null;
      if (real)
        for (const root of await this.foldersIn(real, problems))
          entries.push({ scope: 'project', root, at: posix(path.relative(/** @type {string} */ (project), root)) });
    }
    const library = await realPathAsync(this.userDir);
    if (library) for (const root of await this.foldersIn(library, problems)) entries.push({ scope: 'user', root, at: root });
    const read = await Promise.all(
      entries.map(async (e) => {
        try {
          return { e, s: await this.system(e.root) };
        } catch (err) {
          problems.push(unreadable(e.at, err));
          return null;
        }
      }),
    );
    const seen = new Set();
    const listed = [];
    for (const r of read) {
      if (!r) continue;
      const slug = path.basename(r.e.root);
      const id = seen.has(`${r.e.scope}:${slug}`) ? `${r.e.scope}:${r.e.at}` : `${r.e.scope}:${slug}`;
      seen.add(id);
      listed.push({
        id,
        slug,
        name: r.s.name,
        scope: r.e.scope,
        root: r.e.root,
        path: r.e.at,
        cards: r.s.cards.length,
        problems: r.s.problems.length,
      });
    }
    const own = listed.filter((s) => s.scope === 'project');
    const fallback = own.find((s) => s.slug === config?.default) ?? (own.length === 1 ? own[0] : null);
    return {
      systems: listed.map((s) => ({ ...s, default: s === fallback })),
      systemsDir: config?.systems[0] ?? DEFAULT_SYSTEMS_DIR,
      designs: config?.designs ?? DEFAULT_DESIGNS_DIR,
      problems,
    };
  }

  /**
   * `slug`, or the first of `slug-2`, `slug-3`, … with no folder at `cwd/dir/` yet; `taken` when `slug` itself was.
   * @param {string} cwd
   * @param {string} dir
   * @param {string} slug
   */
  async freeSlug(cwd, dir, slug) {
    let n = 1;
    let s = slug;
    while (await exists(path.join(cwd, dir, s), this.fsp)) {
      n += 1;
      s = `${slug}-${n}`;
    }
    return { slug: s, taken: n > 1 };
  }

  /**
   * The system a call means: `ref` (an id, a folder name, or a path), else the project's default.
   * @param {string | null} cwd
   * @param {string | undefined} ref
   * @param {Awaited<ReturnType<DesignService['list']>> | null} [listed] a listing of `cwd` the caller already has
   */
  async resolve(cwd, ref, listed = null) {
    const { systems } = listed ?? (await this.list(cwd));
    const names = systems.map((s) => s.id).join(', ');
    let hit;
    if (ref) {
      const want = String(ref).trim();
      const real = cwd ? await realPathAsync(path.resolve(cwd, want)) : path.isAbsolute(want) ? await realPathAsync(want) : null;
      hit =
        systems.find((s) => s.id === want) ??
        systems.find((s) => s.slug === want && s.scope === 'project') ??
        systems.find((s) => s.slug === want) ??
        systems.find((s) => real && s.root === real);
      if (!hit)
        throw new DesignError(`No design system "${want}".${names ? ` There are: ${names}.` : ' There are none yet.'}`, 'not_found');
    } else {
      hit = systems.find((s) => s.default);
      if (!hit && !systems.length)
        throw new DesignError(
          'This project has no design system yet. Make one with design_quickstart type "design-system", or go on without one.',
          'not_found',
        );
      if (!hit) throw new DesignError(`Say which design system: ${names}.`, 'ambiguous');
    }
    return { entry: hit, system: await this.system(hit.root) };
  }

  /**
   * One text file of a system, by its path in the system's folder, clipped at the read limit.
   * @param {{ root: string }} system
   * @param {string} rel
   */
  async read(system, rel) {
    const want = String(rel ?? '').replace(/^\.\//, '');
    if (!isRelativeInside(want))
      throw new DesignError(`${JSON.stringify(rel)} is not a path inside the design system's folder.`, 'outside');
    if (!TEXT_EXTS.includes(path.extname(want).toLowerCase()))
      throw new DesignError(`Only text files are read here (${TEXT_EXTS.join(' ')}).`, 'invalid');
    const real = await realInside(system.root, path.join(system.root, want));
    if (!real) throw new DesignError(`No file ${want} in the design system.`, 'not_found');
    const read = await readHead(real, LIMITS.file, this.fsp);
    if (!read) throw new DesignError(`${want} could not be read.`, 'not_found');
    return { path: want, text: read.text, clipped: read.clipped };
  }

  /**
   * What is wrong with a design system or a design (a folder with design.json) at `p`, in the project or the library.
   * @param {string | null} cwd
   * @param {string} p
   */
  async check(cwd, p) {
    // a projectless chat names library folders, so a relative path is taken in the library
    const full = path.resolve(cwd ?? this.userDir, String(p));
    let dir = path.basename(full) === DESIGN_INDEX ? path.dirname(full) : full;
    const allowed = [cwd, this.userDir].filter(Boolean);
    const roots = (await Promise.all(allowed.map((a) => realInside(/** @type {string} */ (a), dir)))).filter(Boolean);
    if (!roots.length) throw new DesignError(`${p} is not a folder inside this chat's project or the design-system library.`, 'outside');
    dir = /** @type {string} */ (roots[0]);
    if (!(await this.fsp.stat(dir)).isDirectory()) throw new DesignError(`No folder at ${p}.`, 'not_found');
    const index = await readHead(path.join(dir, DESIGN_INDEX), LIMITS.file, this.fsp);
    if (index) return { kind: 'design', ...(await this.checkDesign(cwd, dir, index.text)) };
    const s = await this.system(dir);
    return { kind: 'system', name: s.name, cards: s.cards.length, manifest: s.manifestState, problems: s.problems };
  }

  /** A design's design.json (its text), its pages and the systems it names. */
  async checkDesign(/** @type {string | null} */ cwd, /** @type {string} */ dir, /** @type {string} */ text) {
    /** @type {any} */
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { title: null, type: null, pages: 0, problems: ['design.json is not valid JSON.'] };
    }
    const problems = checkDesignIndex(json);
    const pages = Array.isArray(json?.pages) ? json.pages.filter(isRelativeInside) : [];
    for (const page of pages)
      if (!(await realInside(dir, path.join(dir, page)))) problems.push(`Page ${page} is listed in design.json but not in the folder.`);
    for (const ds of Array.isArray(json?.designSystems) ? json.designSystems : []) {
      const at = typeof ds?.path === 'string' && cwd && isRelativeInside(ds.path) ? await realInside(cwd, path.join(cwd, ds.path)) : null;
      if (typeof ds?.path === 'string' && !at) problems.push(`Design system ${ds.path} is not a folder in this project.`);
    }
    return { title: typeof json?.title === 'string' ? json.title : null, type: json?.type ?? null, pages: pages.length, problems };
  }

  /**
   * Writes the project system's _ds_manifest.json from its cards when it differs, after any compile of it already queued.
   * @param {{ root: string }} system
   * @param {string} cwd the chat's folder: only a system inside it is written
   */
  compile(system, cwd) {
    const root = system.root;
    // the queue holds a promise that never rejects: the caller gets the failure, the next compile still runs
    const prior = this.compiles.get(root) ?? Promise.resolve();
    const run = prior.then(() => this.compileNow(root, cwd));
    const settle = () => {
      if (this.compiles.get(root) === tail) this.compiles.delete(root);
    };
    const tail = run.then(settle, settle);
    this.compiles.set(root, tail);
    return run;
  }

  async compileNow(/** @type {string} */ root, /** @type {string} */ cwd) {
    const project = await realPathAsync(cwd);
    if (!project || !lexicalInside(project, root))
      throw new DesignError("Only a design system inside this chat's project folder is compiled here.", 'outside');
    // a fresh read, not one that started before the edit this compile follows
    const s = await readSystem(root, { fsp: this.fsp });
    const text = `${JSON.stringify(s.manifest, null, 2)}\n`;
    const file = path.join(root, MANIFEST);
    const link = await statOrNull(file, this.fsp, 'lstat');
    if (link?.isSymbolicLink()) throw new DesignError(`${MANIFEST} is a link; it was not replaced.`, 'outside');
    if (s.manifestState === 'current') return { written: false, cards: s.cards.length, problems: s.problems };
    writeAtomic(file, text);
    return { written: true, cards: s.cards.length, problems: s.problems.filter((p) => !p.startsWith(MANIFEST)) };
  }
}

module.exports = { DesignService, DesignError };
