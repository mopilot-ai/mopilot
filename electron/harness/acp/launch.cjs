// Starting and holding ACP harness processes for the host: one shared process per harness for coding chats, one per
// chat kept apart (MoMo's, acp/isolation.cjs), each started from its quirks' launch, env layers and privacy gate, then
// initialize. An isolated process adds the quirk's isolation env last, skips the user's MCP layer (its config is MoMo's
// own) and is told the client has no files or terminal.
const { AcpAgent } = require('./agent.cjs');
const { watchProviderErrors } = require('./providerErrors.cjs');
const { unconfined } = require('./isolation.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { nativeCompatibility } = require('./nativeCompatibility.cjs');
const { initialModels } = require('./initialModels.cjs');
const { signInWithLentKey } = require('./lentKeyAuth.cjs');

/**
 * @param {any} host the AcpHost
 * @param {string} harness
 * @param {{ isolated?: boolean, selectedBin?: string | null, isCurrent?: () => boolean }} [o]
 * @returns {Promise<InstanceType<typeof AcpAgent>>}
 */
async function startAgent(host, harness, { isolated = false, selectedBin, isCurrent } = {}) {
  const q = host.quirksOf(harness);
  if (!q) throw new Error(`Unknown harness: ${harness}`);
  // fail closed before anything starts: a harness that can't be confined never runs an isolated chat
  const why = isolated ? (unconfined(q) ?? q.isolation.blocked?.({ env: host.envOf(harness) })) : null;
  if (why) throw new Error(why);
  const bin = selectedBin === undefined ? await host.resolveBin(harness, true) : selectedBin;
  if (!bin) throw new Error(`${q.label} isn't installed`);
  const notAdmitted = await host.admittedFn(harness);
  if (notAdmitted) throw new Error(`${q.label}: ${notAdmitted}`);
  const shell = host.envOf(harness);
  const base = { ...shell, ...(q.env ?? {}), ...(isolated ? {} : host.mcpEnvOf(harness, shell)) };
  const ctx = { bin, env: base, quirks: q, dataDir: host.dataDir };
  const launch = q.launch ? await q.launch(ctx) : { args: q.args ?? [], env: {} };
  const env = { ...base, ...(launch.env ?? {}), ...(isolated ? await q.isolation.env(ctx) : {}) };
  // the privacy check runs before every start, and a failure keeps it from starting
  if (q.admission?.privacyGate) {
    const gate = await q.admission.privacyGate({ ...ctx, args: launch.args, env });
    if (!gate?.ok) throw new Error(gate?.reason ?? `${q.label} failed its privacy check`);
  }
  assertCurrent(isCurrent);
  const agent = new AcpAgent({
    harness,
    command: bin,
    args: launch.args ?? [],
    env,
    cwd: host.cwd,
    spawnFn: host.spawnFn,
    forms: true,
    isolated,
    onRequest: (method, params, context) => host.onAgentRequest(agent, method, params, context),
    onNotification: (method, params) => host.onAgentNotification(agent, method, params),
  });
  agent.start();
  agent.on('exit', (info) => host.onAgentExit(agent, info));
  watchProviderErrors(host, agent, q.providerError);
  try {
    await agent.initialize();
    const incompatible = nativeCompatibility(q, agent.caps, agent.init);
    if (incompatible) throw new Error(incompatible);
    // before the model list: an agent may read it only once signed in
    await signInWithLentKey(host, harness, agent, noteIgnored);
    await initialModels(agent, q, noteIgnored);
  } catch (e) {
    agent.kill();
    const tail = agent.exited?.stderr?.trim().split('\n').pop();
    throw new Error(`${q.label} didn't start: ${e?.message ?? e}${tail ? ` · ${tail}` : ''}`);
  }
  return agent;
}

function assertCurrent(isCurrent) {
  if (isCurrent?.() === false) throw new Error('ACP chat closed during this operation');
}

/** A failed prewarm has no process to transfer to a chat or to sign-in. */
function resolvedAgent(entry) {
  return entry.catch((error) => {
    noteIgnored('reuse a prewarmed ACP process', error);
    return null;
  });
}

/** Hand a chat an unassigned prewarm only if it still matches the copy selected for that chat. */
async function adoptWarm(host, harness, warm, isCurrent) {
  const agent = await resolvedAgent(warm);
  if (!agent) return startAgent(host, harness, { isCurrent });
  let bin;
  try {
    assertCurrent(isCurrent);
    bin = await host.resolveBin(harness, true);
    assertCurrent(isCurrent);
    if (!agent.exited && agent.command === bin && host.admission.acceptsBin(harness, bin, agent.binaryStamp)) return agent;
  } catch (error) {
    agent.kill();
    throw error;
  }
  agent.kill();
  return startAgent(host, harness, { selectedBin: bin, isCurrent });
}

/**
 * The host's process for a harness, started on first use; `own`: the key of the chat that holds it alone (a chat kept
 * apart, `isolated`, or any chat whose harness does not claim per-session MCP servers, #2311). A chat taking its own
 * process adopts the one a prewarm started and nobody holds yet.
 * @param {any} host @param {string} harness @param {string | null} own @param {boolean} [isolated]
 */
function agentFor(host, harness, own, isolated = !!own) {
  const agents = own ? (isolated ? host.isolatedAgents : host.codingAgents) : host.agents;
  const slot = own ?? harness;
  let p = agents.get(slot);
  if (p) return p;
  const warm = own && !isolated ? host.agents.get(harness) : null;
  if (warm) host.agents.delete(harness);
  if (warm) p = host.admission?.acceptsBin ? adoptWarm(host, harness, warm, () => agents.get(slot) === p) : warm;
  else p = startAgent(host, harness, { isolated: !!own && isolated });
  agents.set(slot, p);
  p.then(
    (/** @type {any} */ agent) => {
      agent.entry = p;
      agent.slot = slot;
      agent.map = agents;
    },
    () => agents.get(slot) === p && agents.delete(slot),
  );
  return p;
}

/**
 * The harness's coding processes: the shared one and the chats' own.
 * @param {any} host @param {string} harness
 * @returns {{ map: Map<string, any>, slot: string, entry: Promise<any> }[]}
 */
function processesOf(host, harness) {
  const out = [];
  const shared = host.agents.get(harness);
  if (shared) out.push({ map: host.agents, slot: harness, entry: shared });
  for (const [slot, entry] of host.codingAgents ?? [])
    if (slot.split(':')[1] === harness) out.push({ map: host.codingAgents, slot, entry });
  return out;
}

/**
 * A chat holding a process alone is over: the process stops (one that never started has nothing to stop).
 * @param {any} host @param {string} key
 */
function releaseOwn(host, key) {
  const map = host.isolatedAgents.has(key) ? host.isolatedAgents : host.codingAgents;
  const own = map.get(key);
  if (!own) return;
  map.delete(key);
  own.then(
    (/** @type {any} */ agent) => agent.kill(),
    (/** @type {unknown} */ error) => noteIgnored("stop a chat's process", error),
  );
}

module.exports = { startAgent, agentFor, releaseOwn, processesOf, resolvedAgent };
