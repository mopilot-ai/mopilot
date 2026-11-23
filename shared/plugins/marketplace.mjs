// A plugin marketplace's manifest, in either vendor layout, as one list of entries: Claude Code's
// .claude-plugin/marketplace.json and Codex's .agents/plugins/marketplace.json. Pure; fetching and installing
// are electron/plugins/marketplaces.cjs.
import { isJsonRecord } from '../jsonRecord.mjs';
import { isPluginName, pluginRelative } from './manifest.mjs';

/** Where each layout keeps a marketplace's manifest, in the order they are tried. */
export const MARKETPLACE_FILES = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A git URL MoPilot fetches from: https or ssh only (no file:// or ext:: transports). */
export const isFetchableUrl = (url) => typeof url === 'string' && /^(https:\/\/[^\s]+|git@[\w.-]+:[^\s]+|ssh:\/\/[^\s]+)$/.test(url);

/** A git ref or commit given in a manifest: no option-like or path-escaping spellings. */
const safeRef = (ref) =>
  typeof ref === 'string' && /^[\w./-]{1,200}$/.test(ref) && !ref.startsWith('-') && !ref.includes('..') ? ref : undefined;

/**
 * Where an entry's plugin comes from: `{kind:'path', path}` inside the marketplace, or `{kind:'git', url, ref?,
 * sha?, path?}` (Claude's "url", "github" and "git-subdir" sources), or null with no usable source.
 */
export function entrySource(source) {
  if (typeof source === 'string') {
    const rel = pluginRelative(source);
    return rel ? { kind: 'path', path: rel } : null;
  }
  if (!isJsonRecord(source)) return null;
  if (source.source === 'local') {
    const rel = pluginRelative(source.path);
    return rel ? { kind: 'path', path: rel } : null;
  }
  const url =
    source.source === 'github' && /^[\w.-]+\/[\w.-]+$/.test(String(source.repo)) ? `https://github.com/${source.repo}.git` : source.url;
  if ((source.source !== 'url' && source.source !== 'git-subdir' && source.source !== 'github') || !isFetchableUrl(url)) return null;
  const sub = source.path === undefined ? undefined : pluginRelative(source.path);
  if (sub === null) return null;
  return { kind: 'git', url, ref: safeRef(source.ref), sha: safeRef(source.sha), path: sub };
}

/**
 * A marketplace manifest's text: its name and entries `{name, description, category, version, author, source}`.
 * Entries without a usable name or source are reported in `problems`, not dropped silently.
 */
export function readMarketplace(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'marketplace.json is not valid JSON' };
  }
  if (!isJsonRecord(raw) || !isPluginName(raw.name)) return { ok: false, error: 'marketplace.json has no usable name' };
  const plugins = [];
  const problems = [];
  for (const p of Array.isArray(raw.plugins) ? raw.plugins : []) {
    const source = isJsonRecord(p) ? entrySource(p.source) : null;
    if (!isJsonRecord(p) || !isPluginName(p.name) || !source) {
      problems.push(`Entry "${isJsonRecord(p) ? String(p.name) : '?'}" has no usable name or source`);
      continue;
    }
    const ui = isJsonRecord(p.interface) ? p.interface : {};
    plugins.push({
      name: p.name,
      description: str(p.description) ?? str(ui.shortDescription),
      category: str(p.category) ?? str(ui.category),
      version: str(p.version),
      author: isJsonRecord(p.author) ? str(p.author.name) : str(p.author),
      source,
    });
  }
  return { ok: true, marketplace: { name: raw.name, description: str(raw.description), plugins, problems } };
}

/**
 * What the user typed to add a marketplace: a local folder (absolute or ~/), "owner/repo" on GitHub, or a git URL
 * with an optional "#ref". On Windows (`platform` win32) a folder is also C:\… or \\server\share\…, and ~\ is home.
 * @param {unknown} input @param {string} home @param {string} [platform]
 */
export function parseMarketplaceSource(input, home, platform = '') {
  const s = String(input ?? '').trim();
  if (s.startsWith('/') || s.startsWith('~/')) return { kind: 'local', path: s.startsWith('~/') ? `${home}/${s.slice(2)}` : s };
  if (platform === 'win32') {
    if (/^[A-Za-z]:[\\/]|^\\\\[^\\]/.test(s)) return { kind: 'local', path: s };
    if (s.startsWith('~\\')) return { kind: 'local', path: `${home}\\${s.slice(2)}` };
  }
  const [base, ref] = s.split('#');
  const url = /^[\w.-]+\/[\w.-]+$/.test(base) ? `https://github.com/${base}.git` : base;
  if (!isFetchableUrl(url)) return null;
  if (ref && !safeRef(ref)) return null;
  return { kind: 'git', url, ref: ref || undefined };
}
