// Finding the claude binary and running it: install candidates and their versions, plain CLI commands, and whether the login is signed in and works.
const { clock } = require('../../platform/ports/clock.cjs');
const { proc } = require('../../platform/ports/proc.cjs');
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const { claudeBilling, rejectedCredential } = require('../../identity/contract/claudeBilling.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { parseClaudeStatus } = require('./status.cjs');
const { isLoginRefused } = require('../../../shared/loginRefused.mjs');
const { windowsCandidates, spawnArgs, resolveShim, realIo, launchSpec } = require('../../platform/winbin.cjs');
const { toolCandidates, toolVersion, offPathFields, fileKey, runnableTool, versionedToolCopies } = require('../../platform/userTools.cjs');
const { installSource, hostIo } = require('../installMethod.cjs');
const { preferredInstalls, highestInstalls } = require('../versions.cjs');
const shellEnv = require('../../platform/env.cjs');

// read at each use, so a test can run the Windows paths on any platform
const isWin = () => process.platform === 'win32';
/** A timer that doesn't keep the process alive (deadlines and grace periods only). */
const unrefTimer = (fn, ms) => {
  const t = clock.setTimeout(fn, ms);
  t.unref();
  return t;
};
/** The program the Agent SDK spawns: on Windows an npm `.cmd` shim is replaced by the .exe or .js it runs. */
const sdkBin = (bin) => require('../../platform/disclaim.cjs').wrapProgram(resolveShim(bin, realIo()));

/* ------------------------------------------------------------------ */
/* binary discovery                                                    */
/* ------------------------------------------------------------------ */

/**
 * A second bound on a CLI run: `execFile` calls back only when the CLI's pipes close, so a CLI whose child holds them open (or that ignores its kill)
 * outlives its own timeout and holds every caller. Past the timeout and a short grace the CLI is killed and the caller is refused. Returns the timer, for the caller to clear once the CLI answers.
 * @param {number} timeout the run's own timeout (ms) @param {(error: Error) => void} reject @param {() => { kill: (signal: any) => unknown }} child
 */
function deadline(timeout, reject, child) {
  const timer = setTimeout(() => {
    try {
      child().kill('SIGKILL');
    } catch (e) {
      noteIgnored('stop a Claude Code CLI that did not answer', e);
    }
    reject(new Error('The CLI did not answer in time'));
  }, timeout + 1000);
  return timer;
}

/**
 * @param {import('./state.cjs').ClaudeState} state
 * @param {ReturnType<typeof import('./auth.cjs').createAuth>} creds the credential in use (electron/harness/claude/auth.cjs)
 * @param {() => boolean} [preferHighestCli] the desktop app's startup preference
 */
function createCli(state, creds, preferHighestCli = () => false) {
  /** What the CLI prints for `args`, run off main's event loop (a probe; at most 8 s). */
  function output(bin, args) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const child = proc.execFile(...spawnArgs(bin, args, { timeout: 8000, env: creds.cleanEnv() }), (err, stdout) => {
        settled = true;
        clearTimeout(timer);
        return err ? reject(err) : resolve(String(stdout));
      });
      // started only once the CLI is: a CLI that cannot start throws above and leaves no timer behind
      if (!settled) timer = deadline(8000, reject, () => child);
    });
  }

  /** The CLI's version (platform/userTools.cjs: its package.json, else one `--version` per binary). @returns {Promise<string | null>} */
  const versionOf = (bin) => toolVersion(bin, { env: creds.cleanEnv() });

  /** Whether each CLI binary takes --plugin-dir, by path and when it last changed (an update in place is asked again). */
  /** @type {Map<string, Promise<boolean>>} */
  const pluginDirs = new Map();
  /**
   * Whether a CLI can load MoPilot's plugins (the SDK passes each as --plugin-dir), from its own --help: an
   * older CLI would refuse to start with the flag. Asked once per binary; sessions starting meanwhile share the answer.
   */
  function takesPluginDirs(bin) {
    let key = bin;
    try {
      key = `${bin}@${fs.statSync(bin).mtimeMs}`;
    } catch (e) {
      // a binary that can't be looked at is asked under its path alone
      noteIgnored('look at the Claude Code binary', e);
    }
    let answer = pluginDirs.get(key);
    if (!answer) {
      answer = output(bin, ['--help']).then(
        (help) => help.includes('--plugin-dir'),
        (e) => {
          // no answer: the session starts without plugins rather than not at all
          noteIgnored("read Claude Code's options", e);
          return false;
        },
      );
      pluginDirs.set(key, answer);
    }
    return answer;
  }

  /** @type {import('../../platform/userTools.cjs').CliCandidate[] | null} */
  let cachedCandidates = null;
  /** @type {Promise<import('../../platform/userTools.cjs').CliCandidate[]> | null} the probe in flight */
  let probing = null;
  let probeSeq = 0;
  /**
   * The installed CLIs and their versions, asked once (`force` asks again). Callers meanwhile share the probe in
   * flight (a forced one too, so none gets the older answer); a forced probe replaces it, and only the latest one
   * started is remembered.
   */
  function candidates(force = false) {
    const highest = preferHighestCli();
    if (probing && (!force || highest)) return probing;
    if (!highest && !force && cachedCandidates) return Promise.resolve(cachedCandidates);
    const seq = ++probeSeq;
    const job = probeCandidates().then((out) => {
      if (seq === probeSeq) cachedCandidates = out;
      return out;
    });
    probing = job;
    const settled = () => {
      if (probing === job) probing = null;
    };
    job.then(settled, settled);
    return job;
  }

  /** @returns {Promise<import('../../platform/userTools.cjs').CliCandidate[]>} */
  async function probeCandidates() {
    const home = os.homedir();
    const highest = preferHighestCli();
    const list = isWin()
      ? [process.env.CLAUDE_BIN, path.join(home, '.claude', 'local', 'claude.exe'), ...windowsCandidates('claude', process.env)]
      : // the login shell's PATH and the user-tool folders every detector shares, then the install only Claude Code has
        [process.env.CLAUDE_BIN, ...toolCandidates(['claude'], [path.join(home, '.claude/local/claude')], highest)];
    // a folder's entries; none when there is no Claude desktop install (ENOENT) or the entry is not a folder
    // (ENOTDIR: a stray file such as .DS_Store), which skips only that entry
    const entries = (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch (error) {
        noteIgnored("list the Claude desktop app's Claude Code", error, ['ENOENT', 'ENOTDIR']);
        return [];
      }
    };
    if (isWin()) {
      // Claude desktop's bundled CLI: %APPDATA%\Claude\claude-code\<ver>[\<hash>]\claude.exe
      const root = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude-code');
      for (const v of entries(root)) {
        list.push(path.join(root, v, 'claude.exe'));
        for (const h of entries(path.join(root, v))) list.push(path.join(root, v, h, 'claude.exe'));
      }
    } else {
      // The CLI bundled with Claude desktop: ~/Library/Application Support/Claude/claude-code/<ver>/<hash>/claude.app
      const root = path.join(home, 'Library/Application Support/Claude/claude-code');
      for (const v of entries(root))
        for (const h of entries(path.join(root, v))) list.push(path.join(root, v, h, 'claude.app/Contents/MacOS/claude'));
    }
    const seen = new Set();
    /** @type {string[]} */
    const found = [];
    for (const c of list.filter(Boolean)) {
      if (highest ? !runnableTool(c) : !fs.existsSync(c)) continue;
      const real = fileKey(c);
      if (seen.has(real)) continue;
      seen.add(real);
      found.push(c);
    }
    // each asked at once, in its own process (a binary already asked is not run again); with how it was installed,
    // which Settings names it by
    const io = hostIo(shellEnv);
    const describe = (copy) => ({ ...copy, ...installSource('claude', copy.path, io), ...offPathFields(copy.path, ['claude']) });
    if (highest) return (await versionedToolCopies(found, versionOf)).map(describe);
    return Promise.all(found.map(async (bin) => describe({ path: bin, version: await versionOf(bin) })));
  }

  /** @returns {Promise<string | null>} the explicit path, else the best copy under the app's selection preference */
  async function findBinary(override) {
    if (override && fs.existsSync(override)) return override;
    return pick(await candidates());
  }

  /** @param {import('../../platform/userTools.cjs').CliCandidate[]} list */
  function pick(list) {
    const order = preferHighestCli() ? highestInstalls(list, 'claude') : preferredInstalls(list, 'claude');
    const best = order[0];
    return best ? best.path : null;
  }

  function run(bin, args, timeout = 15000, account, cwd) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const child = proc.execFile(
        ...spawnArgs(bin, args, { timeout, env: creds.cleanEnv(account), maxBuffer: 4 * 1024 * 1024, cwd }),
        (err, stdout, stderr) => {
          settled = true;
          clearTimeout(timer);
          if (err && !stdout) reject(new Error((stderr || err.message || '').trim()));
          else resolve(stdout);
        },
      );
      if (!settled) timer = deadline(timeout, reject, () => child);
    });
  }

  /** `claude mcp add|remove …` from Settings → Claude Code → Extensions, after the user saw the command. Nothing else runs. */
  async function mcpCommand(bin, args, account, cwd, mode) {
    if (mode !== undefined && mode !== creds.authMode())
      throw new Error('The Claude Code authentication mode changed. Refresh status and try again.');
    if (!Array.isArray(args) || args[0] !== 'mcp' || !['add', 'remove'].includes(args[1]) || args.some((a) => typeof a !== 'string'))
      throw new Error('Not an MCP command');
    const file = await findBinary(bin);
    if (!file) throw new Error('Claude Code is not installed');
    return (await run(file, args, 30000, account, cwd)).trim();
  }

  /** A terminal launches the CLI's own OAuth flow; only its config folder crosses IPC, never credentials. */
  async function mcpLoginCommand(bin, name, account, mode) {
    if (mode !== undefined && mode !== creds.authMode())
      throw new Error('The Claude Code authentication mode changed. Refresh status and try again.');
    if (typeof name !== 'string' || !name || name.startsWith('-') || name.includes('\0')) throw new Error('Invalid MCP server name');
    const file = await findBinary(bin);
    if (!file) throw new Error('Claude Code is not installed');
    const spec = launchSpec(file, ['mcp', 'login', name], {}, realIo());
    return {
      command: spec.options.windowsVerbatimArguments ? [spec.command] : [spec.command, ...spec.args],
      ...(spec.options.windowsVerbatimArguments ? { windowsCommandLine: spec.args.join(' ') } : {}),
      env: { CLAUDE_CONFIG_DIR: creds.cleanEnv(account).CLAUDE_CONFIG_DIR ?? null },
    };
  }

  /** Plan fields Claude Code caches in the account's .claude.json (detect passes the account already resolved), for display before the CLI is signed in. Never tokens. */
  function cachedPlan(account) {
    const p = state.accts?.cachedPlan(account);
    return p ? { organizationType: p.organizationType, rateLimitTier: p.rateLimitTier } : null;
  }

  /**
   * `auth status` only checks that credentials exist; a one-token call tells whether they still work.
   * @returns {Promise<'works' | 'failed' | 'unknown'>} unknown: the call failed some other way (no network, an API error)
   */
  async function loginCheck(bin, account) {
    const lapsed = /Failed to authenticate|Invalid API key|OAuth (access )?token has expired|Re-authenticate/i;
    // a lapsed login, or one the provider refuses for its organization (shared/loginRefused.mjs): either cannot run Claude Code
    const authError = { test: (text) => lapsed.test(text) || isLoginRefused(text) };
    try {
      // the CLI prints the 401 on stdout and still exits non-zero, which run() treats as success
      const out = await run(bin, ['-p', 'hi', '--model', 'haiku', '--max-turns', '1', '--no-session-persistence'], 60000, account);
      return authError.test(out) ? 'failed' : /API Error|Connection error/i.test(out) ? 'unknown' : 'works';
    } catch (e) {
      return authError.test(String(e.message || e)) ? 'failed' : 'unknown';
    }
  }

  /** The version the last detect found (telemetry reports it). */
  /** @type {string | null} */
  let detectedVersion = null;
  const version = () => detectedVersion;

  /** The CLI and the login of the account in use (or `account`). */
  async function detect(override, force, verify, account) {
    const cands = await candidates(force);
    const bin = override && fs.existsSync(override) ? override : pick(cands);
    account = account ?? state.activeAccount();
    const plan = cachedPlan(account);
    if (!bin) return { state: 'missing', bin: null, version: null, candidates: cands, plan, account };
    // a path set by hand in Settings isn't among the candidates
    const known = cands.find((c) => c.path === bin);
    const version = known ? known.version : await versionOf(bin);
    // whether the user's terminal runs that same claude (the Claude Code page says when it doesn't)
    const { path: _path, version: _version, ...offPath } = known ?? { path: bin, version, ...offPathFields(bin, ['claude']) };
    detectedVersion = version || detectedVersion;
    // the harness state (`state` below is the login's)
    const loginWorksAgain = (id) => state.onLoginWorks(id);
    try {
      const auth = parseClaudeStatus(await run(bin, ['auth', 'status', '--json'], 15000, account));
      const mode = creds.authMode();
      const base = creds.readBase();
      const cloud = creds.cloudRoute();
      const billing = claudeBilling(mode, base, auth.authMethod, cloud);
      let state = billing.mode !== 'subscription' ? 'apikey' : !auth.loggedIn ? 'signin' : 'ready';
      /** @type {string | null} */
      let rejected = null;
      if (verify && (state === 'ready' || state === 'apikey')) {
        const sig = creds.billingSig();
        const check = await loginCheck(bin, account);
        // a check that could not tell counts as working: only an authentication error is a lapsed login, and a key,
        // credits or a cloud account that was refused is that credential's problem, not a sign-in. A credential
        // changed during the call was not the one refused: that check tells nothing (the change re-checks).
        if (check === 'failed' && creds.billingSig() === sig) {
          rejected = rejectedCredential(mode, base, cloud);
          state = rejected ? 'error' : 'signin';
        }
        // the login itself answered (not a key, credits or a cloud account, before and after the call): it works again
        else if (check === 'works' && sig === 'subscription' && creds.billingSig() === sig) loginWorksAgain(account);
      }
      return {
        state,
        bin,
        version,
        ...offPath,
        candidates: cands,
        plan,
        account,
        billing,
        auth: {
          loggedIn: auth.loggedIn,
          authMethod: auth.authMethod ?? null,
          apiProvider: auth.apiProvider ?? null,
          subscriptionType: auth.subscriptionType ?? null,
        },
        ...(rejected ? { error: rejected, rejected: true } : {}),
      };
    } catch (e) {
      return { state: 'error', bin, version, ...offPath, candidates: cands, plan, account, error: String(e.message || e) };
    }
  }

  return { versionOf, takesPluginDirs, candidates, findBinary, run, mcpCommand, mcpLoginCommand, cachedPlan, loginCheck, version, detect };
}

module.exports = { createCli, isWin, unrefTimer, sdkBin };
