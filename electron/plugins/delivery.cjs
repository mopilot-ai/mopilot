// Delivers the plugin store's plugins (electron/plugins/store.cjs) to a session as it starts, in each harness
// family's own form: Claude Code loads each plugin folder through the Agent SDK's `plugins` option; a basic-tier
// (ACP) session gets the plugins' MCP servers in session/new's mcpServers. Each delivery holds the folders it
// handed out until the session ends, and says what it left out and why.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parsePluginId } = require('../../shared/plugins/manifest.mjs');
const { componentReach, REACH_WHY } = require('../../shared/plugins/reach.mjs');
const { agentSkillText } = require('../../shared/plugins/agentSkill.mjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { readJsonRecord } = require('../platform/fsutil.cjs');
const { inside } = require('./read.cjs');

/** The most of one skill or command file a tool call returns. */
const READ_LIMIT = 256 * 1024;

/** The kind a component list is offered as. */
const KIND_LABEL = { skills: 'skill', commands: 'command', agents: 'agent' };

/** Why a plugin's server a session doesn't get is still reachable there. */
const GATEWAY_RUNS = "MoPilot's MCP gateway runs this server for every chat, under your rules.";

/** Nothing delivered: a session started with this needs no release. */
const NONE = Object.freeze({ release: () => Promise.resolve(), withheld: [] });

/** Claude Code's managed (policy) settings file on this platform, which overrides every other layer. */
function managedSettingsFile(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return 'C:\\ProgramData\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

/**
 * The plugin ids Claude Code itself turns on for an account and folder: enabledPlugins in its user, project, local
 * and managed settings, each layer overriding the ones before it.
 */
function claudeNativePlugins(configDir, cwd, managed = managedSettingsFile()) {
  const files = [path.join(configDir, 'settings.json')];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  files.push(managed);
  const on = new Map();
  // later files override earlier ones, as Claude Code layers user, project and local settings
  for (const file of files) {
    const enabled = readJsonRecord(file)?.enabledPlugins;
    if (isJsonRecord(enabled)) for (const [id, v] of Object.entries(enabled)) on.set(id, v === true);
  }
  return new Set([...on].filter(([, v]) => v).map(([id]) => id));
}

/** An MCP server name for a plugin's server, unique across plugins and safe as a tool-name prefix. */
const serverName = (pluginId, name) =>
  `plugin_${createHash('sha256')
    .update(JSON.stringify([pluginId, name]))
    .digest('base64url')}`;

/** A plugin's MCP server in ACP's McpServer shape (env and headers as [{name, value}]). */
function acpServer(name, s) {
  const pairs = (o) => Object.entries(o).map(([k, value]) => ({ name: k, value }));
  return s.type === 'stdio'
    ? { name, command: s.command, args: s.args, env: pairs(s.env) }
    : { type: s.type, name, url: s.url, headers: pairs(s.headers) };
}

class PluginDelivery {
  /**
   * @param {object} o
   * @param {{ reserveFor(family: string): Promise<{deliver: {id: string, path: string, spec: any}[], withheld: {id: string, why: string}[], error: string | null}>,
   *           enabledFor(family: string): Promise<any>, hold(folders: string[]): void, release(folders: string[]): Promise<void> }} o.store
   * @param {(family: string) => boolean} [o.enabled] the family's remote switch (plugins.<family>)
   * @param {(configDir: string, cwd: string | undefined) => Set<string>} [o.claudeNative]
   * @param {string} [o.home]
   * @param {() => Promise<unknown>} [o.ready] settles once the built-in plugin is in the store (never rejects)
   */
  constructor(o) {
    this.store = o.store;
    this.enabled = o.enabled ?? (() => true);
    this.claudeNative = o.claudeNative ?? claudeNativePlugins;
    this.home = o.home ?? require('node:os').homedir();
    this.ready = o.ready ?? (() => Promise.resolve());
    /** Native delivery capability by harness family and stable chat, with replacement ownership. */
    this.down = new Map();
    /** @type {Map<string, () => Set<string>>} per family, the plugins its native delivery failed for */
    this.failedBy = new Map();
    /** @type {((entry: unknown) => boolean) | null} whether the MCP gateway runs a plugin's server in its place (#2999 C4, app/gatewayWiring.cjs) */
    this.managed = null;
  }

  /**
   * The plugins a session of `family` gets, held until `release()`. A switched-off family gets none; a store that
   * can't be read gets none and says so in `withheld`.
   */
  async take(family) {
    if (!this.enabled(family)) return { deliver: [], ...NONE };
    await this.ready();
    const { deliver, withheld, error } = await this.store.reserveFor(family);
    const folders = deliver.map((d) => d.path);
    let released = false;
    const release = () => {
      if (released) return Promise.resolve();
      released = true;
      return this.store.release(folders);
    };
    return { deliver, release, withheld: error ? [...withheld, { id: '*', why: error }] : withheld };
  }

  /**
   * Claude Code: each plugin folder for the SDK's `plugins` option. A plugin Claude Code already turns on for this
   * account or folder (by name, from any marketplace) is left to it, so it never loads twice.
   * @param {{ configDir?: string, cwd?: string }} o the account's CLAUDE_CONFIG_DIR (else ~/.claude) and the folder
   */
  async forClaude({ configDir, cwd } = {}) {
    const taken = await this.take('claude');
    const native = taken.deliver.length ? this.claudeNative(configDir || path.join(this.home, '.claude'), cwd) : new Set();
    // by name too: the same plugin from another marketplace would load its skills and servers under the same names
    const nativeNames = new Set([...native].map((id) => parsePluginId(id)?.name));
    const plugins = [];
    const alreadyOn = [];
    for (const d of taken.deliver) {
      if (nativeNames.has(d.spec.name)) alreadyOn.push(d.id);
      else plugins.push({ type: /** @type {const} */ ('local'), path: d.path });
    }
    return { plugins, alreadyOn, release: taken.release, withheld: taken.withheld };
  }

  /**
   * A basic-tier session: the plugins' MCP servers for session/new, in the transports the agent accepts (stdio
   * unless its quirks say otherwise, http and sse as its initialize advertised). A server it can't take is withheld
   * with the reason the Plugins page shows.
   * @param {{ mcp?: { http?: boolean, sse?: boolean }, stdio?: boolean }} o
   */
  async forAcp({ mcp = {}, stdio = true } = {}) {
    const taken = await this.take('acp');
    const mcpServers = [];
    const withheld = [...taken.withheld];
    for (const d of taken.deliver) {
      for (const [name, s] of Object.entries(d.spec.execution?.plans.acp.mcpServers ?? d.spec.mcpServers)) {
        const accepts = { stdio, http: s.type === 'sse' ? !!mcp.sse : !!mcp.http };
        const r = componentReach({ kind: 'mcpServers', name, transport: s.type }, 'acp', accepts);
        // the gateway runs it for every chat (under the user's rules): the session doesn't get a copy of its own
        if (this.managed?.(s) === true) withheld.push({ id: d.id, why: `${name}: ${GATEWAY_RUNS}` });
        else if (r.reach === 'native') mcpServers.push(acpServer(serverName(d.id, name), s));
        else withheld.push({ id: d.id, why: `${name}: ${REACH_WHY[/** @type {string} */ (r.why)]}` });
      }
    }
    return { mcpServers, release: taken.release, withheld };
  }

  /**
   * Whether this chat's session can load plugins here right now (a Claude Code CLI without --plugin-dir
   * can't): while it can't, MoPilot provides their skills and commands to it as to the basic tier.
   */
  markNative(family, ok, chatId = '') {
    const key = JSON.stringify([family, chatId]);
    const capability = { ok };
    this.down.set(key, capability);
    const release = () => {
      if (this.down.get(key) === capability) this.down.delete(key);
    };
    return Object.assign(release, {
      fail: () => {
        if (this.down.get(key) === capability) capability.ok = false;
      },
    });
  }

  /** `ids()`: the plugins whose native delivery to `family` failed (the Codex mirror's failed installs). */
  reportFailures(family, ids) {
    this.failedBy.set(family, ids);
  }

  /**
   * The skills and commands of the plugins a `family` session gets that MoPilot itself must provide: the harness
   * doesn't load plugin skills (shared/plugins/reach.mjs: 'mopilot'), or would but can't here (markNative) or didn't
   * get this plugin (reportFailures). Identified by the full plugin id, component kind and component name. Nothing is held:
   * each is read when asked for.
   * An agent is offered as a skill-like entry (kind 'agent'): readSkill returns its instructions as a skill's text.
   * @returns {Promise<{name: string, kind: 'skill' | 'command' | 'agent', description?: string, file: string}[]>}
   */
  async skillsFor(family, chatId = '') {
    if (!this.enabled(family)) return [];
    await this.ready();
    const { deliver } = await this.store.enabledFor(family);
    const failed = this.failedBy.get(family)?.() ?? new Set();
    const out = [];
    for (const d of deliver) {
      const missed = this.down.get(JSON.stringify([family, chatId]))?.ok === false || failed.has(d.id);
      for (const kind of /** @type {const} */ (['skills', 'commands', 'agents'])) {
        for (const c of d.spec[kind]) {
          const reach = componentReach({ kind, name: c.name }, family).reach;
          if (reach !== 'mopilot' && !(reach === 'native' && missed)) continue;
          const label = KIND_LABEL[kind];
          out.push({ name: `${d.id}:${label}:${c.name}`, kind: label, description: c.description, file: c.file });
        }
      }
    }
    return out;
  }

  /**
   * One of skillsFor's entries, read: its markdown, or (`file`) a file the skill keeps next to its SKILL.md. A path
   * that leaves the skill's folder, or a file too large to return, is refused.
   */
  async readSkill(family, name, file, chatId = '') {
    const entry = (await this.skillsFor(family, chatId)).find((s) => s.name === name);
    if (!entry) throw new Error(`No plugin skill or command named "${name}" here`);
    let target = entry.file;
    if (file) {
      if (entry.kind !== 'skill') throw new Error('Only a skill keeps files of its own');
      target = path.resolve(path.dirname(entry.file), String(file));
      if (!(await inside(path.dirname(entry.file), target))) throw new Error(`"${file}" isn't inside the ${name} skill`);
    }
    const { size } = await fs.promises.stat(target);
    if (size > READ_LIMIT) throw new Error(`"${path.basename(target)}" is too large to read here (${size} bytes)`);
    const text = await fs.promises.readFile(target, 'utf8');
    return {
      name,
      file: target,
      text: entry.kind === 'agent' ? agentSkillText(name.slice(name.indexOf(':agent:') + ':agent:'.length), text) : text,
    };
  }
}

module.exports = { PluginDelivery, claudeNativePlugins, managedSettingsFile, serverName, acpServer, READ_LIMIT };
