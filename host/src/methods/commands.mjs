// The Host's handler for `host.commands` (feature `commands`): the slash commands and skills an agent on this machine offers for a folder. The protocol gives it the list's source; an embedder with none does not offer the feature.
import { UnsupportedError } from '../errors.mjs';

/** @param {{ commands?: (p: { harness: string, cwd?: string }) => Promise<unknown>, hostFs?: { existingDirectory: (p: unknown) => Promise<string> } }} deps what the protocol was given */
export default ({ commands, hostFs }) => ({
  handlers: {
    'host.commands': (/** @type {{ harness: string, cwd?: string }} */ p) => {
      if (!commands) throw new UnsupportedError('This host lists no commands.');
      if (p.cwd === undefined || !hostFs) return commands(p);
      // the agent reads the folder's own commands and skills: the folder is a chat's own (not bound by the browsing roots, as a chat's folder never is) and never one of the Host's own; a folder that is not there lists the agent's own
      const harness = p.harness;
      return hostFs.existingDirectory(p.cwd).then(
        (cwd) => commands({ harness, cwd }),
        (error) => {
          if (error?.code === 'directory_missing') return commands({ harness });
          throw error;
        },
      );
    },
  },
});
