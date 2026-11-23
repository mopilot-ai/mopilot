// A plugin's manifest, in either vendor layout, as one PluginSpec every harness adapter reads: Claude Code's
// .claude-plugin/plugin.json (which Codex also installs natively) and Codex's .codex-plugin/plugin.json.
// Pure: the main-process reader (electron/plugins/read.cjs) lists the files and hands their text here.
import { isJsonRecord } from '../jsonRecord.mjs';

/** Where each layout keeps its manifest, in the order they are tried: Claude's first, the shared format. */
export const MANIFEST_FILES = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];

/** The folders a component kind lives in when the manifest doesn't name its own. */
export const DEFAULT_DIRS = { skills: ['skills'], commands: ['commands'], agents: ['agents'] };
export const DEFAULT_HOOKS = 'hooks/hooks.json';
export const DEFAULT_MCP = '.mcp.json';
export const DEFAULT_LSP = '.lsp.json';
export const DEFAULT_APPS = '.app.json';

/** A plugin or marketplace name both vendors accept: letters, digits, dot, dash and underscore. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const isPluginName = (name) => typeof name === 'string' && NAME.test(name);

/** "<plugin>@<marketplace>", the id both vendors key installed plugins by. */
export const pluginId = (name, marketplace) => `${name}@${marketplace}`;

/** The name and marketplace of an id, or null when it isn't one. */
export function parsePluginId(id) {
  if (typeof id !== 'string') return null;
  const at = id.lastIndexOf('@');
  const name = id.slice(0, at);
  const marketplace = id.slice(at + 1);
  return at > 0 && isPluginName(name) && isPluginName(marketplace) ? { name, marketplace } : null;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A relative path inside the plugin ("./skills/" → "skills"), or null for one that leaves it. */
export function pluginRelative(p) {
  if (typeof p !== 'string') return null;
  const parts = p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.');
  if (!parts.length || p.startsWith('/') || /^[a-z]:/i.test(p) || parts.includes('..')) return null;
  return parts.join('/');
}

/** One path or a list of them, as relative paths (outside ones dropped and reported). */
function relList(v, field, problems) {
  const list = Array.isArray(v) ? v : [v];
  const out = [];
  for (const p of list) {
    const rel = pluginRelative(p);
    if (rel) out.push(rel);
    else problems.push(`${field}: "${String(p)}" is not a path inside the plugin`);
  }
  return out;
}

/**
 * A manifest's text, parsed and normalized. `layout` says which file it came from. Component locations are
 * relative paths; hooks, MCP servers and apps are `{entries, optional}`, each entry a file or an object given
 * inline (normalizeHooks / normalizeMcpServers read them); `optional` marks the default file, which may be absent.
 */
export function readManifest(text, layout) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'plugin.json is not valid JSON' };
  }
  if (!isJsonRecord(raw)) return { ok: false, error: 'plugin.json is not a JSON object' };
  if (!isPluginName(raw.name)) return { ok: false, error: 'plugin.json has no usable name' };
  const problems = [];
  const ui = isJsonRecord(raw.interface) ? raw.interface : {};
  const author = isJsonRecord(raw.author) ? str(raw.author.name) : str(raw.author);
  const dirs = (kind) => (raw[kind] === undefined ? DEFAULT_DIRS[kind] : relList(raw[kind], kind, problems));
  // one path, one inline object, or a list of either (every one is read: what each runs must reach the trust card)
  const sources = (v, fallback, field) => {
    if (v === undefined) return { entries: [{ file: fallback }], optional: true };
    const entries = [];
    for (const item of Array.isArray(v) ? v : [v]) {
      if (isJsonRecord(item)) entries.push({ inline: item });
      else for (const file of relList(item, field, problems)) entries.push({ file });
    }
    return { entries, optional: false };
  };
  const lspServers = sources(raw.lspServers, DEFAULT_LSP, 'lspServers');
  // A discarded LSP source could still be read by the harness from the complete plugin folder.
  if (problems.length) return { ok: false, error: problems.join('; ') };
  if (layout === '.codex-plugin/plugin.json' && raw.lspServers !== undefined)
    return {
      ok: false,
      error: 'lspServers in .codex-plugin/plugin.json cannot be delivered. Use .lsp.json or .claude-plugin/plugin.json.',
    };
  return {
    ok: true,
    manifest: {
      layout,
      name: raw.name,
      version: str(raw.version),
      description: str(raw.description) ?? str(ui.shortDescription),
      displayName: str(ui.displayName) ?? raw.name,
      category: str(ui.category) ?? str(raw.category),
      author: author ?? str(ui.developerName),
      homepage: str(raw.homepage),
      logo: pluginRelative(ui.logo) ?? undefined,
      skills: dirs('skills'),
      commands: dirs('commands'),
      agents: dirs('agents'),
      hooks: sources(raw.hooks, DEFAULT_HOOKS, 'hooks'),
      mcpServers: sources(raw.mcpServers, DEFAULT_MCP, 'mcpServers'),
      lspServers,
      apps: sources(raw.apps, DEFAULT_APPS, 'apps'),
      problems,
    },
  };
}

/**
 * The front matter fields of a markdown component (SKILL.md, a command, an agent): simple `key: value`
 * lines, quoted values unquoted, and `>`/`|` blocks joined. Anything richer is left to the harness.
 */
export function frontMatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(String(text));
  const out = {};
  if (!m) return out;
  let block = null;
  for (const line of m[1].split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) {
      const value = field[2].trim();
      block = /^[>|][-+]?$/.test(value) ? field[1] : null;
      out[field[1]] = block ? '' : value.replace(/^(["'])(.*)\1$/, '$2');
    } else if (block && /^\s+\S/.test(line)) {
      out[block] = out[block] ? `${out[block]} ${line.trim()}` : line.trim();
    }
  }
  return out;
}

/** A markdown component: its name (front matter, else the file or folder name) and description. */
export function markdownComponent(text, fallbackName, file) {
  const fm = frontMatter(text);
  return { name: str(fm.name) ?? fallbackName, description: str(fm.description), file };
}

/** "${CLAUDE_PLUGIN_ROOT}" (and Codex's "${PLUGIN_ROOT}") replaced with where the plugin is installed. */
export const expandRoot = (s, root) => (typeof s === 'string' ? s.replace(/\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/g, root) : s);

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const stringMap = (v) => (isJsonRecord(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) : {});

/**
 * MCP servers from a .mcp.json (`{mcpServers:{…}}`) or an inline manifest object (the servers themselves).
 * Each is `{type:'stdio', command, args, env}`, `{type:'http'|'sse', url, headers}`, or `{type:'other', raw}` for
 * any other shape (also reported in `problems`).
 */
export function normalizeMcpServers(json, root) {
  const servers = isJsonRecord(json) && isJsonRecord(json.mcpServers) ? json.mcpServers : isJsonRecord(json) ? json : {};
  const out = [];
  const problems = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!isJsonRecord(s)) {
      problems.push(`MCP server "${name}" is not an object`);
      continue;
    }
    const env = Object.fromEntries(Object.entries(stringMap(s.env)).map(([k, v]) => [k, expandRoot(v, root)]));
    if (typeof s.command === 'string' && (s.type === undefined || s.type === 'stdio')) {
      out.push([name, { type: 'stdio', command: expandRoot(s.command, root), args: strings(s.args).map((a) => expandRoot(a, root)), env }]);
    } else if (typeof s.url === 'string' && (s.type === 'http' || s.type === 'sse' || s.type === undefined)) {
      out.push([name, { type: s.type === 'sse' ? 'sse' : 'http', url: s.url, headers: stringMap(s.headers) }]);
    } else {
      // kept, not dropped: a harness that loads the folder itself may still start it, so it must be on the trust card
      out.push([name, { type: 'other', raw: JSON.stringify(s) }]);
      problems.push(`MCP server "${name}" isn't a local command or an http/sse URL`);
    }
  }
  return { servers: Object.fromEntries(out), problems };
}

/**
 * Hook commands from a hooks.json (`{hooks:{Event:[{matcher, hooks:[{type:'command', command}]}]}}`) or an
 * inline manifest object: one `{event, matcher, command}` each, so the trust card can list what will run.
 */
export function normalizeHooks(json, root) {
  const events = isJsonRecord(json) && isJsonRecord(json.hooks) ? json.hooks : isJsonRecord(json) ? json : {};
  const out = [];
  for (const [event, groups] of Object.entries(events)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of isJsonRecord(g) && Array.isArray(g.hooks) ? g.hooks : []) {
        if (isJsonRecord(h) && typeof h.command === 'string') {
          out.push({ event, matcher: str(g.matcher), command: expandRoot(h.command, root) });
        }
      }
    }
  }
  return out;
}

/** Codex app connectors from a .app.json (`{apps:{name:{id}}}`): their names. */
export function normalizeApps(json) {
  const apps = isJsonRecord(json) && isJsonRecord(json.apps) ? json.apps : {};
  return Object.keys(apps).sort();
}

/**
 * What installing a plugin lets run on this Mac, one line each, sorted: local MCP server commands, remote MCP
 * URLs and hook commands, with the plugin's own folder written as ${PLUGIN_ROOT}. This is a display summary;
 * trustConfiguration retains the structured execution fields, including argv boundaries, environment and headers.
 */
export function whatRuns(spec) {
  // where the plugin sits is not what it runs: the same plugin trusted from a marketplace keeps its trust installed
  const rooted = (line) => (spec.root ? line.split(spec.root).join('${PLUGIN_ROOT}') : line);
  const out = [];
  if (!spec.execution) {
    for (const [name, s] of Object.entries(spec.mcpServers ?? {})) {
      out.push(
        s.type === 'stdio'
          ? `mcp ${name}: ${[s.command, ...s.args].join(' ')}`
          : s.type === 'other'
            ? `mcp ${name}: ${s.raw}`
            : `mcp ${name}: ${s.type} ${s.url}`,
      );
    }
    for (const h of spec.hooks ?? []) out.push(`hook ${h.event}${h.matcher ? ` (${h.matcher})` : ''}: ${h.command}`);
  }
  const summary = out.map(rooted);
  // Keep the whole LSP record visible, including argv boundaries and fields this reader doesn't interpret.
  for (const [name, config] of Object.entries(spec.lspServers ?? {})) summary.push(`lsp ${name}: ${JSON.stringify(config)}`);
  if (spec.execution) {
    for (const [family, plan] of Object.entries(spec.execution.plans)) {
      summary.push(`${family}: ${plan.contract} (${plan.layout})`);
      for (const source of plan.sources) {
        if (source.state !== 'read') continue;
        const label = `${family} ${source.component} ${source.source}`;
        summary.push(`${label}: ${JSON.stringify(source.raw)}`);
        if (source.numberTokens && Object.keys(source.numberTokens).length)
          summary.push(`${label} numeric tokens: ${JSON.stringify(source.numberTokens)}`);
      }
      for (const reason of plan.reasons) summary.push(`${family} withheld: ${reason}`);
      for (const ignored of plan.ignored) summary.push(`${family}: ${ignored}`);
    }
  }
  return summary.sort();
}

/** Structured execution identity for trust; display strings cannot preserve argv or configuration boundaries. */
export function trustConfiguration(spec) {
  const canonical = (value, normalizeRoot = true) => {
    if (typeof value === 'string') return normalizeRoot && spec.root ? value.split(spec.root).join('${PLUGIN_ROOT}') : value;
    if (Array.isArray(value)) return value.map((entry) => canonical(entry, normalizeRoot));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key], normalizeRoot)]),
      );
    return value;
  };
  return {
    ...(spec.execution
      ? {
          execution: canonical(
            {
              version: spec.execution.version,
              inventory: spec.execution.inventory,
              plans: Object.fromEntries(
                Object.entries(spec.execution.plans).map(([family, { mcpServers, hooks, ...identity }]) => [family, identity]),
              ),
            },
            false,
          ),
        }
      : {}),
    ...canonical({
      name: spec.name,
      layout: spec.layout,
      ...(spec.execution ? {} : { mcpServers: spec.mcpServers ?? {}, hooks: spec.hooks ?? [] }),
      apps: spec.apps ?? [],
    }),
    // LSP stays raw on read: rewriting its strings would alias literal placeholders with absolute paths.
    // Omit empty LSP so existing non-LSP approvals keep their exact digest.
    ...(Object.keys(spec.lspServers ?? {}).length ? { lspServers: canonical(spec.lspServers, false) } : {}),
  };
}
