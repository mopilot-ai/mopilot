// What `host.commands` carries, for the Host that writes it and the app that reads it: the names the two ends share, the bounds, and the one shaping of a reported entry, so neither end can draw more than it agreed to.

export const COMMANDS_FEATURE = 'commands';
export const COMMANDS_METHOD = 'host.commands';
/** The most entries one answer lists; a folder with more shows its first. */
export const COMMANDS_MAX = 300;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 300;
const HINT_MAX = 120;

const text = (/** @type {unknown} */ v, /** @type {number} */ max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * One entry of the list: `name` without its trigger, what it does, the hint for its arguments, whether it is a command or a skill, and `insert`, the text the composer puts in the message for it (`/name ` for Claude Code and an ACP agent, `$name ` for a Codex skill).
 * @param {unknown} v
 * @returns {{ name: string, description: string, hint?: string, kind: 'command' | 'skill', insert: string } | null}
 */
export function commandEntry(v) {
  const o = /** @type {any} */ (v);
  const name = text(o?.name, NAME_MAX);
  if (!name || /[\s\0]/.test(name)) return null;
  const hint = text(o.hint, HINT_MAX);
  const insert = text(o.insert, NAME_MAX + 2);
  return {
    name,
    description: text(o.description, DESCRIPTION_MAX) ?? '',
    ...(hint ? { hint } : {}),
    kind: o.kind === 'skill' ? 'skill' : 'command',
    insert: `${insert ?? `/${name}`} `,
  };
}

/**
 * The answer as the app reads it: the bounded, shaped entries, or null when the Host sent something else. `listed: false` says the agent has no list to give yet (the menu then shows none, as a local chat of it does before it reports).
 * @param {unknown} v
 * @returns {{ listed: boolean, commands: NonNullable<ReturnType<typeof commandEntry>>[] } | null}
 */
export function readCommands(v) {
  const o = /** @type {any} */ (v);
  if (!o || typeof o.listed !== 'boolean' || !Array.isArray(o.commands)) return null;
  const seen = new Set();
  const commands = [];
  for (const raw of o.commands.slice(0, COMMANDS_MAX)) {
    const entry = commandEntry(raw);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    commands.push(entry);
  }
  return { listed: o.listed, commands };
}
