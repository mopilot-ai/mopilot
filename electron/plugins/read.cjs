// Reads one plugin folder from disk into a PluginSpec (shared/plugins/manifest.mjs): its manifest in either
// vendor layout, and the skills, commands, agents, hooks, MCP/LSP servers and app connectors it carries.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const {
  MANIFEST_FILES,
  DEFAULT_LSP,
  isPluginName,
  readManifest,
  markdownComponent,
  normalizeMcpServers,
  normalizeHooks,
  normalizeApps,
} = require('../../shared/plugins/manifest.mjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { lexicalInside } = require('../platform/pathInside.cjs');
const { readExecution, sourceInventory } = require('./sourcePlans.cjs');

const missing = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
/** fs and JSON.parse only throw Errors */
const message = (e) => /** @type {Error} */ (e).message;

/**
 * The first of `files` (paths under `root`) that exists: its name and text, or why it couldn't be read, or null
 * when none is there. Plugin and marketplace manifests each have one such file per vendor layout.
 * @returns {Promise<{file: string, text: string} | {file: string, error: string} | null>}
 */
async function readFirst(root, files) {
  for (const file of files) {
    try {
      return { file, text: await fs.promises.readFile(path.join(root, file), 'utf8') };
    } catch (e) {
      if (!missing(e)) return { file, error: message(e) };
    }
  }
  return null;
}

/** Whether `child` is `parent` or inside it, after following links. */
async function inside(parent, child) {
  const [p, c] = await Promise.all([fs.promises.realpath(parent), fs.promises.realpath(child)]);
  return lexicalInside(p, c);
}

/** A folder's entries, or none when it doesn't exist. */
async function entries(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (missing(e)) return [];
    throw e;
  }
}

/** Skills: a folder per skill holding SKILL.md, under each skills root (a linked folder counts, as for Claude Code). */
async function readSkills(root, dirs) {
  const out = [];
  for (const dir of dirs) {
    for (const e of await entries(path.join(root, dir))) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const file = path.join(root, dir, e.name, 'SKILL.md');
      try {
        out.push(markdownComponent(await fs.promises.readFile(file, 'utf8'), e.name, file));
      } catch (err) {
        if (!missing(err)) throw err;
      }
    }
  }
  return out;
}

/**
 * Commands and agents: markdown files under each root, nested folders named "folder:file" as Claude Code does.
 * A link is followed to what it points at; a broken one is skipped.
 */
async function readMarkdown(root, dirs) {
  const out = [];
  const walk = async (dir, prefix) => {
    for (const e of await entries(dir)) {
      const full = path.join(dir, e.name);
      /** @type {{isDirectory(): boolean, isFile(): boolean}} */
      let kind = e;
      if (e.isSymbolicLink()) {
        try {
          kind = await fs.promises.stat(full);
        } catch (err) {
          if (!missing(err)) throw err;
          continue;
        }
      }
      if (kind.isDirectory()) await walk(full, `${prefix}${e.name}:`);
      else if (kind.isFile() && e.name.endsWith('.md')) {
        out.push(markdownComponent(await fs.promises.readFile(full, 'utf8'), `${prefix}${e.name.slice(0, -3)}`, full));
      }
    }
  };
  for (const dir of dirs) await walk(path.join(root, dir), '');
  return out;
}

/**
 * A JSON component (hooks, MCP servers, apps): every inline object and file the manifest lists, in order. The
 * default file may be absent; a file the manifest names that isn't there, or doesn't parse, is a problem.
 */
async function readJsonComponents(
  root,
  source,
  problems,
  inventory = /** @type {Awaited<ReturnType<typeof sourceInventory>> | undefined} */ (undefined),
) {
  const out = [];
  for (const entry of source.entries) {
    if ('inline' in entry) {
      out.push(entry.inline);
      continue;
    }
    if (inventory) {
      const found = await inventory.read(entry.file);
      if (found.state === 'read') out.push(found.raw);
      else if (!(found.state === 'absent' && source.optional))
        problems.push(`${entry.file}: ${found.state === 'absent' ? 'not found' : found.error}`);
      continue;
    }
    try {
      out.push(JSON.parse(await fs.promises.readFile(path.join(root, entry.file), 'utf8')));
    } catch (e) {
      if (!(missing(e) && source.optional)) problems.push(`${entry.file}: ${missing(e) ? 'not found' : message(e)}`);
    }
  }
  return out;
}

/** LSP defaults load first, then declared sources in order. Retain complete records for disclosure and trust. */
async function readLspServers(root, source) {
  const problems = [];
  const configs = await readJsonComponents(root, { entries: [{ file: DEFAULT_LSP }], optional: true }, problems);
  if (!source.optional) configs.push(...(await readJsonComponents(root, source, problems)));
  if (problems.length) throw new Error(`LSP configuration couldn't be read: ${problems.join('; ')}`);
  const entries = [];
  for (const config of configs) {
    if (!isJsonRecord(config)) throw new Error('LSP configuration must be a JSON object mapping server names to configurations.');
    // Do not project to known fields: a native folder loader can interpret fields MoPilot doesn't yet know.
    entries.push(...Object.entries(config));
  }
  return Object.fromEntries(entries);
}

/**
 * The manifest: the first layout present; a folder with neither is a manifest-less plugin named after itself.
 * @returns {Promise<ReturnType<typeof readManifest> & { projectionError?: string }>}
 */
async function readManifestFile(root, fallbackName, inventory) {
  const source = MANIFEST_FILES.map((file) => inventory.files.get(file)).find((entry) => entry.state !== 'absent');
  const found = !source
    ? null
    : source.state === 'read'
      ? { file: source.source, text: JSON.stringify(source.raw) }
      : { file: source.source, error: source.error };
  if (found) {
    /** @type {ReturnType<typeof readManifest>} */
    const primary =
      'error' in found
        ? { ok: false, error: found.error === 'invalid JSON' ? 'plugin.json is not valid JSON' : `${found.file}: ${found.error}` }
        : readManifest(found.text, found.file);
    if (primary.ok) return primary;
    const alternate = inventory.files.get(MANIFEST_FILES[1]);
    if (found.file === MANIFEST_FILES[0] && alternate.state === 'read') {
      const fallback = readManifest(JSON.stringify(alternate.raw), alternate.source);
      if (fallback.ok) return { ...fallback, projectionError: primary.error };
    }
    return primary;
  }
  const name = fallbackName ?? path.basename(root);
  return isPluginName(name)
    ? readManifest(JSON.stringify({ name }), 'none')
    : { ok: false, error: 'No .claude-plugin/plugin.json or .codex-plugin/plugin.json' };
}

/**
 * The plugin in `root`, or why it can't be read.
 * @param {string} root
 * @param {string | undefined} [fallbackName] admitted identity for a manifestless installed copy
 * @returns {Promise<{ok: true, spec: import('../../shared/plugins/manifest.mjs').PluginSpec} | {ok: false, error: string}>}
 */
async function readPlugin(root, fallbackName = undefined) {
  /** @type {import('node:fs').Stats | null} */
  let stat = null;
  try {
    stat = await fs.promises.stat(root);
  } catch (e) {
    if (!missing(e)) return { ok: false, error: `${root}: ${message(e)}` };
  }
  if (!stat?.isDirectory()) return { ok: false, error: `${root} isn't a plugin folder` };
  const inventory = await sourceInventory(root);
  const read = await readManifestFile(root, fallbackName, inventory);
  if (!read.ok) return read;
  const { skills, commands, agents, hooks, mcpServers, lspServers, apps, problems: found, ...meta } = read.manifest;
  const problems = [...found];
  try {
    let servers = {};
    for (const json of await readJsonComponents(root, mcpServers, problems, inventory)) {
      const mcp = normalizeMcpServers(json, root);
      servers = Object.fromEntries([...Object.entries(servers), ...Object.entries(mcp.servers)]);
      problems.push(...mcp.problems);
    }
    /** @type {import('../../shared/plugins/manifest.mjs').PluginSpec} */
    const spec = {
      ...meta,
      root,
      skills: await readSkills(root, skills),
      commands: await readMarkdown(root, commands),
      agents: await readMarkdown(root, agents),
      hooks: (await readJsonComponents(root, hooks, problems, inventory)).flatMap((json) => normalizeHooks(json, root)),
      mcpServers: servers,
      lspServers: await readLspServers(root, lspServers),
      apps: [...new Set((await readJsonComponents(root, apps, problems)).flatMap((json) => normalizeApps(json)))].sort(),
      problems,
    };
    spec.execution = await readExecution(root, spec, { mcpServers, projectionError: read.projectionError }, inventory);
    return { ok: true, spec };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

module.exports = { readPlugin, readFirst, inside, missing };
