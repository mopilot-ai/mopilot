// Host-side sign-in for harnesses and GitHub: runs their own authentication here, relays device links/codes, and keeps credentials on this machine.
import { createRequire } from 'node:module';

import { which as whichOnPath } from './acp.mjs';
import { probeHarness } from './harnessState.mjs';
import { proseLinks } from '../../shared/proseLinks.mjs';
import { stripAnsi } from '../../shared/ansiText.mjs';
import { OPENED_ENV } from './opener.mjs';
import { createGitSignInCheck } from './gitSignIn.mjs';
import { GIT_HOST, GIT_LOGIN, gitDevicePage } from '../../shared/host/gitLogin.mjs';

const require = createRequire(import.meta.url);
const { LOGIN_MS } = require('../../electron/harness/acp/signin.cjs');
const { processesOf } = require('../../electron/harness/acp/launch.cjs');
const { spawnGroup, retireGroup, ensureRetirementMonitor, processCompletion } = require('../../electron/platform/winbin.cjs');
const { proc } = require('../../electron/platform/ports/proc.cjs');

const CODE_PATTERN = /\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/g;
const GIT_CODE_LINE = /^(?:! )?First copy your one-time code: ([A-Z0-9]{4,5}-[A-Z0-9]{4,5})$/;
const NO_REMOTE_CLIPBOARD = '--clipboard=false';
/** The most links or codes kept for one sign-in. */
const MAX_RELAYED = 10;

/** @typedef {{ harness: string, state: 'starting' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'expired', methodId: string | null, methods: { id: string, name: string }[], links: string[], codes: string[], error: string | null }} Login */

/** Add `found` to `list`, once each. @param {string[]} list @param {string[]} found */
function collect(list, found) {
  for (const item of found) if (!list.includes(item) && list.length < MAX_RELAYED) list.push(item);
}
/** The device codes a line shows. @param {string} line */
const codesIn = (line) => line.match(CODE_PATTERN) ?? [];
/**
 * A line of a sign-in's output as plain text. The vendor CLIs color their links and codes (`codex login --device-auth`
 * prints `\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m` and `\x1b[94mABCD-EFGHI\x1b[0m`): left in, the link would
 * carry `\x1b[0m` into the browser and the code would not be found at all.
 * @param {string} raw
 */
const plainLine = (raw) => stripAnsi(raw);

/** The vendor CLIs whose own sign-in runs here, with no ACP agent: the command is the one the person would type on this machine. */
const CLI_LOGINS = {
  claude: { bin: 'claude', args: ['auth', 'login'], name: 'Claude Code' },
  // a device-code flow: the link and code are shown elsewhere and the CLI polls, so it needs no browser on this machine
  codex: { bin: 'codex', args: ['login', '--device-auth'], name: 'Codex' },
  [GIT_LOGIN]: { bin: 'gh', args: ['auth', 'login', '--hostname', GIT_HOST, '--git-protocol', 'https', '--web'], name: 'GitHub CLI (gh)' },
};
/** How each vendor CLI signs this machine out. */
const CLI_LOGOUTS = { claude: ['auth', 'logout'], codex: ['logout'] };
/** How often a sign-in under way reads the links the Host's opener recorded. */
const RELAY_MS = 250;
/** How long a sign-out may take. */
const LOGOUT_MS = 15_000;
/**
 * The environment a vendor sign-in runs in: Claude Code opens its page with `$BROWSER <url>` (`open` when unset), which on a Host would open a
 * browser on that machine's own screen, unseen, and finish there if that browser is signed in. The Host's opener (./opener.mjs) only records the
 * link; without one, `true` opens nothing. Either way the CLI still prints the link, which is relayed to the person's own browser.
 * @param {NodeJS.ProcessEnv} env
 */
export const loginEnv = (env) => ({ ...env, BROWSER: env[OPENED_ENV] && env.BROWSER ? env.BROWSER : 'true' });

/**
 * @param {{
 *   runtime: ReturnType<typeof import('./acp.mjs').createAcpRuntime>,
 *   loginMs?: number,
 *   signedIn?: ReturnType<typeof import('./signedIn.mjs').createSignedIn>,
 *   env?: NodeJS.ProcessEnv,
 *   which?: typeof whichOnPath,
 *   spawnFn?: (bin: string, args: string[], options: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess,
 *   probe?: typeof probeHarness,
 *   families?: { signedOut: (harness: string) => void, signedIn?: (harness: string) => void }[],
 *   logoutMs?: number,
 *   opened?: { take: () => string[] },
 *   gitSignInCheck?: ReturnType<typeof createGitSignInCheck>,
 *   retire?: typeof retireGroup,
 * }} o env/which/spawnFn/probe: where the CLIs are found, how they start, and how a finished sign-in is checked (tests replace them); families: told of a sign-out, so a process that holds the old login in memory (Codex's app-server, a Claude Code CLI) lets it go; opened: the links the Host's opener recorded (./opener.mjs), relayed while a sign-in waits
 */
export function createLogin({
  runtime,
  loginMs = LOGIN_MS,
  signedIn,
  env = process.env,
  which = whichOnPath,
  spawnFn = (bin, args, options) => proc.spawn(bin, args, options),
  probe = probeHarness,
  families = [],
  logoutMs = LOGOUT_MS,
  opened = { take: () => [] },
  gitSignInCheck = createGitSignInCheck(),
  retire = retireGroup,
}) {
  const host = runtime.host;
  /** @type {Map<string, { login: Login, abort: AbortController, done: Promise<void> }>} */
  const running = new Map();
  /** @type {Map<string, Login>} the last sign-in of each harness, kept so a caller that reconnects can read how it ended */
  const last = new Map();

  /** @param {Login} login @param {AbortSignal} signal @param {string | undefined} wanted */
  async function run(login, signal, wanted) {
    const own = !processesOf(host, login.harness).length;
    const agent = await host.agentForLogin(login.harness);
    // a link is read from whole lines: a chunk can end in the middle of one
    let partial = '';
    const read = (/** @type {string} */ raw) => {
      const line = plainLine(raw);
      collect(login.links, proseLinks(line));
      collect(login.codes, codesIn(line));
    };
    const onStderr = (/** @type {string} */ text) => {
      const lines = (partial + text).split('\n');
      partial = /** @type {string} */ (lines.pop());
      lines.forEach(read);
    };
    agent.on('stderr', onStderr);
    try {
      login.methods = agent.caps.authMethods.map((/** @type {any} */ m) => ({ id: String(m.id), name: String(m.name ?? m.id) }));
      const method = login.methods.find((m) => m.id === wanted) ?? (wanted ? null : login.methods[0]);
      if (!method)
        throw new Error(wanted ? `${login.harness} has no sign-in method "${wanted}".` : `${login.harness} lists no sign-in method.`);
      login.methodId = method.id;
      // a Cancel pressed while the harness was still starting
      if (signal.aborted) throw Object.assign(new Error('Sign-in was cancelled'), { cancelled: true });
      login.state = 'waiting';
      host.questions?.retireAgent(agent);
      agent.authenticating = true;
      // a browser or device-code sign-in takes as long as the person does, up to loginMs
      await agent.request('authenticate', { methodId: method.id }, { timeoutMs: loginMs, signal });
    } finally {
      agent.off('stderr', onStderr);
      read(partial);
      agent.authenticating = false;
      // a process started only to sign in goes when the sign-in is over
      if (own) agent.kill();
    }
  }

  /** The CLI of a harness whose sign-in is running, so the person's pasted code can reach it. @type {Map<string, import('node:child_process').ChildProcessWithoutNullStreams>} */
  const clis = new Map();
  /** A failed retirement keeps its command's writer until an explicit retry verifies cleanup. @type {Map<string, ReturnType<typeof processCompletion>>} */
  const cleanupRetries = new Map();

  /**
   * Sign in with the vendor's own CLI: run it, relay the links and codes it prints, and call it done only when the CLI exits 0 and asks
   * itself that the harness is now signed in (a CLI that exits cleanly without a login must not read as one).
   * @param {Login} login @param {AbortSignal} signal @param {keyof typeof CLI_LOGINS} id
   */
  async function runCli(login, signal, id) {
    const cli = CLI_LOGINS[id];
    const bin = which(cli.bin, env);
    if (!bin) throw new Error(`${cli.name} is not installed on this Host.`);
    ensureRetirementMonitor();
    login.methods = [{ id: 'cli', name: 'Sign in' }];
    login.methodId = 'cli';
    const git = id === GIT_LOGIN;
    const current = () => {
      if (signal.aborted) throw Object.assign(new Error('Sign-in was cancelled'), { cancelled: true });
    };
    /** @param {string[]} args @param {boolean} relay */
    const command = async (args, relay) => {
      current();
      // all three streams are pipes (stdio below), so none of them is null
      const child = /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ (
        spawnGroup(spawnFn, bin, args, {
          managed: true,
          env: { ...loginEnv(env), ...(git ? { GH_BROWSER: 'true', GH_PROMPT_DISABLED: '1' } : {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      );
      login.state = 'waiting';
      /** what the CLI last printed, for the reason when it fails */
      const tail = /** @type {string[]} */ ([]);
      let firstStderr = '';
      for (const stream of [child.stdout, child.stderr]) {
        const read = (/** @type {string} */ raw) => {
          const line = plainLine(raw);
          if (stream === child.stderr) firstStderr ||= line.trim();
          if (relay) {
            collect(
              login.links,
              proseLinks(line).filter((url) => !git || gitDevicePage(url)),
            );
            collect(login.codes, git ? (GIT_CODE_LINE.exec(line.trim())?.slice(1) ?? []) : codesIn(line));
          }
          if (!git && line.trim()) tail.push(line.trim());
          if (tail.length > 3) tail.shift();
        };
        let partial = '';
        stream.setEncoding('utf8');
        stream.on('data', (/** @type {string} */ text) => {
          const lines = (partial + text).split('\n');
          partial = /** @type {string} */ (lines.pop());
          lines.forEach(read);
        });
        stream.on('end', () => read(partial));
      }
      child.stdin.on('error', () => undefined);
      // GitHub takes its device code in the browser. Close stdin so a CLI prompt can never wait for a reply here.
      if (git) child.stdin.end();
      else clis.set(id, child);
      let timer;
      let abort;
      let accepted;
      try {
        accepted = await new Promise((resolve, reject) => {
          let failure;
          const completion = processCompletion({
            retire: () => retire(child),
            onComplete: (code) => {
              if (failure) return reject(failure);
              if (code === 0) return resolve(true);
              // Older gh versions reject the flag before starting OAuth. A failed device flow is never replayed.
              if (
                args.includes(NO_REMOTE_CLIPBOARD) &&
                code === 1 &&
                firstStderr === 'unknown flag: --clipboard' &&
                login.links.length + login.codes.length === 0
              )
                return resolve(false);
              reject(
                new Error(
                  git
                    ? 'GitHub sign-in could not finish on this machine. Check that gh is installed and can reach github.com, then try again.'
                    : tail.join(' ') || `${cli.name} sign-in ended with code ${code}.`,
                ),
              );
            },
            onError: () => {
              // Do not release the writer: a later Sign in retries cleanup before it can start another CLI.
              clearTimeout(timer);
              cleanupRetries.set(id, completion);
              const waiting = /** @type {Login} */ (last.get(id));
              for (const view of new Set([login, waiting])) {
                view.state = 'failed';
                view.error = 'Could not confirm the previous sign-in stopped on this machine. Sign in again to retry cleanup.';
              }
              clis.delete(id);
            },
          });
          const stop = (error, state) => {
            failure = error;
            login.state = state;
            login.error = state === 'cancelled' ? null : error.message;
            clis.delete(id);
            completion.request();
          };
          // the vendor's code is no longer good: the attempt ends as expired, and starting again gets a new one
          timer = setTimeout(
            () => stop(Object.assign(new Error('That code expired. Get a new one.'), { expired: true }), 'expired'),
            relay ? loginMs : Math.min(loginMs, LOGOUT_MS),
          );
          timer.unref();
          abort = () => {
            if (login.state === 'failed' || login.state === 'expired') return completion.request();
            stop(Object.assign(new Error('Sign-in was cancelled'), { cancelled: true }), 'cancelled');
          };
          signal.addEventListener('abort', abort, { once: true });
          child.once('error', (error) => {
            failure = error;
            completion.request();
          });
          // A descendant can hold the pipes open after its parent exits, so retirement starts before close.
          child.once('exit', () => completion.request());
          child.once('close', (code) => completion.close(code));
        });
      } finally {
        clearTimeout(timer);
        if (abort) signal.removeEventListener('abort', abort);
        clis.delete(id);
        cleanupRetries.delete(id);
      }
      current();
      return accepted;
    };
    if (git) gitSignInCheck.invalidate();
    const args = git ? [...cli.args, NO_REMOTE_CLIPBOARD] : cli.args;
    if (!(await command(args, true))) await command(cli.args, true);
    if (git) {
      // The device flow installs the credential. Retire old negative reads before configuring and verifying Git.
      gitSignInCheck.invalidate();
      await command(['auth', 'setup-git', '--hostname', GIT_HOST], false);
      gitSignInCheck.invalidate();
      const answer = await gitSignInCheck([GIT_HOST]);
      current();
      if (answer[GIT_HOST] !== 'yes')
        throw new Error(
          'GitHub signed in, but Git could not use the sign-in on this machine. Check its Git credential helper and try again.',
        );
    } else {
      const ok = await probe(id, { env, which });
      current();
      if (!ok) throw new Error(`${cli.name} finished its sign-in, but this Host is still not signed in.`);
    }
  }

  return {
    /**
     * Start the harness's sign-in, or join the one already waiting.
     * @param {{ harness: string, methodId?: string }} p
     * @returns {Login}
     */
    start({ harness, methodId }) {
      const now = running.get(harness);
      if (now && !['starting', 'waiting'].includes(now.login.state)) now.abort.abort();
      cleanupRetries.get(harness)?.request();
      if (now && !now.abort.signal.aborted) return now.login;
      /** @type {Login} */
      const login = { harness, state: 'starting', methodId: null, methods: [], links: [], codes: [], error: null };
      const abort = new AbortController();
      const entry = { login, abort, done: Promise.resolve() };
      running.set(harness, entry);
      last.set(harness, login);
      // what an agent asked this machine to open goes to the person instead (./opener.mjs); a link left from before this sign-in is not its own
      if (harness !== GIT_LOGIN) opened.take();
      const relayOpened = () => {
        if (harness === GIT_LOGIN) return;
        for (const raw of opened.take()) {
          const line = plainLine(raw);
          collect(login.links, proseLinks(line));
          collect(login.codes, codesIn(line));
        }
      };
      const relay = setInterval(relayOpened, RELAY_MS);
      relay.unref();
      const begin = () => {
        if (abort.signal.aborted) return Promise.reject(Object.assign(new Error('Sign-in was cancelled'), { cancelled: true }));
        return Object.hasOwn(CLI_LOGINS, harness)
          ? runCli(login, abort.signal, /** @type {keyof typeof CLI_LOGINS} */ (harness))
          : run(login, abort.signal, methodId);
      };
      // A cancelled attempt may still be releasing a CLI or verifying Git. Its replacement waits for those writers.
      entry.done = (now ? now.done.then(begin) : begin())
        .then(
          () => {
            login.state = abort.signal.aborted ? 'cancelled' : 'done';
            if (abort.signal.aborted || harness === GIT_LOGIN) return;
            signedIn?.set(login.harness, true);
            // what a failed turn marked on the old login is over (a turn that found it refused)
            for (const f of families) f.signedIn?.(login.harness);
          },
          (/** @type {any} */ e) => {
            login.state = e.cancelled ? 'cancelled' : e.expired ? 'expired' : 'failed';
            login.error = e.cancelled ? null : String(e.said ?? e.message);
          },
        )
        .finally(() => {
          clearInterval(relay);
          relayOpened();
          if (running.get(harness) === entry) running.delete(harness);
        });
      return login;
    },
    /** How the harness's latest sign-in stands; null when none was started. @param {string} harness */
    status: (harness) => last.get(harness) ?? null,
    /** Stop waiting for a sign-in; false when none was under way. @param {string} harness */
    cancel(harness) {
      const r = running.get(harness);
      r?.abort.abort();
      return !!r;
    },
    /**
     * A line the person typed for the sign-in under way (the code Claude Code asks to be pasted); false when none takes input.
     * @param {string} harness @param {string} text
     */
    input(harness, text) {
      const child = clis.get(harness);
      const line = String(text)
        .replace(/[\r\n]+/g, ' ')
        .trim();
      if (!child || child.stdin.destroyed || !line) return false;
      child.stdin.write(`${line}\n`);
      return true;
    },
    /**
     * Sign the harness out on this machine with its own CLI (a sign-in under way is cancelled first), then ask the CLI whether it still is.
     * An ACP harness keeps its login where its agent put it, so it is reported as not signed out here rather than guessed.
     * @param {string} harness
     * @returns {Promise<{ harness: string, signedOut: boolean, error: string | null }>}
     */
    async logout(harness) {
      if (!Object.hasOwn(CLI_LOGOUTS, harness)) return { harness, signedOut: false, error: 'Sign out of it on the machine itself.' };
      const active = running.get(harness);
      if (active) {
        active.abort.abort();
        cleanupRetries.get(harness)?.request();
        return {
          harness,
          signedOut: false,
          error: 'Sign-in is stopping on this machine. Wait for it to stop, then try signing out again.',
        };
      }
      const id = /** @type {'claude' | 'codex'} */ (harness);
      const bin = which(CLI_LOGINS[id].bin, env);
      // nothing to sign out of
      if (!bin) return { harness, signedOut: true, error: null };
      const ran = await new Promise((resolve) => {
        const child = spawnFn(bin, CLI_LOGOUTS[id], { env, stdio: ['ignore', 'ignore', 'pipe'] });
        let said = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (/** @type {string} */ t) => (said = (said + t).slice(-500)));
        const timer = setTimeout(() => (child.kill(), resolve(`${CLI_LOGINS[id].name} did not finish signing out.`)), logoutMs);
        timer.unref();
        child.once('error', (e) => (clearTimeout(timer), resolve(e.message)));
        child.once('close', () => (clearTimeout(timer), resolve(said.trim())));
      });
      // after a sign-out, an answer the CLI could not give counts as signed out
      const still = (await probe(id, { env, which })) === true;
      signedIn?.set(id, still);
      if (!still) for (const f of families) f.signedOut(id);
      return { harness, signedOut: !still, error: still ? String(ran || `${CLI_LOGINS[id].name} is still signed in.`) : null };
    },
    /** Whether no sign-in is waiting. */
    idle: () => running.size === 0,
    /** Stop every sign-in (the Host is closing). */
    close() {
      for (const r of running.values()) r.abort.abort();
    },
  };
}
