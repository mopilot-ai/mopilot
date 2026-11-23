// Runtime admission for basic-tier harnesses (design basicTierContract.admission). A harness goes in
// the picker only when all of these hold:
// - static: its quirks declare privacyDefaults and admission (quirks/index.cjs validate());
// - the privacy check its quirks declare passes, before the harness starts (dsh: --dump-config);
// - initialize succeeds (ACP v1);
// - session/new with this probe's sage_<nonce> server succeeds, and sage-mcp says hello in time;
// - for a harness whose quirks name a setup it needs (setup: dsh's key), the session has a model to run turns on
//   (setup.model) and the quirks find it set up (setup.ready).
// A harness that wants a sign-in, or a setup its quirks name (dsh without a DeepSeek key), reads Signed out and why.
// Otherwise Settings → Other harnesses says "Installed · Can't run in MoPilot" and why.
// Results are cached per binary (path, size, mtime), so a probe runs once per install or update. A sign-in can lapse
// or be made outside MoPilot without the binary changing: a chat that fails asking for a sign-in marks the harness
// signed out, and one that reads signed out is checked again when a window gets focus or before work runs unattended.
const { clock } = require('../platform/ports/clock.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeAtomic } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { withTimeout: timed } = require('../platform/timeout.cjs');
const { userError } = require('../../shared/userError.mjs');
const { ACP_CATALOG } = require('../../shared/harnessCatalog.mjs');
const { AcpAgent } = require('./acp.cjs');
const { binStamp } = require('./acp/agent.cjs');
const { isAuthError, signInReason, setupFailure, hasModel } = require('./acp/signin.cjs');
const { validate } = require('./quirks/index.cjs');
const { catalogOf } = require('./acp/settings.cjs');
const { toolsOverHttp } = require('./acpSessionTools.cjs');
const { fileVersion } = require('../platform/toolVersion.cjs');
const { nativeCompatibility } = require('./acp/nativeCompatibility.cjs');
const { initialModels } = require('./acp/initialModels.cjs');

const PROBE_TIMEOUT_MS = 30_000;
const NO_TOOLS = (label) => `MoPilot can't give ${label} computer and browser control`;
/**
 * A harness that reads signed out is checked again at most this often (a window's focus comes and goes often), and
 * half as often after each check that still finds it signed out (one installed but never signed in), up to 2^6 times.
 */
const RECHECK_MS = 15_000;
const MAX_BACKOFF = 6;

const withTimeout = (p, ms, what) => timed(p, ms, `${what} took longer than ${Math.round(ms / 1000)}s`, { unref: true });

/** Whether a harness's quirks find it set up (setup.ready); one whose check fails is not, and the failure is noted. */
async function setUp(q, ctx) {
  if (!q.setup?.ready) return true;
  try {
    return !!(await q.setup.ready(ctx));
  } catch (error) {
    noteIgnored(`check that ${q.label} is set up`, error);
    return false;
  }
}

/**
 * Probe one harness. Never rejects.
 * @returns {Promise<{id, state: 'admitted'|'unsupported'|'signin'|'missing', reason: string|null, bin, version, authMethods, caps, checkedAt, catalog?}>}
 */
async function probe(id, o, bin = o.resolveBin(id)) {
  const q = o.quirks(id);
  const base = { id, bin, version: null, authMethods: [], caps: null, checkedAt: clock.now() };
  if (!bin) return { ...base, state: 'missing', reason: null };
  const problems = q ? validate(q) : ['no quirks file'];
  if (problems.length) return { ...base, state: 'unsupported', reason: `MoPilot has no settings for it yet (${problems.join(', ')})` };
  const env = { ...o.env(), ...(q.env ?? {}) };
  const ctx = { bin, env, quirks: q, dataDir: o.dataDir };
  let launch;
  try {
    launch = q.launch ? await q.launch(ctx) : { args: q.args, env: {} }; // validate(): args is an array without launch
    if (q.admission.privacyGate) {
      const gate = await q.admission.privacyGate({ ...ctx, args: launch.args, env: { ...env, ...(launch.env ?? {}) } });
      if (!gate.ok) return { ...base, state: 'unsupported', reason: gate.reason };
    }
  } catch (e) {
    // the row says it in a sentence; the raw error goes to diagnostics
    noteIgnored(`prepare ${q.label} to start`, e);
    return { ...base, state: 'unsupported', reason: userError(e, { who: q.label }) };
  }
  const agentEnv = { ...env, ...(launch.env ?? {}) };
  const key = `acp:${id}:probe-${crypto.randomUUID()}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-acp-probe-'));
  const agent = new AcpAgent({
    harness: id,
    command: bin,
    args: launch.args,
    env: agentEnv,
    cwd,
    spawnFn: o.spawnFn,
    onRequest: async (method) => {
      // a probe answers nothing; permissions are cancelled
      if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
      throw Object.assign(new Error('not during a probe'), { code: -32601 });
    },
  });
  /** @returns {ReturnType<typeof probe>} */
  const attempt = async () => {
    agent.start();
    const init = await withTimeout(agent.initialize(), PROBE_TIMEOUT_MS, 'Starting');
    // initialize() resolved, so the caps are negotiated
    const caps = /** @type {NonNullable<typeof agent.caps>} */ (agent.caps);
    const out = { ...base, version: init.agentInfo?.version ?? null, authMethods: caps.authMethods, caps };
    const incompatible = nativeCompatibility(q, caps, init);
    if (incompatible) return { ...out, state: 'unsupported', reason: incompatible };
    await initialModels(agent, q, noteIgnored);
    const tools = await o.tools.prepare(key, { harnessPid: agent.pid, chatId: key, segmentId: key, http: toolsOverHttp(q, caps) });
    // one that refuses stdio MCP servers (Copilot CLI) gets its tools over http; one whose version takes no http
    // either can never reach tools offered only over stdio: say so before asking for a sign-in that could not make it work
    if (q.mcpStdio === false && tools.mcpServers.length && tools.mcpServers.every((s) => typeof s?.command === 'string'))
      return { ...out, state: 'unsupported', reason: `${NO_TOOLS(q.label)}: it takes only http and sse MCP servers` };
    let session;
    try {
      session = await withTimeout(
        agent.request('session/new', { cwd, mcpServers: tools.mcpServers }),
        PROBE_TIMEOUT_MS,
        'Opening a session',
      );
    } catch (e) {
      const failure = setupFailure(q, e);
      if (isAuthError(failure) || caps.authMethods.length)
        return { ...out, state: 'signin', reason: signInReason(failure) ?? `Sign in to ${q.label} first` };
      throw e;
    }
    // a session with no model, or no key to run it on, answers no prompt: it asks for no sign-in, so nothing else says so
    if ((q.setup?.model && !hasModel(session)) || !(await setUp(q, { ...ctx, env: agentEnv })))
      return { ...out, state: 'signin', reason: q.setup.reason };
    if (!(await o.tools.admission(key))) return { ...out, state: 'unsupported', reason: NO_TOOLS(q.label) };
    if (caps.close && session?.sessionId)
      // the probe session is discarded either way
      agent
        .request('session/close', { sessionId: session.sessionId })
        .catch((error) => noteIgnored('close the admission probe session', error));
    // what its sessions offer (modes, model, effort): a new chat shows it before its own session opens
    return { ...out, state: 'admitted', reason: null, catalog: catalogOf({ ...session, models: session?.models ?? agent.initialModels }) };
  };
  return attempt()
    .catch((e) => {
      const tail = agent.exited?.stderr?.trim().split('\n').pop();
      // the row says it in a sentence; the error and the last stderr line go to diagnostics
      noteIgnored(`start ${q.label}`, `${String(e?.message ?? e)}${tail ? ` · ${tail}` : ''}`);
      return { ...base, state: /** @type {const} */ ('unsupported'), reason: userError(e, { who: q.label }) };
    })
    .finally(() => {
      o.tools.end(key);
      agent.kill();
      clock.setTimeout(() => fs.rmSync(cwd, { recursive: true, force: true }), 3000).unref?.();
    });
}

/** A persisted stamp includes the path, even on older records without a separate bin field. */
const cachedFor = (saved, bin, stamp) => (saved?.stamp === stamp && (stamp !== null || saved.bin === bin) ? saved : null);
const needsProbe = (cached) => !cached || (cached.state === 'admitted' && !('catalog' in cached));

/**
 * Keeps each harness's admission, cached on disk by binary. 'changed' fires with the full list.
 */
class Admission {
  /**
   * @param {object} o
   * @param o.ids every harness id
   * @param o.quirks as AcpHost takes it
   * @param o.resolveBin as AcpHost takes it
   * @param [o.discoverBin] (id) => void | Promise<void>: refresh automatic CLI selection before checking admission
   * @param o.env as AcpHost takes it
   * @param o.tools as AcpHost takes it
   * @param o.file the cache (userData/acp-admission.json)
   * @param o.dataDir where quirks keep files (patches)
   * @param [o.killed] (id) => why the harness is switched off, or null
   * @param [o.pathStatus] (id, bin) => { offPath, terminal }: whether the user's terminal runs that same binary
   * @param [o.spawnFn] replaces child_process.spawn for the probe (tests)
   * @param [o.now] () => ms (tests)
   */
  constructor(o) {
    this.o = o;
    /** @type {InstanceType<typeof import('./registry/service.cjs').RegistryHarnesses> | null} */
    this.registry = null;
    this.now = o.now ?? (() => clock.now());
    this.file = o.file;
    this.listeners = new Set();
    this.running = new Map();
    /** @type {Map<string, { bin: string, stamp: string | null, fileVersion: string | null, offPath: object }>} by harness id */
    this.binInfo = new Map();
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {
      this.cache = {};
    }
  }
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  save() {
    try {
      writeAtomic(this.file, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      // cache only: the next run probes again
      noteIgnored('save the harness admission cache', error);
    }
  }
  /** Every harness: cached result when its binary hasn't changed, 'checking' while a probe runs. */
  list() {
    return this.o.ids.map((id) => {
      // isolates: its quirks confine it for MoMo's chats (#2278); MoMo's brain menus offer only those
      const iso = this.o.quirks(id)?.isolation;
      // momoBlocked: why MoMo can't run on it now (opencode with free models only, #2357)
      const h = {
        ...this.entry(id),
        ...(ACP_CATALOG[id]?.registry ? { descriptor: ACP_CATALOG[id], authBin: this.registry?.resolveAuth(id) } : {}),
        isolates: !!iso,
        momoBlocked: iso?.blocked?.({ env: this.o.env?.() ?? {} }) ?? null,
      };
      // a remote kill switch (flags.cjs) takes an admitted harness off: no new chats, nothing in the picker
      const why = h.state === 'admitted' ? this.o.killed?.(id) : null;
      return why ? { ...h, state: 'off', reason: why } : h;
    });
  }
  entry(id) {
    const q = this.o.quirks(id);
    const label = q?.label ?? id;
    const login = Array.isArray(q?.loginCommand) ? q.loginCommand : null;
    // which of its modes stand for the composer's permission rows, from its quirks
    const permissionModes = q?.permissionModes ?? {};
    const agentModes = q?.agentModes ?? [];
    const bin = this.o.resolveBin(id);
    if (!bin)
      return {
        id,
        label,
        state: 'missing',
        reason: null,
        bin: null,
        version: null,
        authMethods: [],
        login,
        catalog: null,
        images: null,
        permissionModes,
        agentModes,
      };
    const stamp = binStamp(bin);
    const c = cachedFor(this.cache[id], bin, stamp);
    const catalog =
      c?.catalog || c?.caps?.audio === true
        ? { ...(c.catalog ?? { modes: null, configOptions: null }), ...(typeof c.caps?.audio === 'boolean' ? { audio: c.caps.audio } : {}) }
        : null;
    // whether its prompts take images, as this binary's handshake declared (initialize's promptCapabilities); null: not known
    const images = c?.caps ? !!c.caps.image : null;
    // what the files say about the binary there now, looked at once per binary (list runs often)
    let seen = this.binInfo.get(id);
    if (!seen || seen.stamp !== stamp || seen.bin !== bin) {
      const where = this.o.pathStatus?.(id, bin);
      seen = { bin, stamp, fileVersion: fileVersion(bin), offPath: where?.offPath ? { offPath: true, terminal: where.terminal } : {} };
      this.binInfo.set(id, seen);
    }
    // the version of the binary there now: its probe's answer, else what its package says (nothing is run for it)
    const version = c?.version ?? seen.fileVersion;
    const offPath = seen.offPath;
    // an admission from before catalogs were kept is checked once more, so a new chat can show what it offers
    if (this.running.get(id)?.phase === 'probe' || needsProbe(c))
      return {
        id,
        label,
        state: 'checking',
        reason: null,
        bin,
        version,
        authMethods: c?.authMethods ?? [],
        login,
        catalog,
        images,
        permissionModes,
        agentModes,
        ...offPath,
      };
    return {
      id,
      label,
      state: c.state,
      reason: c.reason,
      bin,
      version,
      authMethods: c.authMethods ?? [],
      login,
      catalog,
      images,
      permissionModes,
      agentModes,
      ...offPath,
    };
  }
  /** Probe every installed harness whose result is missing or stale (or all, with force). */
  refresh(/** @type {{ force?: boolean, only?: string | null }} */ { force = false, only = null } = {}) {
    if (this.o.discoverBin)
      return Promise.all(this.o.ids.filter((id) => !only || id === only).map((id) => this.check(id, force))).then(() => this.list());
    const jobs = [];
    for (const h of this.list()) {
      if (h.state === 'missing' || (only && h.id !== only)) continue;
      if (!force && h.state !== 'checking') continue;
      jobs.push(this.check(h.id));
    }
    return Promise.all(jobs).then(() => this.list());
  }
  check(id, force = true, preservePromptAuth = false) {
    const pending = this.running.get(id);
    if (pending) {
      if (!force || (pending.force && (preservePromptAuth || !pending.preservePromptAuth))) return pending.done;
      // An unattended check or explicit re-check can join a discovery that hasn't proved the CLI's sign-in state.
      return pending.done.then((result) => (pending.phase === 'checked' ? result : this.check(id, force, preservePromptAuth)));
    }
    const discover = this.o.discoverBin?.(id);
    if (!discover && !force && this.entry(id).state !== 'checking') return Promise.resolve(null);
    const job = { force, preservePromptAuth, phase: 'discovery', done: /** @type {Promise<any> | null} */ (null) };
    const inspect = async (/** @type {Promise<void> | void} */ selection) => {
      job.phase = 'discovery';
      if (selection) await selection;
      const bin = this.o.resolveBin(id);
      const stamp = bin ? binStamp(bin) : null;
      const prior = cachedFor(this.cache[id], bin, stamp);
      if (!bin && this.o.discoverBin) return null;
      if (!needsProbe(prior) && (!force || (preservePromptAuth && prior.promptAuth))) return prior;
      job.phase = 'probe';
      const r = await probe(id, this.o, bin);
      // A pin or installation changed while the harness was answering. A caller waiting for admission needs the new copy.
      if (bin !== this.o.resolveBin(id) || (bin && binStamp(bin) !== stamp)) return inspect(this.o.discoverBin?.(id));
      // still signed out: checked again less often (stale())
      const misses = r.state === 'signin' && prior?.state === 'signin' ? (prior.misses ?? 0) + 1 : 0;
      // A check that opened no session can keep the catalog for this same copy.
      const catalog = r.catalog ?? prior?.catalog ?? null;
      this.cache[id] = { ...r, catalog, checkedAt: this.now(), misses, stamp };
      this.save();
      job.phase = 'checked';
      return r;
    };
    job.done = inspect(discover).finally(() => {
      this.running.delete(id);
      this.emit();
    });
    this.running.set(id, job);
    this.emit();
    return job.done;
  }
  /**
   * The harness's entry once it is checked: one whose binary changed since its check (the CLI updated itself, or was
   * installed while the app ran) is checked now, not at the next launch, rather than read as unsupported.
   */
  async current(id, /** @type {{ again?: boolean }} */ { again = false } = {}) {
    const h = this.list().find((x) => x.id === id);
    if (!h) return null;
    // with `again`, one that reads signed out is checked now too: the user may have signed in from their own terminal
    const retrySignIn = again && this.stale(h);
    if (!this.o.discoverBin && h.state !== 'checking' && !retrySignIn) return h;
    await this.check(id, retrySignIn);
    // listed a moment ago, so listed still
    return /** @type {NonNullable<typeof h>} */ (this.list().find((x) => x.id === id));
  }
  /**
   * The harness checked now, whatever the cache says: work that runs unattended can't recover from a lapsed sign-in.
   * One a chat's prompt found signed out stays so: a check can't see that (stale()).
   */
  async verify(id) {
    if (!this.o.ids.includes(id)) return null;
    // promptAuth is only ever set with 'signin' (signedOut), and a check or signedIn replaces it
    if (this.o.discoverBin || !this.cache[id]?.promptAuth) await this.check(id, true, true);
    // one of the ids, so listed
    return /** @type {NonNullable<ReturnType<Admission['list']>[number]>} */ (this.list().find((x) => x.id === id));
  }
  /**
   * Whether an entry reads signed out and its last check is old enough to check again. One that a chat's prompt (not
   * its session/new) found signed out is not: a check only opens a session, so it would read Ready again; Re-check,
   * a sign-in or a prompt that goes through clears it.
   */
  stale(h) {
    const c = this.cache[h?.id];
    if (h?.state !== 'signin' || !c || c.promptAuth) return false;
    return this.now() - (c.checkedAt ?? 0) >= RECHECK_MS * 2 ** Math.min(c.misses ?? 0, MAX_BACKOFF);
  }
  /** Check again every harness that reads signed out (a window got focus: the user may have signed in elsewhere). */
  recheckSignedOut() {
    return Promise.all(
      this.list()
        .filter((h) => this.stale(h))
        .map((h) => this.check(h.id)),
    ).then(() => this.list());
  }
  /** Whether a running agent's result belongs to the binary with the cached admission. */
  acceptsBin(id, bin, stamp) {
    return !bin || Boolean(cachedFor(this.cache[id], bin, stamp));
  }
  /**
   * A chat's session/new or session/prompt (`stage`) asked for a sign-in, or for the setup its quirks name (`reason`
   * says how): an admitted harness reads Signed out now, rather than Ready until its binary changes. A check under way
   * decides for itself.
   */
  signedOut(id, stage = 'session/new', reason = null) {
    const c = this.cache[id];
    if (c?.state !== 'admitted' || this.running.get(id)?.phase === 'probe') return;
    const label = this.o.quirks(id)?.label ?? id;
    const promptAuth = stage === 'session/prompt';
    this.cache[id] = { ...c, state: 'signin', reason: reason ?? `Sign in to ${label} first`, checkedAt: this.now(), misses: 0, promptAuth };
    this.save();
    this.emit();
  }
  /** A chat's prompt went through: a harness that reads signed out is signed in after all. */
  signedIn(id) {
    const c = this.cache[id];
    if (c?.state !== 'signin' || this.running.get(id)?.phase === 'probe') return;
    this.cache[id] = { ...c, state: 'admitted', reason: null, checkedAt: this.now(), misses: 0, promptAuth: false };
    this.save();
    this.emit();
  }
  /** What a harness's new session offered (modes, config options): new chats show it before their own session opens. */
  noteCatalog(id, catalog) {
    const c = this.cache[id];
    if (!c || !catalog || JSON.stringify(c.catalog ?? null) === JSON.stringify(catalog)) return;
    this.cache[id] = { ...c, catalog };
    this.save();
    this.emit();
  }
  /** Whether a new chat may start on it. */
  admitted(id) {
    return this.list().find((h) => h.id === id)?.state === 'admitted';
  }
  emit() {
    const list = this.list();
    for (const fn of this.listeners) fn(list);
  }
}

module.exports = { Admission, probe, binStamp, isAuthError, PROBE_TIMEOUT_MS, RECHECK_MS };
