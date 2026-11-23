// Remove's other half for a machine that answers over ssh, its Host running or stopped: stop the Host there and delete what MoPilot put on it (service, install tree, data, config). A Keep-running daemon is root's, so it needs the administrator password; without one it is left, and the result says so. A machine that does not answer is never touched.
const { HOST_CLI, BUNDLE_BIN } = require('./install.cjs');
const { asRoot, refuse } = require('./daemonInstall.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { turnOffScript } = require('../../shared/host/launchDaemon.mjs');

/** Everything the Host keeps on a machine, by the default layout of each system: its install tree, its data and its config. */
const PURGE =
  'if [ "$(uname)" = Darwin ]; then data="$HOME/Library/Application Support/mopilot-host"; else data="${XDG_DATA_HOME:-$HOME/.local/share}/mopilot-host"; fi; ' +
  'rm -rf "$HOME/.mopilot-host" "$data" "${XDG_CONFIG_HOME:-$HOME/.config}/mopilot-host"';
/** The one command that asks whether a machine answers over ssh: it runs nothing there. */
const PROBE = 'true';
/** How long the question may take (the Remove sheet waits on it). */
const PROBE_MS = 10_000;
/** ssh could not run the command (255), or it ran out of time (-1) and may be partly done. @param {{ code: number }} r */
const cutOff = (r) => r.code === 255 || r.code === -1;

/**
 * @param {object} o
 * @param {{ list: () => import('./registry.cjs').HostRow[] }} o.registry
 * @param {(destination: string, command: string, input?: Buffer) => Promise<{ code: number, stdout: string, stderr: string }>} o.channel one command over ssh
 * @param {(record: import('./registry.cjs').HostRow, method: string) => Promise<any>} o.call one request to the machine's Host
 */
function createHostUninstaller({ registry, channel, call }) {
  /** The Host is root's boot daemon only on a Mac: on Linux `atBoot` means the user's lingering, which `uninstall` undoes itself. @param {import('./registry.cjs').HostRow} r */
  const isDaemon = (r) => r.platform === 'darwin' && r.startup.atBoot === 'yes';
  /** A Mac (not this one) whose Host never said whether it starts at boot: root's daemon may be running it, and a user-level uninstall must not delete the tree a daemon runs from. @param {import('./registry.cjs').HostRow} r */
  const isUnsure = (r) => !r.address.startsWith('local:') && r.platform === 'darwin' && r.startup.atBoot === 'unknown';
  /** @param {string} id */
  const find = (id) => {
    const r = registry.list().find((x) => x.id === id);
    if (!r) throw refuse('unknown_machine', 'That machine is not in the list.');
    return r;
  };
  /** Asks whether the machine answers over ssh now: a bounded `true`; anything but exit 0 is no. @param {string} address */
  async function reachable(address) {
    /** @type {any} */
    let timer;
    const late = new Promise((resolve) => {
      timer = clock.setTimeout(() => resolve({ code: -1 }), PROBE_MS);
    });
    // a channel that throws, even before it returns a promise, is no answer
    const asked = (async () => channel(address, PROBE))().catch((error) => {
      noteIgnored('ask whether a machine answers over ssh', error);
      return { code: -1 };
    });
    const answer = await Promise.race([asked, late]);
    clock.clearTimeout(timer);
    return answer.code === 0;
  }
  /**
   * Whether another row may be the same Host: the purge runs only when every other row (ssh or relay) is proved distinct, i.e. has another address and both Host keys are known and differ. A lone row is purged whatever its key. `same`: the same address or Host key; `unknown`: a Host key is missing, so the two cannot be told apart. @param {import('./registry.cjs').HostRow} r
   * @returns {{ name: string, why: 'same' | 'unknown' } | null}
   */
  const sharedWith = (r) => {
    /** @type {{ name: string, why: 'same' | 'unknown' } | null} */
    let unknown = null;
    for (const o of registry.list()) {
      if (o.id === r.id) continue;
      if (o.address === r.address || (!!r.hostKey && o.hostKey === r.hostKey)) return { name: o.name, why: 'same' };
      if (!r.hostKey || !o.hostKey) unknown ??= { name: o.name, why: 'unknown' };
    }
    return unknown;
  };
  return {
    /**
     * What Remove has to ask before it uninstalls: whether the machine answers over ssh (`reachable`; its Host may be stopped), whether the Host answers (`online`), whether a turn runs there, whether the Host is a boot daemon (needs the password), and the name of another row that uses the same Host.
     * @param {string} id
     * @returns {Promise<{ ssh: boolean, reachable: boolean, online: boolean, busy: 'yes' | 'no' | 'unknown', daemon: boolean, unsure: boolean, shared: string, why: '' | 'same' | 'unknown' }>}
     */
    async plan(id) {
      const r = find(id);
      const ssh = !r.address.startsWith('relay:');
      const up = ssh && (await reachable(r.address));
      const online = up && r.status !== 'offline';
      // a Host the app reads as offline while ssh answers may be wedged or cut off from this Mac, not stopped: a turn may run there
      /** @type {'yes' | 'no' | 'unknown'} */
      let busy = up && !online ? 'unknown' : 'no';
      if (online) {
        busy = 'unknown';
        try {
          busy = (await call(r, 'idle'))?.idle === true ? 'no' : 'yes';
        } catch (error) {
          // an older Host has no such request: it may well be busy
          noteIgnored('ask a machine whether a turn runs before Remove', error);
        }
      }
      const other = ssh ? sharedWith(r) : null;
      return {
        ssh,
        reachable: up,
        online,
        busy,
        daemon: isDaemon(r),
        unsure: isUnsure(r),
        shared: other?.name ?? '',
        why: other?.why ?? '',
      };
    },
    /**
     * Stops and uninstalls the Host on the machine, running or not, and deletes its files. `left` says why nothing was done: a boot daemon needs `password` (`daemon`), a Mac that never said whether its Host starts at boot (`unsure`), another row is, or may be, the same Host (`shared`, naming it). Refuses with `uninstall_cut_off` when ssh dropped or ran out of time mid-way: the Host may be stopped and some files may remain.
     * @param {string} id @param {string} password
     * @returns {Promise<{ left: '' | 'daemon' | 'unsure' | 'shared', shared?: string, why?: 'same' | 'unknown' }>}
     */
    async uninstall(id, password) {
      const r = find(id);
      if (r.address.startsWith('relay:')) throw refuse('unsupported', 'Only a machine added over SSH can be uninstalled from here.');
      const other = sharedWith(r);
      if (other) return { left: 'shared', shared: other.name, why: other.why };
      if (isDaemon(r)) {
        if (!password) return { left: 'daemon' };
        await asRoot((command, input) => channel(r.address, command, input), turnOffScript(), password, 'turned-off');
      } else if (isUnsure(r)) return { left: 'unsure' };
      const cut = () =>
        refuse('uninstall_cut_off', `The connection to ${r.name} dropped. Its Host may be stopped and some files may remain.`);
      const out = await channel(r.address, `${HOST_CLI} uninstall`);
      if (cutOff(out)) throw cut();
      if (out.code !== 0) {
        // a machine with no Host installed has nothing to stop; its files are still deleted below
        const tree = await channel(r.address, `test -e "${BUNDLE_BIN}"`);
        if (cutOff(tree)) throw cut();
        if (tree.code === 0) throw refuse('uninstall_failed', out.stderr.trim().split('\n').pop() || 'The Host couldn’t be stopped.');
      }
      const purged = await channel(r.address, PURGE);
      if (cutOff(purged)) throw cut();
      if (purged.code !== 0) throw refuse('uninstall_failed', 'The Host stopped, but its files couldn’t be deleted.');
      return { left: '' };
    },
  };
}

module.exports = { createHostUninstaller, PURGE, PROBE };
