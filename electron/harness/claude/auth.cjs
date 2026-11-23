// Which credential the Claude Code CLI runs on (its own login, an Anthropic API key, MoPilot credits, a cloud provider, or a model config
// of the user's own provider through MoPilot's model router) and the environment it gets.
// The one credential Sage keeps is the optional API key: encrypted with safeStorage in a private file (secretFile.cjs),
// never sent to the renderer beyond whether one is set and its last four characters (see electron/harness/claude/index.cjs).
// @host-portable: loads in the Host process without Electron (host/boundary.json)
const path = require('node:path');
const { createHash } = require('node:crypto');
const { identityKey } = require('../../../shared/identityKey.mjs');
const { fs } = require('../../platform/ports/fs.cjs');
const { paths } = require('../../platform/ports/paths.cjs');
const { secrets } = require('../../platform/ports/secrets.cjs');
const { API_BASE } = require('../../platform/install.cjs');
const { claudeBilling, loginBilling } = require('../../identity/contract/claudeBilling.cjs');
const shellEnv = require('../../platform/env.cjs');
const { loopbackDirect } = require('../../platform/loopbackHttp.cjs');
const { writeAtomic, writePrivate } = require('../../platform/fsutil.cjs');
const { readSecret, writeSecret, canEncrypt } = require('../../platform/secretFile.cjs');
const { noteIgnored, messageOf } = require('../../ignored.cjs');
const { artifactEnv, createArtifacts } = require('./artifacts.cjs');

/* ------------------------------------------------------------------ */
/* environment                                                         */
/* ------------------------------------------------------------------ */
// Only authentication and parent-session identity are scrubbed (they would override the user's own
// CLI login or make it think it runs inside another session). Feature variables the user exported
// (ANTHROPIC_MODEL, CLAUDE_CODE_MAX_OUTPUT_TOKENS, proxies, …) reach the CLI. One list, shared with
// the login-shell snapshot.
const AUTH_ENV = shellEnv.AUTH_IDENTITY_ENV;

/* ------------------------------------------------------------------ */
/* API key                                                             */
/* ------------------------------------------------------------------ */
const keyFile = () => path.join(paths.userData(), 'claude-api-key.json');
/** Where versions before encryption kept the key in plain text; moved into keyFile and deleted when first read. */
const plainKeyFile = () => path.join(paths.userData(), 'claude-api-key');
/** The process's safeStorage (Electron's, or the Host's), looked up when used; null in a process without one. */
const safe = () => secrets.safeStorage();
const cloudFile = () => path.join(paths.userData(), 'claude-cloud-env');
const modeFile = () => path.join(paths.userData(), 'claude-auth-mode');
const baseFile = () => path.join(paths.userData(), 'claude-api-base');
/** The model config (electron/routing/configs.cjs) "Your own provider" runs on. */
const routedFile = () => path.join(paths.userData(), 'claude-routed-config');
/** Where routed mode points the CLI while MoPilot's model router isn't listening: a port nothing can answer on. */
const NO_ROUTER = 'http://127.0.0.1:0/mopilot-router-not-running';
/** The modes that can be chosen. */
const MODES = new Set(['subscription', 'apiKey', 'mopilot', 'routed']);

/** Validates an optional endpoint; '' means Anthropic's own API. */
function normalizeBase(raw) {
  raw = String(raw ?? '').trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('That endpoint isn’t a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The endpoint must start with https://');
  return u.toString().replace(/\/+$/, '');
}

/**
 * @param {import('./state.cjs').ClaudeState} state
 * @param {{ restartIdle: () => void }} deps the live CLIs (electron/harness/claude/sessions.cjs), looked up when a credential changes
 */
function createAuth(state, deps) {
  let cloudCache; // opt-in to the shell's cloud-provider variables (D-35); undefined = not read yet
  let processCloud = {}; // cloud switches this process was launched with, taken out of process.env at startup
  let baseCache; // custom endpoint for the key (a gateway such as OpenRouter or LiteLLM); null = Anthropic's own
  let apiKeyCache; // undefined = not read yet, null = none
  let modeCache; // 'subscription' | 'apiKey' | 'mopilot' | 'routed'; undefined = not read yet
  let routedCache; // the routed mode's config id; undefined = not read yet, null = none
  // whether sessions get Claude Code's Artifact tool (Settings), restarting idle ones when it changes
  const artifacts = createArtifacts({ restartIdle: () => deps.restartIdle() });

  /** Which credential the CLI runs on. A stored key doesn't change the login; this switch decides. */
  function authMode() {
    if (modeCache === undefined) {
      try {
        const m = fs.readFileSync(modeFile(), 'utf8').trim();
        modeCache = MODES.has(m) ? m : 'subscription';
      } catch {
        modeCache = 'subscription';
      }
    }
    if (modeCache === 'apiKey' && readApiKey()) return 'apiKey';
    if (modeCache === 'mopilot' && state.gatewayKey()) return 'mopilot';
    // a config that was removed stays chosen: its chats say so rather than paying another way unasked
    if (modeCache === 'routed' && routing() && routedId()) return 'routed';
    return 'subscription';
  }

  /** MoPilot's model router, where this process has one (main wires it; a Host's state has none). */
  const routing = () => state.routing?.() ?? null;

  /** The id of the model config routed mode runs on; null when none was chosen. */
  function routedId() {
    if (routedCache === undefined) {
      try {
        routedCache = fs.readFileSync(routedFile(), 'utf8').trim() || null;
      } catch (error) {
        // none chosen yet (ENOENT)
        noteIgnored('read the model config Claude Code runs on', error, ['ENOENT']);
        routedCache = null;
      }
    }
    return routedCache;
  }

  /** The routed mode's config, as the router has it now; none when none was chosen, it was removed or there is no router. */
  const routedConfig = () => {
    const id = routedId();
    return id ? routing()?.configOf(id) : null;
  };

  /** The CLI login's auth method for an account, as the account list last read it; null when unknown. */
  function authMethodOf(account) {
    try {
      return state.accts?.view()?.accounts?.find((a) => a.id === account)?.authMethod ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Whether a user session runs with the vendor-native Claude in Chrome, like the official Claude Code:
   * the remote switch is on, the session bills a claude.ai subscription (OAuth login, no key, no MoPilot
   * credits) and is not routed through a cloud provider (Bedrock, Vertex, ...). Claude in Chrome needs
   * the claude.ai login, so every other session keeps --no-chrome rather than failing at its first use.
   */
  function nativeChromeFor(account) {
    return state.sageTools?.nativeChrome?.() === true && claudeAiFor(account);
  }

  /** Whether a login's session bills a claude.ai subscription: no key, no MoPilot credits, no cloud provider. */
  const claudeAiFor = (account) => claudeBilling(authMode(), readBase(), authMethodOf(account), cloudRoute()).mode === 'subscription';

  /**
   * What a chat's capabilities need of the Artifact tool: the switch new sessions start with, whether the live session
   * `key` listed the tool in its init (null before one has), whether that process started on another switch value
   * (its next process gets the current one), and whether the login is a claude.ai subscription.
   */
  function artifactsOf(key, account) {
    const on = artifacts.artifactsOn();
    const s = key ? state.sessions.get(key) : undefined;
    return { on, tool: s?.artifactTool ?? null, stale: !!s && s.artifactsAt !== on, claudeAi: claudeAiFor(account) };
  }

  /** Whether the user chose to pass their shell's cloud-provider variables to Claude Code (off by default). */
  function cloudEnvOn() {
    if (cloudCache === undefined) cloudCache = fs.existsSync(cloudFile());
    return cloudCache;
  }

  /** The cloud-provider switches available to pass on: the login shell's, then this process's own. */
  const cloudVars = () => ({ ...shellEnv.cloudVars(), ...processCloud });

  /** The opt-in is on and the shell really exports a provider switch, so Claude Code bills the cloud account. */
  const cloudRoute = () => cloudEnvOn() && Object.keys(cloudVars()).some((k) => k.startsWith('CLAUDE_CODE_USE_'));

  function setCloudEnv(on) {
    cloudCache = !!on;
    try {
      if (on) fs.writeFileSync(cloudFile(), '1', { mode: 0o600 });
      else fs.rmSync(cloudFile(), { force: true });
    } catch (error) {
      // the in-memory cache still holds the choice for this run
      noteIgnored('save the Claude Code cloud-provider choice', error);
    }
    deps.restartIdle();
    return apiKeyInfo();
  }

  function writeMode(mode) {
    modeCache = mode;
    try {
      writeAtomic(modeFile(), mode);
    } catch (error) {
      // the in-memory cache still holds the choice for this run
      noteIgnored('save how Claude Code pays', error);
    }
  }

  function readApiKey() {
    if (apiKeyCache !== undefined) return apiKeyCache;
    apiKeyCache = null;
    // a plain key, from an earlier version or one a downgrade wrote since, is dealt with first: never left beside it
    const plain = migratePlainKey();
    if (plain) return (apiKeyCache = plain);
    try {
      apiKeyCache = readSecret(keyFile(), safe())?.value || null;
    } catch (error) {
      // a key saved under another OS key, or the keychain refusing for now: none this time, read again next time
      noteIgnored('read the saved Claude API key', error);
      apiKeyCache = undefined;
      return null;
    }
    return apiKeyCache;
  }

  /**
   * A key kept in plain text (an earlier version, or one a downgrade wrote since): the newer of it and the encrypted
   * key is kept, encrypted, and the plain copy deleted. Returns the plain key when it is the one to use (it could not
   * be encrypted, or it was newer), else null (the encrypted one is read).
   */
  function migratePlainKey() {
    /** @type {string | null} */
    let key = null;
    try {
      key = fs.readFileSync(plainKeyFile(), 'utf8').trim() || null;
    } catch (error) {
      // no plain key (ENOENT): nothing to move
      noteIgnored('read the plain Claude API key of an earlier version', error, ['ENOENT']);
    }
    const sealed = fs.statSync(keyFile(), { throwIfNoEntry: false });
    // the encrypted key is the newer one: the plain copy only goes
    if (key && sealed && sealed.mtimeMs > fs.statSync(plainKeyFile()).mtimeMs) {
      fs.rmSync(plainKeyFile(), { force: true });
      return null;
    }
    if (!key || !canEncrypt(safe())) return key;
    try {
      writeSecret(keyFile(), key, safe(), 'the API key');
      fs.rmSync(plainKeyFile(), { force: true });
    } catch (error) {
      // the plain copy stays until a later read can move it; the key still works this run
      noteIgnored('encrypt the plain Claude API key of an earlier version', error);
    }
    return key;
  }

  function readBase() {
    if (baseCache === undefined) {
      try {
        baseCache = fs.readFileSync(baseFile(), 'utf8').trim() || null;
      } catch (error) {
        // no endpoint saved (ENOENT): Anthropic's own
        noteIgnored('read the endpoint of the saved Claude API key', error, ['ENOENT']);
        baseCache = null;
      }
    }
    return baseCache;
  }

  /**
   * The endpoint and headers to call Anthropic's API with the key MoPilot holds, for the vision fallback
   * (a text-only model's screen read by Anthropic's own vision model). Null unless the chat runs on that
   * key, on Anthropic's own endpoint: a CLI login has no key to call with, and a key is never sent to
   * another host.
   */
  function visionAuth() {
    if (authMode() !== 'apiKey' || cloudEnvOn() || readBase()) return null;
    const key = readApiKey();
    return key ? { baseUrl: 'https://api.anthropic.com', headers: { 'x-api-key': key } } : null;
  }

  function apiKeyInfo() {
    const k = readApiKey();
    return {
      set: !!k,
      hint: k ? k.slice(-4) : null,
      mode: authMode(),
      baseUrl: readBase(),
      cloudEnv: cloudEnvOn(),
      cloudDetected: Object.keys(cloudVars()).length > 0,
      // the model config "Your own provider" runs on (its name null once removed); available: this process has the router
      routed: { available: !!routing(), configId: routedId(), name: routedConfig()?.name ?? null },
    };
  }

  function setApiKey(key, baseUrl) {
    key = String(key ?? '').trim();
    const base = normalizeBase(baseUrl);
    if (!key) throw new Error('Enter an API key');
    if (/\s/.test(key)) throw new Error('That doesn’t look like an API key');
    writeSecret(keyFile(), key, safe(), 'the API key');
    fs.rmSync(plainKeyFile(), { force: true });
    apiKeyCache = key;
    baseCache = base;
    if (base) writePrivate(baseFile(), base);
    else fs.rmSync(baseFile(), { force: true });
    writeMode('apiKey'); // adding a key means using it; switch back from Settings
    deps.restartIdle(); // running turns finish on the old credentials; the next turn starts on the new ones (D-34)
    return apiKeyInfo();
  }

  function clearApiKey() {
    // force ignores a missing file. A key that can't be deleted stays saved and in use, and the user is
    // told, rather than shown as removed while it stays on disk.
    try {
      fs.rmSync(keyFile(), { force: true });
      fs.rmSync(plainKeyFile(), { force: true });
    } catch (error) {
      throw new Error(`Couldn't remove the API key: ${messageOf(error)}`);
    }
    apiKeyCache = null;
    baseCache = null;
    try {
      fs.rmSync(baseFile(), { force: true });
    } catch (error) {
      // only the endpoint is left: the next key saved replaces or removes it
      noteIgnored('remove the endpoint of a removed Claude API key', error);
    }
    if (modeCache === 'apiKey') writeMode('subscription');
    deps.restartIdle();
    return apiKeyInfo();
  }

  /** @param {unknown} mode @param {unknown} [configId] the model config, for 'routed' */
  function setAuthMode(mode, configId) {
    if (typeof mode !== 'string' || !MODES.has(mode)) throw new Error('Unknown mode');
    if (mode === 'apiKey' && !readApiKey()) throw new Error('Add an API key first');
    if (mode === 'mopilot' && !state.gatewayKey()) throw new Error('Sign in to MoPilot first');
    if (mode === 'routed') {
      if (!routing()) throw new Error('Your own provider works only in the MoPilot app');
      if (typeof configId !== 'string' || !routing()?.configOf(configId)) throw new Error('Choose a saved model config first');
    }
    const id = mode === 'routed' ? /** @type {string} */ (configId) : routedId();
    if (mode !== authMode() || id !== routedId()) {
      if (id !== routedId()) writeRouted(id);
      writeMode(mode);
      deps.restartIdle();
    }
    return apiKeyInfo();
  }

  /** @param {string | null} id */
  function writeRouted(id) {
    routedCache = id;
    try {
      if (id) writeAtomic(routedFile(), id);
    } catch (error) {
      // the in-memory cache still holds the choice for this run
      noteIgnored('save the model config Claude Code runs on', error);
    }
  }

  /** What the CLI's credentials are: two sessions with the same signature run on the same billing. */
  function billingSig() {
    if (cloudRoute()) return `cloud:${Object.keys(cloudVars()).sort().join(',')}`;
    const mode = authMode();
    if (mode === 'mopilot') return `mopilot:${state.gatewayKey()}`;
    if (mode === 'apiKey') return identityKey('apiKey', readBase(), readApiKey());
    if (mode === 'routed') {
      // the config as saved (a changed model or fallback restarts idle CLIs) and where the router listens, never the token in the clear
      // authMode() is 'routed' only with the router and a config id
      const r = /** @type {NonNullable<ReturnType<typeof state.routing>>} */ (routing());
      const id = /** @type {string} */ (routedId());
      const seen = JSON.stringify([id, r.configOf(id), r.baseFor(id), r.token]);
      return `routed:${createHash('sha256').update(seen).digest('hex').slice(0, 32)}`;
    }
    return 'subscription';
  }

  /**
   * Whether a session process started on what only a new process changes: its billing (`s.billing`, billingSig) and
   * the Artifact switch (`s.artifactsAt`, which sessionEnv notes; CLAUDE_CODE_ARTIFACT is read when the CLI starts).
   * An idle process that is stale is restarted.
   */
  const sessionStale = (s) => s.billing !== billingSig() || s.artifactsAt !== artifacts.artifactsOn();

  /**
   * MoPilot signed in or out. Signing in changes nothing until the user picks MoPilot credits; signing out
   * goes back to the subscription (a login, or none signed in) and restarts idle processes that ran on the
   * revoked key. A saved API key stays saved but is never taken up on its own: paying per use is the
   * user's choice (shared/switch.mjs).
   */
  function mopilotChanged() {
    if (modeCache === 'mopilot' && !state.gatewayKey()) writeMode('subscription');
    deps.restartIdle();
  }

  /**
   * The CLI's environment: the login shell's (auth and parent-session variables already dropped from
   * it), inherited auth scrubbed, plus the account's config folder (`account` omitted = the one in use).
   */
  function cleanEnv(account) {
    const base = {};
    for (const [k, v] of Object.entries(process.env)) if (!AUTH_ENV.test(k)) base[k] = v;
    const env = shellEnv.childEnv(base);
    const mode = authMode();
    if (cloudRoute()) {
      // The user's own cloud account pays: the provider switches decide the route, so no Sage key or gateway is set.
      Object.assign(env, cloudVars());
    } else if (mode === 'mopilot') {
      // The gateway serves /v1/messages under the origin; Claude Code appends the path itself.
      // authMode() is 'mopilot' only while there is a gateway key, which only a build with the MoPilot service has
      env.ANTHROPIC_BASE_URL = /** @type {string} */ (API_BASE);
      env.ANTHROPIC_AUTH_TOKEN = /** @type {string} */ (state.gatewayKey());
      env.ANTHROPIC_API_KEY = '';
    } else if (mode === 'apiKey') {
      const base = readBase();
      if (base) {
        // A gateway takes the key as a bearer token; an empty API key keeps Anthropic's own from taking over.
        env.ANTHROPIC_BASE_URL = base;
        env.ANTHROPIC_AUTH_TOKEN = readApiKey();
        env.ANTHROPIC_API_KEY = '';
      } else env.ANTHROPIC_API_KEY = readApiKey();
    } else if (mode === 'routed') {
      // The router holds the provider's key: the CLI is given only the router's base under its secret path and its token, and
      // reaches it directly, never through a proxy the shell sets. Before the router listens, an address nothing answers on:
      // a version or catalog read still works, and a model request fails rather than going to the CLI's own login.
      const r = /** @type {NonNullable<ReturnType<typeof state.routing>>} */ (routing());
      Object.assign(env, loopbackDirect(env));
      env.ANTHROPIC_BASE_URL = r.baseFor(/** @type {string} */ (routedId())) ?? NO_ROUTER;
      env.ANTHROPIC_AUTH_TOKEN = r.token;
      env.ANTHROPIC_API_KEY = '';
    }
    if (state.accts)
      Object.assign(env, mode === 'subscription' ? state.accts.env(account ?? state.activeAccount()) : state.accts.keyEnv(mode));
    return env;
  }

  /**
   * A session's environment: cleanEnv with the Artifact switch applied, noted on `started` (the session) for
   * sessionStale. Helper queries keep cleanEnv.
   * @param {string | undefined} account
   * @param {Record<string, any>} [started] the session, given artifactsAt
   */
  function sessionEnv(account, started) {
    const env = cleanEnv(account);
    // a chat says why it can't start rather than failing at its first request
    if (env.ANTHROPIC_BASE_URL === NO_ROUTER)
      throw new Error("MoPilot's model router isn't running. Quit and reopen MoPilot, or choose another way to pay in Settings.");
    const on = artifacts.artifactsOn();
    if (started) started.artifactsAt = on;
    return artifactEnv(env, on);
  }

  /** The account folder id a CLI run is using: the login's, or the folder of the key in use. */
  const configIdOf = (account) => {
    const mode = authMode();
    return mode === 'subscription' ? (account ?? state.activeAccount()) : state.accts?.keyId(mode);
  };

  /** Drop inherited auth variables from this process, so the codex app-server and terminals don't get them either. */
  function scrubProcessEnv() {
    processCloud = { ...processCloud, ...shellEnv.pickCloud(process.env) };
    for (const k of Object.keys(process.env)) if (AUTH_ENV.test(k)) delete process.env[k];
  }

  /**
   * How the request ledger names a session's account (electron/ledger/accounts.cjs claudeLedgerAccount's options, beside the
   * logins' view): the key modes as set now, a login's own billing (a Console login is paid per use), and how a session's process
   * was started to pay, which a busy process keeps after the setting changes (its billingSig, never the key it may carry).
   */
  const ledgerMarks = {
    authMode,
    cloud: cloudRoute,
    loginPay: (/** @type {string | null | undefined} */ m) => (loginBilling(m) === 'apiKey' ? 'key' : 'plan'),
    billingOf: (/** @type {string} */ key) => billingKind(state.sessions.get(key)?.billing),
  };

  return {
    ledgerMarks,
    authMode,
    routedId,
    routedConfig,
    authMethodOf,
    nativeChromeFor,
    cloudEnvOn,
    cloudVars,
    cloudRoute,
    setCloudEnv,
    readApiKey,
    readBase,
    visionAuth,
    apiKeyInfo,
    setApiKey,
    clearApiKey,
    setAuthMode,
    billingSig,
    sessionStale,
    mopilotChanged,
    cleanEnv,
    sessionEnv,
    artifacts,
    artifactsOf,
    configIdOf,
    scrubProcessEnv,
  };
}

/** How a session's billing signature (billingSig) pays, without the key it may carry. @param {unknown} sig */
function billingKind(sig) {
  if (sig === 'subscription' || typeof sig !== 'string') return sig === 'subscription' ? 'subscription' : 'unknown';
  for (const kind of ['cloud', 'mopilot', 'routed']) if (sig.startsWith(`${kind}:`)) return kind;
  return 'apiKey';
}

module.exports = { createAuth, normalizeBase, AUTH_ENV, billingKind };
