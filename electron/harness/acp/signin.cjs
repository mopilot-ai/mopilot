// Signing a basic harness in over ACP (authenticate), and telling a failure that means "sign in first" (or "set it up
// first": no model provider) from any other.
const { processesOf, resolvedAgent } = require('./launch.cjs');
const { AcpAgent } = require('./agent.cjs');
const { isAuthText } = require('../../../shared/acpAuth.mjs');

/** How long a sign-in in a process started only for it may take (a browser or device-code login) before it goes. */
const LOGIN_MS = 15 * 60_000;

/**
 * Whether an ACP error means the harness wants a login first (ACP's auth_required code, or a login message). Only the
 * agent's own message counts (`said`), not the detail it adds in data, which may be a tool's or another service's.
 */
const isAuthError = (e) => e?.code === -32000 || isAuthText(String(e?.said ?? e?.message ?? ''));

/**
 * Why a harness reads Signed out, or null for the plain "Sign in to … first": the setup its quirks name, else the
 * agent's own words when they say more than "sign in" (#1319 G27: Gemini CLI answers its retired Google login with
 * auth_required and a note to move to another product, which a fresh sign-in can't fix).
 */
function signInReason(failure) {
  if (failure?.setup) return failure.setup;
  const said = String(failure?.said ?? failure?.message ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return said && !isAuthText(said) ? said.slice(0, 300) : null;
}

/**
 * A failure its quirks say means the harness has nothing to run a turn with (`setup.error`: dsh without a model
 * provider), as a sign-in failure (ACP's auth_required code) that says how to set it up; any other failure as it is.
 */
function setupFailure(q, e) {
  const native = typeof q?.setup?.matchesError === 'function' && q.setup.matchesError(e) === true;
  if (!native && (!(q?.setup?.error instanceof RegExp) || !q.setup.error.test(String(e?.said ?? e?.message ?? '')))) return e;
  return Object.assign(new Error(`${q.label}: ${q.setup.reason}`), { code: -32000, said: q.setup.reason, setup: q.setup.reason });
}

/**
 * Whether session/new gave the session a model to run turns on: a model config option with a value, or ACP's models
 * state with a current model. A harness whose quirks say it needs one (`setup.model`) can't answer a prompt without.
 */
function hasModel(session) {
  const set = (v) => typeof v === 'string' && v !== '';
  const options = Array.isArray(session?.configOptions) ? session.configOptions : [];
  return options.some((o) => o?.category === 'model' && set(o.currentValue)) || set(session?.models?.currentModelId);
}

/**
 * A chat's failure at `stage` that asks for a sign-in, or for the setup its quirks name: the harness reads Signed out
 * (admission.cjs) until a check finds it ready. Returns the failure as the chat shows it (a setup failure says how).
 * @param host the AcpHost (its quirks and signedOut)
 */
function signInNeeded(host, harness, e, stage, agent) {
  const failure = setupFailure(host.quirksOf(harness), e);
  if (isAuthError(failure) && host.admission?.acceptsBin?.(harness, agent?.command, agent?.binaryStamp) !== false)
    host.signedOutFn(harness, stage, signInReason(failure));
  return failure;
}

/**
 * A process for signing in: the chat process when one runs, else a short-lived one.
 * @param host the AcpHost (its agents, quirks, binaries and env)
 */
async function loginAgent(host, harness) {
  const live = host.agents.get(harness) ?? processesOf(host, harness)[0]?.entry;
  if (live && !host.admission) return live;
  const q = host.quirksOf(harness);
  const bin = await host.resolveBin(harness);
  if (!q || !bin) throw new Error(`${harness} isn't installed`);
  if (live) {
    const agent = await resolvedAgent(live);
    if (agent && !agent.exited && agent.command === bin && host.admission.acceptsBin?.(harness, bin, agent.binaryStamp) !== false)
      return agent;
  }
  const launch = q.launch
    ? await q.launch({ bin, env: host.envOf(harness), quirks: q, dataDir: host.dataDir })
    : { args: q.args ?? [], env: {} };
  const agent = new AcpAgent({
    harness,
    command: bin,
    args: launch.args ?? [],
    env: { ...host.envOf(harness), ...(q.env ?? {}), ...(launch.env ?? {}) },
    cwd: host.cwd,
    spawnFn: host.spawnFn,
    onRequest: async () => null,
  });
  agent.start();
  try {
    await agent.initialize();
  } catch (e) {
    // one that didn't start (a timeout, another protocol version) is not left running
    agent.kill();
    throw e;
  }
  return agent;
}

/**
 * Sign in with one of the agent's authMethods over ACP (methods without a terminal command). An aborted signal (Cancel)
 * stops waiting and rejects with rpc.cjs's Cancelled.
 */
async function authenticate(host, harness, methodId, signal) {
  const agent = await host.agentForLogin(harness);
  host.questions?.retireAgent(agent);
  agent.authenticating = true;
  try {
    // a browser or device-code sign-in takes as long as the user does, up to LOGIN_MS: the process lives until then
    await agent.request('authenticate', { methodId }, { timeoutMs: LOGIN_MS, signal });
    return true;
  } finally {
    agent.authenticating = false;
    // one started only to sign in goes when the sign-in is over
    if (!agent.entry) agent.kill();
  }
}

/**
 * The sign-ins under way, at most one per harness: a second one asked for while it waits (another click, another
 * window) joins it rather than opening a second login. Listeners hear { harness: methodId } whenever that changes.
 */
class SignIns {
  constructor() {
    /** @type {Map<string, { methodId: string, abort: AbortController, done: Promise<unknown> }>} */
    this.running = new Map();
    this.listeners = new Set();
  }
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** harness -> the auth method its sign-in waits on */
  list() {
    return Object.fromEntries([...this.running].map(([harness, r]) => [harness, r.methodId]));
  }
  /**
   * Runs `run(signal)` as the harness's sign-in, or joins the one already waiting.
   * @template T
   * @param {(signal: AbortSignal) => Promise<T>} run
   * @returns {Promise<T>}
   */
  run(harness, methodId, run) {
    const now = this.running.get(harness);
    if (now) return /** @type {Promise<T>} */ (now.done);
    const abort = new AbortController();
    // run is called on the next tick, so the entry is listed (and heard) before anything it does can settle
    const done = Promise.resolve()
      .then(() => run(abort.signal))
      .finally(() => {
        this.running.delete(harness);
        this.emit();
      });
    this.running.set(harness, { methodId, abort, done });
    this.emit();
    return done;
  }
  /** Stops waiting for the harness's sign-in; false when none was under way. */
  cancel(harness) {
    const r = this.running.get(harness);
    r?.abort.abort();
    return !!r;
  }
  emit() {
    const list = this.list();
    for (const fn of this.listeners) fn(list);
  }
}

module.exports = { LOGIN_MS, isAuthError, signInReason, setupFailure, hasModel, signInNeeded, loginAgent, authenticate, SignIns };
