// Start the Host on a machine that answers over ssh but whose Host does not (the row says "Host is not running"; Remote Run audit, rr-accept-kit J12b case A): the one command the installer starts the service with, run over the machine's own ssh, then every machine is asked again.
const { startCommand } = require('./install.cjs');

/** Picks the system's start command on the machine itself: a machine that never said what it runs is asked. */
const START = `if [ "$(uname -s)" = Darwin ]; then ${startCommand('Darwin')}; else ${startCommand('Linux')}; fi`;

/** A refusal with a `code` the window can act on. @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });

/**
 * @param {object} o
 * @param {{ list: () => import('./registry.cjs').HostRow[], check: () => Promise<unknown> }} o.registry
 * @param {(destination: string, command: string, input?: Buffer) => Promise<{ code: number, stdout: string, stderr: string }>} o.channel one command over ssh
 * @returns {(id: string) => Promise<void>} resolves once the start command ran and the machines were asked again; rejects with a `code` (`unknown_machine`, `no_ssh`, `needs_admin`, `start_failed`)
 */
function createHostStarter({ registry, channel }) {
  return async (id) => {
    const r = registry.list().find((x) => x.id === id);
    if (!r) throw refusal('That machine is not in the list.', 'unknown_machine');
    // a machine added by command is reached only through the relay: there is no ssh to start anything over
    if (r.address.startsWith('relay:'))
      throw refusal(`${r.name} is reached only through the relay: start its Host on the machine.`, 'no_ssh');
    // a Mac's Keep-running Host is a system service: only an administrator may start it
    if (r.platform === 'darwin' && r.startup.atBoot === 'yes')
      throw refusal(`${r.name}'s Host runs as a system service, so only its administrator can start it.`, 'needs_admin');
    const out = await channel(r.address, START);
    if (out.code !== 0) {
      const why = (out.stderr || out.stdout)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, 300);
      throw refusal(`Could not start the Host on ${r.name}${why ? `: ${why}` : '.'}`, 'start_failed');
    }
    await registry.check();
  };
}

module.exports = { createHostStarter, START };
