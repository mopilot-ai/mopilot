// Whether a machine that stopped answering is waiting for someone to sign in. The Host runs as the user's login service (a launchd
// agent on macOS), so after a restart it starts only once that user signs in at the machine. SSH still works then: one quiet,
// non-interactive command reads who owns the console (root at the login window) and when the system started. An answer is kept for
// two minutes, so a machine that stays down is asked again only now and then; a failed ssh (still starting up) is asked again at the
// next beat. Only macOS says; any other answer, or none, says nothing. A Host that starts at boot (a system daemon, see
// shared/host/launchDaemon.mjs) waits for nobody's sign-in; what can still hold it is FileVault, whose locked disk takes no key at
// the ssh login (macOS 26 serves only a password there, to unlock it), so a machine with FileVault on that refuses the key says so.
const { clock } = require('../platform/ports/clock.cjs');
const { createSshChannel } = require('./sshChannel.cjs');
const { identityArgs } = require('./sshKey.cjs');

const KEEP_MS = 120_000;
/** Prints the console's owner, this account and the boot time; nothing on another system. */
const COMMAND = '[ "$(uname)" = Darwin ] && stat -f %Su /dev/console && id -un && sysctl -n kern.boottime';
/** ssh's refusal of the key: what a Mac waiting at its FileVault unlock answers (seen on macOS 26.6). */
const LOCKED = /Permission denied \(publickey,password,keyboard-interactive\)/;

/**
 * What COMMAND printed, as a wait: 'restarted' when the system started after `lastAnswer`, 'signed-out' otherwise (also for a
 * machine that never answered: nothing says it restarted); null when this account is signed in (or the output is not COMMAND's).
 * @param {string} stdout @param {number | null} lastAnswer when the machine last answered
 * @returns {import('./registry.cjs').LoginWait | null}
 */
function readWait(stdout, lastAnswer) {
  const [owner, me, boot] = stdout.split('\n').map((l) => l.trim());
  const sec = /\bsec = (\d+)/.exec(boot ?? '')?.[1];
  if (!owner || !me || !sec || owner === me) return null;
  return lastAnswer !== null && Number(sec) * 1000 > lastAnswer ? 'restarted' : 'signed-out';
}

/**
 * @param {object} [o]
 * @param {() => NodeJS.ProcessEnv} [o.env]
 * @param {(record: { address: string, identity: string }, command: string) => Promise<{ code: number, stdout: string, stderr?: string }>} [o.run] one command over ssh, never prompting
 * @returns {(record: import('./registry.cjs').HostRecord) => Promise<import('./registry.cjs').LoginWait | null>}
 */
function createSigninWait({
  env = () => process.env,
  run = (record, command) => createSshChannel({ env, timeoutMs: 20_000, sshArgs: identityArgs(record.identity) })(record.address, command),
} = {}) {
  /** @type {Map<string, { key: string, at: number, answer: Promise<import('./registry.cjs').LoginWait | null> }>} */
  const kept = new Map();
  return (record) => {
    // a machine added by command is reached only through the relay: there is no SSH to ask
    if (record.address.startsWith('relay:')) return Promise.resolve(null);
    const atBoot = record.startup?.atBoot === 'yes';
    const fileVault = record.startup?.fileVault === 'on';
    const key = `${record.id}\n${record.lastHeartbeat}`;
    const had = kept.get(record.id);
    if (had && had.key === key && clock.now() - had.at < KEEP_MS) return had.answer;
    // not answered (ssh failed, or could not start): asked again at the next beat
    const forget = () => kept.get(record.id)?.answer === answer && kept.delete(record.id);
    const answer = run(record, COMMAND).then(
      (r) => {
        // ssh answered and nobody waits to sign in, yet the Host does not answer: it is not running (255 is ssh itself failing and -1 a start or a timeout; any other code is the command finding another system)
        if (r.code === 0) return (atBoot ? null : readWait(r.stdout, record.lastHeartbeat)) ?? 'host-stopped';
        if (fileVault && LOCKED.test(r.stderr ?? '')) return 'locked';
        if (r.code > 0 && r.code !== 255) return 'host-stopped';
        forget();
        return null;
      },
      (e) => {
        forget();
        throw e;
      },
    );
    kept.set(record.id, { key, at: clock.now(), answer });
    return answer;
  };
}

module.exports = { createSigninWait, readWait, COMMAND };
