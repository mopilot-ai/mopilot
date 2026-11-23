// Keep running after restart, for a Mac added over SSH: turns the machine's Host from the user's login agent into a system daemon that starts at boot as that user (shared/host/launchDaemon.mjs), and back. The administrator password the person types goes only to `sudo -S` on the machine's standard input, over an ssh that never prompts and checks the machine's host key; it is never kept, logged or put on a command line. Root runs only the scripts launchDaemon.mjs builds from system tools; everything else runs as the user. A person who would rather run it at the machine gets the same root script as one command.
const { createSshChannel } = require('./sshChannel.cjs');
const { identityArgs } = require('./sshKey.cjs');
const { HOST_CLI, startCommand } = require('./install.cjs');
const { asRoot, daemonPlist, refuse, sudoRefusal, turnOn } = require('./daemonInstall.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { sudoCommand, turnOffScript, turnOnScript } = require('../../shared/host/launchDaemon.mjs');

/** Exits 0 when the user has a GUI session (someone signed in at the machine as them). */
const SIGNED_IN = 'launchctl print "gui/$(id -u)" >/dev/null 2>&1';
/** What the turn-off command prints when the agent waits for a sign-in to start. */
const AT_SIGN_IN = 'starts-at-sign-in';

/** How long the Host has to answer as the service it now is. */
const VERIFY_TRIES = 15;
const VERIFY_WAIT_MS = 1000;

/**
 * @param {object} o
 * @param {{ list: () => import('./registry.cjs').HostRow[] }} o.registry
 * @param {() => NodeJS.ProcessEnv} [o.env]
 * @param {(record: { address: string, identity: string }, command: string, input?: Buffer) => Promise<{ code: number, stdout: string, stderr: string }>} [o.run] one command over ssh, never prompting
 * @param {(ms: number) => Promise<void>} [o.wait]
 */
function createStartAtBoot({
  registry,
  env = () => process.env,
  run = (record, command, input) =>
    createSshChannel({ env, timeoutMs: 60_000, sshArgs: identityArgs(record.identity) })(record.address, command, input),
  wait = (ms) => new Promise((resolve) => clock.setTimeout(resolve, ms)),
}) {
  /** One change per machine at a time. @type {Set<string>} */
  const busy = new Set();

  /** @param {string} id */
  function machine(id) {
    const r = registry.list().find((x) => x.id === id);
    if (!r) throw refuse('unknown_machine', 'That machine is not in the registry.');
    // a machine added by command is reached only through the relay: there is no SSH to run sudo over
    if (r.address.startsWith('relay:')) throw refuse('unsupported', 'Only a machine added over SSH can do this from here.');
    if (r.platform !== 'darwin') throw refuse('unsupported', 'Only a Mac needs this.');
    return r;
  }

  /** The Host answers as the service `atBoot` says. @param {import('./registry.cjs').HostRow} r @param {'yes' | 'no'} atBoot */
  async function verify(r, atBoot) {
    /** Why the last answer could not be read (a Host still starting prints nothing yet), kept as the failure's cause. @type {unknown} */
    let unreadable = null;
    for (let i = 0; i < VERIFY_TRIES; i++) {
      if (i > 0) await wait(VERIFY_WAIT_MS);
      const out = await run(r, `${HOST_CLI} status`);
      try {
        const s = JSON.parse(out.stdout);
        if (s?.running === true && s.startup?.atBoot === atBoot) return;
        unreadable = null;
      } catch (e) {
        unreadable = e;
      }
    }
    throw Object.assign(refuse('boot_change_failed', 'The Host didn’t come back. Try again.'), unreadable ? { cause: unreadable } : {});
  }

  /** @param {string} id @param {() => Promise<void>} fn */
  async function once(id, fn) {
    if (busy.has(id)) throw refuse('busy', 'Already changing this machine.');
    busy.add(id);
    try {
      await fn();
    } finally {
      busy.delete(id);
    }
  }

  return {
    /**
     * Turn it on or off with the machine's administrator password; resolves once the Host answers as the service it now is.
     * @param {string} id @param {boolean} on @param {string} password
     */
    set(id, on, password) {
      const r = machine(id);
      /** @type {import('./daemonInstall.cjs').Run} */
      const machineRun = (command, input) => run(r, command, input);
      return once(id, async () => {
        if (on) await turnOn(machineRun, HOST_CLI, password);
        else {
          await asRoot(machineRun, turnOffScript(), password, 'turned-off');
          // back to the user's agent: the unit written and started as an install does. With nobody signed in there is no session to
          // load it into (launchd refuses: "Bootstrap failed: 5"), and that is what off means: it starts when someone signs in
          const back = await run(
            r,
            `${HOST_CLI} install >/dev/null && { ${startCommand('Darwin')} || { ${SIGNED_IN} && exit 1; echo ${AT_SIGN_IN}; }; }`,
          );
          if (back.code !== 0) throw refuse('boot_change_failed', back.stderr.trim().split('\n').pop() || 'The Host couldn’t start again.');
          if (back.stdout.includes(AT_SIGN_IN)) return;
        }
        await verify(r, on ? 'yes' : 'no');
      });
    },
    /** The root command for a person to run at the machine instead (turning it on). @param {string} id */
    async command(id) {
      const r = machine(id);
      const { user, plist } = await daemonPlist((command, input) => run(r, command, input), HOST_CLI);
      return sudoCommand(turnOnScript({ plist, user, sameUser: false }));
    },
  };
}

module.exports = { createStartAtBoot, sudoRefusal };
