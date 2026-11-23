// The login shell's environment. Apps launched from the Dock or Finder get launchd's minimal env, so
// CLIs in ~/.local/bin, nvm, ~/.bun/bin or ~/.npm-global/bin aren't on PATH and the user's exported
// variables are missing. At startup we run `$SHELL -ilc 'env -0'` once (5 s cap), cache the result,
// and use it to find harness binaries and to spawn child processes. On failure we fall back to the
// app's own env with a widened PATH.
// Windows: GUI apps already get the user's full environment from Explorer, so there is no login
// shell to ask; children get this process's env as is, and `which` follows PATH and PATHEXT.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');
const { defaultUserDirs } = require('./userDirs.cjs');

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const TIMEOUT_MS = 5000;
// Printed before `env -0` so whatever the shell's rc files echo first can be skipped.
const MARKER = '__MOPILOT_ENV_SNAPSHOT__';
// Shell bookkeeping that describes the snapshot's own shell, not the user's environment.
const SHELL_LOCAL = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
const isWin = process.platform === 'win32';

/**
 * Auth and parent-session identity: these would override the CLI's own login or make it think it
 * runs inside another Claude Code session, so they never come from the snapshot. The account a host
 * names for the token it passes (Claude Desktop's CLAUDE_CODE_ACCOUNT_UUID, _USER_EMAIL, _ORGANIZATION_UUID)
 * goes with that token: the CLI would write it into a config that names no account yet. Everything else a
 * user exports (CLAUDE_CODE_MAX_OUTPUT_TOKENS, proxies, nvm, …) passes through.
 */
const AUTH_IDENTITY_ENV =
  /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS)|CLAUDE_CODE_(OAUTH_[A-Z0-9_]+|SESSION_ACCESS_TOKEN|ARTIFACTS_API_TOKEN|CLIENT_(KEY|KEY_PASSPHRASE|CERT)|USE_[A-Z0-9_]+|SKIP_[A-Z0-9_]+_AUTH|CUSTOM_OAUTH_URL|HOST_[A-Z0-9_]+|PROVIDER_MANAGED_BY_HOST|[A-Z_]*FILE_DESCRIPTOR|ENTRYPOINT|SSE_PORT|REMOTE[A-Z0-9_]*|SDK_[A-Z0-9_]+|CHILD_SESSION|ACCOUNT_UUID|USER_EMAIL|ORGANIZATION_UUID)|CLAUDE_AGENT_SDK_[A-Z0-9_]+|CLAUDECODE)$/;

/**
 * The cloud-provider switches inside AUTH_IDENTITY_ENV: a shell that exports one of these would send a
 * Claude Code chat to Bedrock, Vertex or Foundry and bill that cloud account. Dropped unless the user
 * opts in under Settings → Claude Code (D-35); the AWS_*, GOOGLE_* and ANTHROPIC_VERTEX_* variables that
 * configure the route are not auth overrides and always pass through.
 */
const CLOUD_PROVIDER_ENV = /^CLAUDE_CODE_(USE_(BEDROCK|VERTEX|FOUNDRY|MANTLE)|SKIP_(BEDROCK|VERTEX|FOUNDRY|MANTLE)_AUTH)$/;

/** The cloud-provider switches in `env` (what the opt-in hands to Claude Code). */
function pickCloud(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (CLOUD_PROVIDER_ENV.test(k) && v != null) out[k] = String(v);
  return out;
}

/** `env -0` output (NUL-separated KEY=value) → object. Anything before the marker is ignored. */
function parseEnv0(text) {
  let s = String(text ?? '');
  const at = s.indexOf(MARKER + '\0');
  if (at >= 0) s = s.slice(at + MARKER.length + 1);
  const env = {};
  for (const entry of s.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = entry.slice(eq + 1);
  }
  return env;
}

/** A copy of `env` without auth / parent-session variables and shell bookkeeping; `cloud` keeps the cloud-provider switches. */
function scrubSnapshot(env, { cloud = false } = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env || {}))
    if ((!AUTH_IDENTITY_ENV.test(k) || (cloud && CLOUD_PROVIDER_ENV.test(k))) && !SHELL_LOCAL.has(k)) out[k] = v;
  return out;
}

/**
 * PATH with the usual system and Homebrew dirs appended, then the user-tool folders (userDirs.cjs: nvm's default Node,
 * volta, bun, ~/.local/bin, …) a login shell that didn't answer, or doesn't export them, leaves out; deduplicated.
 * A CLI found there also finds what it runs beside it (an npm CLI's `#!/usr/bin/env node`).
 */
function widenPath(p, vars = dirVars()) {
  return [...new Set([...String(p || '').split(':'), ...EXTRA_PATH, ...defaultUserDirs(vars)].filter(Boolean))].join(':');
}

function defaultShell(env = process.env, platform = process.platform) {
  if (env.SHELL) return env.SHELL;
  try {
    const shell = os.userInfo().shell;
    if (shell) return shell;
  } catch (error) {
    // userInfo can throw for users without a passwd entry; use the default
    noteIgnored("read the user's login shell", error);
  }
  return platform === 'linux' ? '/bin/sh' : '/bin/zsh';
}

/**
 * Run the login shell once and read its environment. Resolves {ok, env, error}; never rejects.
 * The shell starts from a bare env (what launchd would give it), so the result is what the user's
 * profile sets up, not what this process inherited.
 */
function capture({ shell = defaultShell(), timeoutMs = TIMEOUT_MS, env = process.env, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    /** @type {Record<string, string>} */
    const base = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb' };
    for (const k of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'])
      if (env[k]) base[k] = env[k];
    base.SHELL = shell;
    let proc;
    try {
      proc = spawnFn(shell, ['-ilc', `printf '%s\\0' ${MARKER}; command env -0`], {
        env: base,
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      });
    } catch (e) {
      return resolve({ ok: false, env: null, error: String(e?.message || e) });
    }
    const chunks = [];
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    // rc files can start background jobs or wait for input; kill the whole group on timeout
    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch (error) {
          // the process already exited
          noteIgnored('stop a login shell that timed out', error, ['ESRCH']);
        }
      }
      finish({ ok: false, env: null, error: `login shell timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    proc.stdout?.on('data', (d) => chunks.push(d));
    proc.on('error', (e) => finish({ ok: false, env: null, error: String(e?.message || e) }));
    proc.on('close', (code) => {
      const out = Buffer.concat(chunks).toString('utf8');
      const parsed = parseEnv0(out);
      if (!out.includes(MARKER) || !parsed.PATH)
        return finish({ ok: false, env: null, error: `login shell exited ${code} without an environment` });
      finish({ ok: true, env: parsed, error: null });
    });
  });
}

/** @type {Record<string, string> | null} scrubbed env from the login shell, or null (not captured / failed) */
let snapshot = null;
/** @type {Record<string, string>} the cloud-provider switches the login shell exports, kept apart for the opt-in */
let cloudSnapshot = {};
/** @type {string | null} */
let lastError = null;
/** @type {Promise<boolean> | null} */
let pending = null;

/** Start capturing (once); resolves when done. Later calls return the same promise. */
function init(opts) {
  if (isWin && !opts?.spawnFn) return (pending ??= Promise.resolve(false));
  pending ??= capture(opts).then((r) => {
    snapshot = r.ok ? scrubSnapshot(r.env) : null;
    cloudSnapshot = r.ok ? pickCloud(r.env) : {};
    lastError = r.error;
    return r.ok;
  });
  return pending;
}
const ready = () => pending ?? Promise.resolve(false);

/**
 * The env for a child process: the snapshot, then `base` (default: this process's) on top, since a
 * variable this process has was set on purpose (or by the terminal it was launched from). PATH is
 * the snapshot's, then base's, then the usual system dirs.
 */
function childEnv(base = process.env, snap = snapshot, platform = process.platform) {
  // Windows keys are case-insensitive (Path); widening with ':' would split drive letters
  if (platform === 'win32')
    return Object.fromEntries(
      Object.entries(base)
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, String(v)]),
    );
  /** @type {Record<string, string>} */
  const env = { ...(snap || {}) };
  for (const [k, v] of Object.entries(base)) if (v != null) env[k] = String(v);
  env.PATH = widenPath([snap?.PATH, base.PATH].filter(Boolean).join(':'));
  if (extraEnv) {
    try {
      Object.assign(env, extraEnv(env));
    } catch (error) {
      // a failing env hook keeps the base environment rather than blocking the spawn
      noteIgnored('add the extra environment for a child process', error);
    }
  }
  return env;
}

/** @type {((env: Record<string, string>) => Record<string, string>) | null} */
let extraEnv = null;

/** Variables that point git at another repository than the folder a command names: a dotfiles setup exports them. */
const GIT_LOCATION_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
];

/**
 * The env for the git and gh main runs on a folder of its own choosing: childEnv(), without the GIT_* variables that
 * would send it to another repository (a login shell's `export GIT_DIR=~/.dotfiles`).
 */
function gitEnv() {
  const env = childEnv();
  for (const k of GIT_LOCATION_ENV) delete env[k];
  return env;
}

/**
 * Variables every child process gets on top (the $BROWSER shim: capabilities/browser/browserShim.cjs);
 * `fn(env)` sees the env so far. Only main's own children: Electron's own process.env is untouched.
 * @param {((env: Record<string, string>) => Record<string, string>) | null} fn
 */
function setExtraEnv(fn) {
  extraEnv = typeof fn === 'function' ? fn : null;
}

/** Executables named `name` on the child PATH, in lookup order. */
function* pathMatches(name, envPath, platform = process.platform) {
  if (platform === 'win32') {
    const { pathLookup, getEnv } = require('./winbin.cjs');
    const env = envPath != null ? { PATH: envPath, PATHEXT: getEnv(process.env, 'PATHEXT') } : process.env;
    for (const p of pathLookup(name, env)) if (fs.existsSync(p)) yield p;
    return;
  }
  envPath ??= childEnv().PATH;
  for (const dir of envPath.split(':')) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) yield p;
    } catch (error) {
      // not present (ENOENT, ENOTDIR) or not executable here (EACCES): try the next folder
      noteIgnored(`look for ${name} on PATH`, error, ['ENOENT', 'ENOTDIR', 'EACCES']);
    }
  }
}

/** First executable named `name` on the child PATH (snapshot PATH, or the widened fallback). */
const which = (name, envPath, platform = process.platform) => pathMatches(name, envPath, platform).next().value ?? null;

/** Every match, including installs shadowed by a directory earlier on PATH. */
const whichAll = (name) => [...pathMatches(name, undefined)];

/** The variables that say where version managers keep their folders: the login shell's, under this process's. */
const dirVars = () => ({ ...(snapshot || {}), ...process.env });

/**
 * The PATH a terminal opened now searches, for telling whether it runs the CLI MoPilot found: the login shell's
 * (Windows: this process's, which Explorer gave the full user PATH); null when the login shell didn't answer.
 */
function loginPath(platform = process.platform) {
  if (platform === 'win32') return require('./winbin.cjs').getEnv(process.env, 'PATH') ?? null;
  return snapshot?.PATH ?? null;
}

/** The cloud-provider switches from the login shell (not part of childEnv). */
const cloudVars = () => ({ ...cloudSnapshot });

const status = () => ({ captured: !!snapshot, error: lastError });

module.exports = {
  init,
  ready,
  childEnv,
  gitEnv,
  setExtraEnv,
  which,
  whichAll,
  loginPath,
  dirVars,
  status,
  parseEnv0,
  scrubSnapshot,
  pickCloud,
  cloudVars,
  CLOUD_PROVIDER_ENV,
  widenPath,
  capture,
  defaultShell,
  AUTH_IDENTITY_ENV,
  MARKER,
};
