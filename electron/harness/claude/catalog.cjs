// Claude Code's slash-command catalog per account and folder (design commandLayer rules[10]), kept from what sessions report and sent to the windows.
const path = require('node:path');
const os = require('node:os');
const { scanSkills, skillRoots } = require('./skills.cjs');
const { noteIgnored } = require('../../ignored.cjs');

// Claude's commands for a folder and account (design commandLayer rules[10]): supportedCommands()
// with aliases, the skills and plugins in system/init, terminal_slash_commands to leave out, and
// commands_changed replacing the list. Kept per (account, cwd); a live session's list wins over a
// prefetch. Every change goes to the windows.
const catalogKey = (account, cwd) => `${account}\u0000${cwd}`;
const slashCommand = (c) => ({
  name: c.name,
  description: c.description ?? '',
  argumentHint: c.argumentHint ?? '',
  aliases: c.aliases ?? [],
  builtin: !!c.builtin,
});

/** Merge what the CLI reported into the folder's catalog; null when nothing changed. */
function mergeCatalog(prev, m) {
  const next = {
    commands: prev?.commands ?? [],
    skills: prev?.skills ?? [],
    plugins: prev?.plugins ?? [],
    terminalSlash: prev?.terminalSlash ?? null,
    live: !!prev?.live,
  };
  if (m.commands) next.commands = m.commands.map(slashCommand);
  if (m.skills) next.skills = m.skills.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
  if (m.plugins) next.plugins = m.plugins.map((x) => ({ name: x.name, path: x.path ?? null }));
  if (m.terminalSlash) next.terminalSlash = m.terminalSlash;
  if (m.live) next.live = true;
  return JSON.stringify(next) === JSON.stringify(prev) ? null : next;
}

/**
 * @param {import('./state.cjs').ClaudeState} state
 * @param {{ auth: ReturnType<typeof import('./auth.cjs').createAuth>, queries: ReturnType<typeof import('./queries.cjs').createQueries> }} deps
 */
function createCatalog(state, { auth, queries }) {
  const catalogs = new Map();

  function setCatalog(account, cwd, m) {
    const k = catalogKey(account, cwd);
    const next = mergeCatalog(catalogs.get(k), m);
    if (!next) return catalogs.get(k);
    catalogs.set(k, next);
    state.broadcastCatalog({ account, cwd, catalog: next });
    return next;
  }

  /** init carries skills, plugins and the terminal-only commands; the commands come from supportedCommands. */
  function noteCatalog(s, msg) {
    // whether this process has the Artifact tool (the artifacts capability's session layer, electron/session/caps.cjs)
    if (Array.isArray(msg.tools)) s.artifactTool = msg.tools.includes('Artifact');
    if (!s.cwd) return;
    if (msg.subtype === 'commands_changed') return void setCatalog(s.account, s.cwd, { commands: msg.commands ?? [], live: true });
    setCatalog(s.account, s.cwd, {
      skills: msg.skills,
      plugins: msg.plugins,
      terminalSlash: msg.terminal_slash_commands ?? null,
      live: true,
    });
    if (s.commandsRead) return;
    s.commandsRead = true;
    // the catalog keeps the init message's commands
    Promise.resolve(s.q.supportedCommands?.())
      .then((commands) => commands && state.sessions.get(s.key) === s && setCatalog(s.account, s.cwd, { commands }))
      .catch((error) => noteIgnored("read a Claude Code session's commands", error));
  }

  /** The catalog for a folder, prefetched with initializationResult() when no session has run there yet. */
  async function catalog(bin, cwd, account) {
    account = account ?? state.activeAccount();
    const have = catalogs.get(catalogKey(account, cwd));
    if (have) return have;
    const x = await queries.extras(bin, cwd, account);
    // skills only arrive with a session's init message; until one runs, read them from disk
    const configDir = auth.cleanEnv(account).CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return setCatalog(account, cwd, { commands: x.commands, skills: scanSkills(skillRoots(configDir, cwd)) });
  }

  return { setCatalog, noteCatalog, catalog };
}

module.exports = { createCatalog, slashCommand, mergeCatalog };
