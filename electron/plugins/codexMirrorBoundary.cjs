// Validate Codex marketplace responses before they authorize plugin removal or owned cache cleanup.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { lexicalInside } = require('../platform/pathInside.cjs');
const { isPluginName, parsePluginId } = require('../../shared/plugins/manifest.mjs');
const PREFIX = 'mopilot-';

function physical(file) {
  let current = path.resolve(file);
  const missing = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Dangling Codex marketplace path');
      missing.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
}

/** Missing leaves still belong to the physical ancestors that will receive writes or cleanup. */
function ownedManifestPath(directory, marketplace) {
  if (!isPluginName(marketplace)) throw new Error('Invalid Codex plugin marketplace name');
  const expected = path.join(physical(directory), 'cache', marketplace, '.agents', 'plugins', 'marketplace.json');
  if (physical(expected) !== expected) throw new Error('Redirected Codex plugin marketplace path');
  return expected;
}
/** `file` is under `root`, not `root` itself. */
const inside = (root, file) => path.resolve(root) !== path.resolve(file) && lexicalInside(root, file);

/** Only the exact, unredirected generated manifest can establish ownership of an app marketplace. */
function ownsMarketplace(market, root) {
  if (!market.name.startsWith(PREFIX)) return false;
  const suffix = market.name.slice(PREFIX.length);
  if (!isPluginName(suffix)) throw new Error('Invalid Codex plugin marketplace name');
  if (market.path == null) return false;
  if (typeof market.path !== 'string') throw new Error('Invalid Codex plugin marketplace path');
  const reported = physical(market.path);
  if (!inside(root, reported) && !inside(root, path.resolve(market.path))) return false;
  const expected = ownedManifestPath(root, suffix);
  if (reported !== expected || physical(expected) !== expected) throw new Error('Invalid owned Codex plugin marketplace path');
  for (const plugin of market.plugins) {
    const id = parsePluginId(plugin.id);
    if (!id || id.name !== plugin.name || id.marketplace !== market.name || typeof plugin.installed !== 'boolean')
      throw new Error('Invalid owned Codex plugin identity');
  }
  return true;
}

function readMarketplaces(response, directory) {
  if (!isJsonRecord(response) || !Array.isArray(response.marketplaces)) throw new Error('Invalid Codex plugin/list response');
  const root = physical(directory);
  const names = new Set();
  return response.marketplaces.map((row) => {
    if (!isJsonRecord(row) || typeof row.name !== 'string' || !Array.isArray(row.plugins ?? []))
      throw new Error('Invalid Codex marketplace response');
    const plugins = /** @type {any[]} */ (row.plugins ?? []);
    if (!plugins.every(isJsonRecord)) throw new Error('Invalid Codex marketplace plugins');
    const market = { ...row, name: row.name, plugins };
    const owned = ownsMarketplace(market, root);
    if (owned && names.has(market.name)) throw new Error('Duplicate owned Codex marketplace');
    if (owned) names.add(market.name);
    return /** @type {{name: string, path: string | null, plugins: any[], owned: boolean}} */ ({ ...market, owned });
  });
}

/** A successful add must identify the exact generated marketplace requested, without redirected roots. */
function addedMarketplacePath(response, directory, marketplace) {
  const manifest = ownedManifestPath(directory, marketplace);
  const expected = path.dirname(path.dirname(path.dirname(manifest)));
  if (
    !isJsonRecord(response) ||
    typeof response.installedRoot !== 'string' ||
    (response.marketplaceName !== undefined && response.marketplaceName !== PREFIX + marketplace) ||
    physical(response.installedRoot) !== expected ||
    physical(expected) !== expected
  )
    throw new Error('Invalid Codex marketplace/add response');
  return manifest;
}

module.exports = { readMarketplaces, addedMarketplacePath, ownedManifestPath };
