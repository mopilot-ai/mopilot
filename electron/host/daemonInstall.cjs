// Turning a Mac's Host into the system daemon that starts before anyone signs in, over one ssh channel: the plist from what the Host reports and the root script from shared/host/launchDaemon.mjs, run through `sudo -S` with the administrator password on standard input only (never a command line, a log or a file). Shared by Keep running after restart on a listed machine (startAtBoot.cjs) and by Add machine on a Mac nobody is signed in on (install.cjs).
const { parseDaemonInfo, renderDaemonPlist, turnOnScript } = require('../../shared/host/launchDaemon.mjs');

/** One shell word. @param {string} s */
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A refusal the window shows as it is, with a code it can tell apart. @param {string} code @param {string} message */
const refuse = (code, message) => Object.assign(new Error(message), { code });

/** @typedef {(command: string, input?: Buffer) => Promise<{ code: number, stdout: string, stderr: string }>} Run one command on the machine */

/**
 * Throws sudo's refusals (a wrong password, a user who may not use sudo) in the person's words; returns '' for anything else.
 * @param {string} stderr
 */
function sudoRefusal(stderr) {
  if (/incorrect password|Sorry, try again/i.test(stderr)) throw refuse('wrong_password', 'That password didn’t work.');
  if (/not in the sudoers|not allowed to run sudo|may not run sudo/i.test(stderr))
    throw refuse('not_admin', 'Needs an administrator of this machine.');
  return '';
}

/** The daemon's plist and who it runs as, from the machine's Host (`cli` runs it there). @param {Run} run @param {string} cli */
async function daemonPlist(run, cli) {
  const out = await run(`${cli} install --print-daemon`);
  const info = out.code === 0 ? parseDaemonInfo(out.stdout) : null;
  if (!info) throw refuse('unsupported', 'Update this machine’s Host first.');
  return { user: info.user, plist: renderDaemonPlist(info) };
}

/** `script` as root, the password on sudo's standard input only; done when it printed `done`. @param {Run} run @param {string} script @param {unknown} password @param {string} done */
async function asRoot(run, script, password, done) {
  if (typeof password !== 'string' || !password || /[\r\n]/.test(password)) throw refuse('invalid', 'Enter the password.');
  // -k: never a cached sudo ticket, so the password typed here is the one checked; -p '': no prompt text in the output
  const out = await run(`/usr/bin/sudo -S -k -p '' /bin/sh -c ${quote(script)}`, Buffer.from(`${password}\n`, 'utf8'));
  if (out.code === 0 && out.stdout.includes(done)) return;
  sudoRefusal(out.stderr);
  throw refuse('boot_change_failed', out.stderr.trim().split('\n').pop() || 'The machine refused the change.');
}

/**
 * Turn the Host on the machine into the system daemon: the plist, the root script (for the user who runs sudo only), and the user's
 * agent plist removed at once, so a sign-in meanwhile starts no second Host (the daemon's Host removes it too).
 * @param {Run} run @param {string} cli @param {unknown} password
 */
async function turnOn(run, cli, password) {
  const { user, plist } = await daemonPlist(run, cli);
  try {
    await asRoot(run, turnOnScript({ plist, user, sameUser: true }), password, 'turned-on');
    const cleaned = await run('rm -f "$HOME/Library/LaunchAgents/ai.mopilot.host.plist"');
    if (cleaned.code !== 0) throw refuse('boot_change_failed', 'Couldn’t remove the old sign-in service. Try again.');
  } catch (error) {
    // A rejected sudo credential made no writes. Any other missing acknowledgment may follow
    // the root plist's publication: its files must survive until an administrator reconciles it.
    const e = /** @type {Error & { code?: string }} */ (error);
    throw Object.assign(e, { daemonMayExist: !['invalid', 'wrong_password', 'not_admin'].includes(e.code || '') });
  }
}

module.exports = { quote, refuse, sudoRefusal, daemonPlist, asRoot, turnOn };
