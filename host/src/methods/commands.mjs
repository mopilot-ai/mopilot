// The Host's handler for `host.commands` (feature `commands`): the slash commands and skills an agent on this machine offers for a folder. The protocol gives it the list's source; an embedder with none does not offer the feature.
import { UnsupportedError } from '../errors.mjs';

/** @param {{ commands?: (p: { harness: string, cwd?: string }) => Promise<unknown> }} deps what the protocol was given */
export default ({ commands }) => ({
  handlers: {
    'host.commands': (/** @type {{ harness: string, cwd?: string }} */ p) => {
      if (!commands) throw new UnsupportedError('This host lists no commands.');
      return commands(p);
    },
  },
});
