// Whether git on this Host can sign in to a repository host, and what an agent's git says when it cannot: `status` can report 'yes' / 'no' / 'unknown' per host (asked for, never part of the heartbeat), and every agent's git prompts for nothing and fails with one line that names the cause.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './hostGit.mjs';

/** How long one reading may take: a helper that waits on a person is "unknown", not a hung status. */
const READ_MS = 4000;
/** How long an answer is kept: a sign-in done meanwhile shows within this. */
const KEEP_MS = 60_000;

/** @typedef {'yes' | 'no' | 'unknown'} SignIn */

/**
 * Asks git, the way a pull or push would, whether it has a credential for each host: `git credential fill` with prompts off and the machine's whole git config, as an agent's git has it. The secret it prints is only tested for presence, never kept, returned or logged.
 * @param {object} [o]
 * @param {typeof runGit} [o.run] @param {() => number} [o.now] @param {number} [o.keepMs] @param {number} [o.timeoutMs]
 * @returns {((hosts: string[]) => Promise<Record<string, SignIn>>) & { invalidate: () => void }} the answer per host; calls while one is asked join it
 */
export function createGitSignInCheck({ run = runGit, now = Date.now, keepMs = KEEP_MS, timeoutMs = READ_MS } = {}) {
  /** @type {Map<string, { at: number, answer: Promise<SignIn> }>} */
  const kept = new Map();
  /** @param {string} host @returns {Promise<SignIn>} */
  async function ask(host) {
    // no askpass of the user's may open a window for a reading: it answers no, and nothing waits on a person
    const r = await run(['-c', 'core.askPass=', 'credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      timeout: timeoutMs,
      env: { GIT_CONFIG_NOSYSTEM: '0', GIT_ASKPASS: 'false', SSH_ASKPASS: '' },
    });
    if (r.spawnFailed || r.signal) return 'unknown';
    return r.ok && /^password=.+/m.test(r.stdout) ? 'yes' : 'no';
  }
  const check = async (/** @type {string[]} */ hosts) => {
    const out = /** @type {Record<string, SignIn>} */ ({});
    await Promise.all(
      hosts.map(async (host) => {
        let entry = kept.get(host);
        if (!entry || now() - entry.at >= keepMs) kept.set(host, (entry = { at: now(), answer: ask(host) }));
        const answer = await entry.answer;
        out[host] = kept.get(host) === entry ? answer : 'unknown';
      }),
    );
    return out;
  };
  // Installing a credential retires pending reads and cached failures before a fresh verification starts.
  check.invalidate = () => kept.clear();
  return check;
}

/** What git runs when it would prompt: one line that names the cause, so a failed pull or push in a chat says why. The prompt (`Username for 'https://github.com': `) is its first argument. */
const ASKPASS = `#!/bin/sh
where=$(printf '%s' "$1" | sed -n "s/.*'https\\{0,1\\}:\\/\\/\\([^']*\\)'.*/\\1/p" | sed 's,/.*,,;s/.*@//' | tr -cd 'A-Za-z0-9.:-')
printf 'MoPilot: git has no sign-in on this machine%s. Sign in on this machine in MoPilot, then retry the operation.\\n' "\${where:+ for https://$where}" >&2
exit 1
`;

/** Whether the machine's git config names an askpass of its own (`core.askPass`). @param {NodeJS.ProcessEnv} env */
function configuredAskpass(env) {
  try {
    return (
      execFileSync('git', ['config', '--get', 'core.askPass'], {
        env,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() !== ''
    );
  } catch {
    // no such setting (exit 1), no git, or too slow: nothing to protect
    return false;
  }
}

/**
 * The environment that makes every agent's git fail fast and say why: no prompt, no helper GUI, and the askpass above (kept in the data folder, 0755). A `GIT_ASKPASS`, `SSH_ASKPASS` or `core.askPass` the machine already has is the user's and stays (git would ask ours first and shadow it).
 * @param {string} dataDir @param {NodeJS.ProcessEnv} env @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string>} merge into the Host's environment
 */
export function gitFailFastEnv(dataDir, env, platform = process.platform) {
  const out = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (env.GIT_ASKPASS || env.SSH_ASKPASS || platform === 'win32' || configuredAskpass(env)) return out;
  const file = path.join(dataDir, 'git-askpass');
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== ASKPASS) {
      // renamed into place whole, so a git running now never reads half a script
      const tmp = `${file}.${process.pid}`;
      fs.writeFileSync(tmp, ASKPASS, { mode: 0o755 });
      fs.renameSync(tmp, file);
    }
    fs.chmodSync(file, 0o755);
    return { ...out, GIT_ASKPASS: file };
  } catch {
    // a data folder that cannot be written leaves git to fail on its own words
    return out;
  }
}

/**
 * A `host.status` answer with the git sign-in of the hosts the request named; without any, the answer as it is.
 * @template {object} T
 * @param {T} status @param {{ signIn?: string[] }} params @param {(hosts: string[]) => Promise<Record<string, SignIn>>} check
 */
export async function withGitSignIn(status, params, check) {
  return params.signIn ? { ...status, gitSignIn: await check(params.signIn) } : status;
}
