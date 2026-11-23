// The wire declaration of `host.commands` (feature `commands`): the slash commands and skills an agent on this machine offers for a folder, the same list a chat of that agent on the machine's own app shows. A read: no epoch, no key. The app asks for it as a composer opens, whatever its chat's state, so a new chat has it too.
import { COMMANDS_FEATURE, COMMANDS_METHOD } from '../hostCommandsWire.mjs';

/** The harness ids the wire speaks (shared/host/schema.mjs). */
const HARNESS = /^(codex|claude|acp:[\w.-]{1,64})$/;

/** An absolute path on a POSIX or Windows Host. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** @param {{ bad: (message: string) => Error, pathOf: (v: unknown, what: string) => string }} kit */
export default ({ bad, pathOf }) => ({
  features: [COMMANDS_FEATURE],
  methods: {
    [COMMANDS_METHOD]: {
      access: /** @type {const} */ ('paired'),
      requires: [COMMANDS_FEATURE],
      parse: (/** @type {any} */ p) => {
        if (typeof p.harness !== 'string' || !HARNESS.test(p.harness)) throw bad('Name the agent to list the commands of.');
        if (p.cwd == null) return { harness: p.harness };
        const cwd = pathOf(p.cwd, 'a folder');
        // the agent reads the folder's own commands and skills: a path relative to the Host's process would name some other folder
        if (!ABSOLUTE.test(cwd)) throw bad('Pick a folder by its full path.');
        return { harness: p.harness, cwd };
      },
    },
  },
});
