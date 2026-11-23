// Plugins a harness installed itself, outside MoPilot's store: Claude Code's (installed_plugins.json) and
// Codex's own (its plugin cache), for the Plugins page's "Make available everywhere", which copies one into the
// store so every harness gets it. MoPilot's own mirror in Codex and Codex's bundled plugins aren't listed.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { readJsonRecord } = require('../platform/fsutil.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { parse } = require('smol-toml');
const { parsePluginId } = require('../../shared/plugins/manifest.mjs');

/** Codex marketplaces that ship with Codex itself, or are MoPilot's own mirror: nothing to make available. */
const NOT_THE_USERS = (marketplace) =>
  marketplace.startsWith('mopilot-') || marketplace === 'openai-bundled' || marketplace === 'openai-primary-runtime';

const isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;

/** Claude Code's installed plugins: each id's first install that is still on disk. */
function claudeInstalled(claudeDir) {
  const plugins = readJsonRecord(path.join(claudeDir, 'plugins', 'installed_plugins.json'))?.plugins;
  if (!isJsonRecord(plugins)) return [];
  const out = [];
  for (const [id, installs] of Object.entries(plugins)) {
    const parsed = parsePluginId(id);
    const found = (Array.isArray(installs) ? installs : []).find(
      (i) => isJsonRecord(i) && typeof i.installPath === 'string' && isDir(i.installPath),
    );
    if (parsed && found) out.push({ id, ...parsed, path: found.installPath, harness: 'claude' });
  }
  return out;
}

/** The entries of a folder, or none. */
const list = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
};

/**
 * The plugins Codex's config.toml says are installed ([plugins."<name>@<marketplace>"]): its cache can keep a
 * plugin the user has since uninstalled. No config is none installed; one that doesn't parse is an error.
 */
function codexConfigured(codexHome) {
  let text;
  try {
    text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return new Set();
    throw e;
  }
  const plugins = /** @type {Record<string, unknown>} */ (parse(text)).plugins;
  return new Set(isJsonRecord(plugins) ? Object.keys(plugins) : []);
}

/** Codex's own installed plugins: <cache>/<marketplace>/<plugin>/<version>, the newest version of each. */
function codexInstalled(codexHome) {
  const cache = path.join(codexHome, 'plugins', 'cache');
  const configured = codexConfigured(codexHome);
  const out = [];
  for (const m of list(cache)) {
    if (NOT_THE_USERS(m.name)) continue;
    for (const p of list(path.join(cache, m.name))) {
      const versions = list(path.join(cache, m.name, p.name)).map((v) => path.join(cache, m.name, p.name, v.name));
      const newest = versions.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      const parsed = parsePluginId(`${p.name}@${m.name}`);
      if (newest && parsed && configured.has(`${p.name}@${m.name}`))
        out.push({ id: `${p.name}@${m.name}`, ...parsed, path: newest, harness: 'codex' });
    }
  }
  return out;
}

/**
 * Every plugin a harness installed itself, once per id (Claude Code's first: Codex often holds a copy of the same
 * Claude marketplace's plugin).
 * @returns {{id: string, name: string, marketplace: string, path: string, harness: 'claude' | 'codex'}[]}
 */
function nativePlugins({ claudeDir, codexHome }) {
  const seen = new Set();
  const out = [];
  for (const p of [...claudeInstalled(claudeDir), ...codexInstalled(codexHome)]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { nativePlugins, NOT_THE_USERS };
