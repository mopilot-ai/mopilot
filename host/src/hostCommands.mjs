// What an agent on this machine offers in its `/` menu for a folder (`host.commands`): Claude Code's own catalog (its commands and skills), Codex's skills for the folder, nothing for an ACP agent (its live session pushes its list on the chat's stream). One list per agent, shaped as `shared/host/hostCommandsWire.mjs` says, so the app draws it with the menu a chat of that agent has on the app's own computer.
import { claudeSkipped } from '../../shared/claudeSlash.mjs';
import { COMMANDS_MAX, commandEntry } from '../../shared/host/hostCommandsWire.mjs';
export { codexSkills } from './codexSkills.mjs';

/** How long an agent gets to say its list: a menu that is opening must not wait for a slow CLI. */
const READ_MS = 8000;

/** Claude's catalog (`{ commands, skills, terminalSlash }`, electron/harness/claude/catalog.cjs) as entries: the commands the CLI runs from text, never the terminal-only ones. @param {any} catalog */
export function claudeEntries(catalog) {
  const skip = claudeSkipped(Array.isArray(catalog?.terminalSlash) ? catalog.terminalSlash : []);
  const skills = new Set(Array.isArray(catalog?.skills) ? catalog.skills : []);
  return (Array.isArray(catalog?.commands) ? catalog.commands : [])
    .filter((/** @type {any} */ c) => typeof c?.name === 'string' && !skip.has(c.name))
    .map((/** @type {any} */ c) =>
      commandEntry({
        name: c.name,
        description: c.description,
        hint: c.argumentHint,
        kind: skills.has(c.name) ? 'skill' : 'command',
        insert: `/${c.name}`,
      }),
    );
}

/** `skills/list`'s answer for a folder as entries: the enabled skills, a project's winning over the user's of the same name; a Codex skill is mentioned as `$name`. @param {any} listed */
export function codexEntries(listed) {
  const rank = (/** @type {string} */ scope) => (scope === 'repo' ? 0 : scope === 'user' ? 1 : 2);
  /** @type {Map<string, any>} */
  const byName = new Map();
  for (const d of Array.isArray(listed?.data) ? listed.data : [])
    for (const k of Array.isArray(d?.skills) ? d.skills : []) {
      if (typeof k?.name !== 'string' || k.enabled === false) continue;
      const prev = byName.get(k.name);
      if (!prev || rank(k.scope) < rank(prev.scope)) byName.set(k.name, k);
    }
  return [...byName.values()].map((k) =>
    commandEntry({ name: k.name, description: k.shortDescription || k.description, kind: 'skill', insert: `$${k.name}` }),
  );
}

/** @param {Promise<any>} p @param {number} ms */
const within = (p, ms) => {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

/**
 * @param {object} o
 * @param {((cwd: string | undefined) => Promise<any>) | null} [o.claude] Claude Code's catalog for a folder, null when this Host has none
 * @param {((cwd: string | undefined) => Promise<any>) | null} [o.codex] Codex's `skills/list` answer for a folder, null when this Host has none
 * @param {(note: string) => void} [o.report]
 * @param {number} [o.timeoutMs] how long an agent gets to answer
 * @returns {(p: { harness: string, cwd?: string }) => Promise<{ listed: boolean, commands: object[] }>}
 */
export function createHostCommands({ claude = null, codex = null, report = () => undefined, timeoutMs = READ_MS }) {
  const sources = /** @type {Record<string, { read: ((cwd: string | undefined) => Promise<any>) | null, entries: (v: any) => any[] }>} */ ({
    claude: { read: claude, entries: claudeEntries },
    codex: { read: codex, entries: codexEntries },
  });
  return async ({ harness, cwd }) => {
    const source = sources[harness];
    // an ACP agent's commands come with its live session (`available_commands_update` on the chat's stream); there is none to read before one runs
    if (!source?.read) return { listed: false, commands: [] };
    try {
      const entries = source.entries(await within(source.read(cwd), timeoutMs)).filter(Boolean);
      return { listed: true, commands: entries.slice(0, COMMANDS_MAX) };
    } catch (error) {
      report(`Could not read the commands of ${harness}: ${error instanceof Error ? error.message : String(error)}`);
      return { listed: false, commands: [] };
    }
  };
}
