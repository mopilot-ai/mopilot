// This Mac's sign-in for one repository host, read on request for one clone on a machine (docs/host.md): `git credential fill` for exactly the address's protocol and host, else `gh auth token`; never prompts, never stored, never sent to the window.
const { proc } = require('../platform/ports/proc.cjs');
const shellEnv = require('../platform/env.cjs');

/** A keychain that asks, or a helper that hangs, is "no sign-in" after this long. */
const READ_MS = 8000;

/** The environment of a read: the login shell's, less the enterprise tokens `gh` would answer for any non-github.com host without checking it belongs to that host, and with prompts off. */
function readEnv() {
  const env = shellEnv.childEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  return env;
}

/** What each read runs: the git credential helpers' answer for a host, or the GitHub CLI's token for it. */
const READS = {
  fill: () => /** @type {[string, string[]]} */ (['git', ['credential', 'fill']]),
  token: (/** @type {string} */ host) => /** @type {[string, string[]]} */ (['gh', ['auth', 'token', '--hostname', host]]),
};

/** @param {'fill' | 'token'} read @param {{ input?: string, host?: string }} [o] @param {typeof READS} [reads] the commands (a test names its own) @returns {Promise<string | null>} stdout, or null when it failed or timed out */
function run(read, { input, host = '' } = {}, reads = READS) {
  const [file, args] = reads[read](host);
  return new Promise((resolve) => {
    const child = proc.execFile(
      file,
      args,
      {
        timeout: READ_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        env: readEnv(),
      },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input ?? '');
  });
}

/** The https address's protocol and host (with a port), or null for anything else: only https is ever lent. @param {string} url */
function httpsHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password ? u.host : null;
  } catch {
    return null;
  }
}

/** @param {string} out `key=value` lines @param {string} key */
const field = (out, key) =>
  out
    .split('\n')
    .find((l) => l.startsWith(`${key}=`))
    ?.slice(key.length + 1) ?? '';

/**
 * The sign-in this Mac has for the address's host, or null when there is none (or the address is not https).
 * @param {string} url
 * @param {{ run?: typeof run }} [o]
 * @returns {Promise<{ username: string, password: string } | null>}
 */
async function macSignIn(url, { run: exec = run } = {}) {
  const host = httpsHost(url);
  if (!host) return null;
  const filled = await exec('fill', { input: `protocol=https\nhost=${host}\n\n` });
  if (filled) {
    const username = field(filled, 'username');
    const password = field(filled, 'password');
    if (username && password) return { username, password };
  }
  const token = (await exec('token', { host: host.replace(/:\d+$/, '') }))?.trim();
  return token ? { username: 'x-access-token', password: token } : null;
}

module.exports = { macSignIn, httpsHost, run };
