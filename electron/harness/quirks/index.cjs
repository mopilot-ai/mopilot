// Per-harness quirks for the basic tier. One generic ACP adapter (electron/harness/acp.cjs) runs every
// basic harness; what differs lives in quirks/<id>.cjs. A file has:
//
// required
//   label, bins            how it is called and found on the login shell's PATH
//   args | launch(ctx)     how it starts in ACP mode; launch returns {args, env} and may write files
//   privacyDefaults        uploads and telemetry it turns off at launch ([] when it has none to turn off)
//   admission              { handshakeTimeoutMs, privacyGate?(ctx) => {ok, reason} }; the gate runs
//                          before every start and must fail closed
// optional
//   env                    extra environment
//   anchors                mode id → readOnly | ask | auto | full (unlisted modes count as ask)
//   permissionModes        mode id → the composer's permission row it is (read-only | default | auto-review |
//                          full-access); an unlisted mode shows under its own name
//   agentModes             mode ids that are the agent's own (opencode's build), not how much it may do: the composer
//                          shows them in a mode menu apart from the permission menu (#1875)
//   plan                   which mode, or which config option value, is plan: { mode } | { configOption, value };
//                          its anchor must be readOnly
//   modalities             model id → ['text'] | ['text', 'image']; without it a model's input is unknown
//   resumeCommand(id)      the shell command that resumes a session in the harness's own CLI
//   titleSessions          false when its sessions show in MoPilot's own lists (Claude Code's or Codex's): a hidden
//                          session that writes a chat's title would show there too, so its chats keep their first words
//   versions               { min, knownBad, tested }
//   loginCommand           argv for signing in in a terminal, when its authMethods don't say
//   instructionsFiles      files it reads instructions from
//   mcpStdio               false when it refuses stdio MCP servers from the client (plugins' local servers are then withheld)
//   mcpScope               'session' when the harness gives a session's MCP servers to that session alone (opencode shares them
//                          across a folder). Every chat holds a process alone unless its quirks say so, and the claim needs a test
//                          on the fake agent (#2311)
//   mcp                    { servers(env) => [{name, enabled}], off(names) => env }: the MCP servers in the user's own
//                          settings, read only, and an env layer that turns some off for MoPilot's process only
//                          (electron/harness/acp/ownMcp.cjs); a harness without it can't, and Settings says so
//   setup                  { reason, model?, ready?, error? }: what it needs before a turn runs when it asks for no
//                          sign-in (a provider key), and how to set it (reason). It reads Signed out with that reason
//                          when its session has no model (model: true), ready(ctx) says it isn't set up, or a turn
//                          fails with words matching `error` (a RegExp)
//                          matchesError(error) optionally recognizes a vendor's verified typed configuration error
//   isolation              { env(ctx) => env, mode: { mode } | { configOption, value } }: how a process of its own runs
//                          MoMo's chats with its own tools, instructions and settings off (env, last over the rest) on
//                          the mode pinned for them (acp/isolation.cjs). A harness without it can't be confined and
//                          runs no MoMo chat (#2278). Its optional blocked(ctx) says why MoMo can't run on it now
//                          (opencode with free models only, #2357), or null
const { localOverride } = require('../../platform/flags.cjs');

const { ACP_PUBLIC_IDS: IDS, ACP_SPIKE_IDS: SPIKE_IDS, ACP_CATALOG, catalogQuirks } = require('../../../shared/harnessCatalog.mjs');
const ANCHORS = new Set(['readOnly', 'ask', 'auto', 'full']);
const PERMISSION_ROWS = new Set(['read-only', 'default', 'auto-review', 'full-access']);

function load(id, req = require) {
  const base = catalogQuirks(id);
  if (!base) return null;
  try {
    return { ...base, ...req(`./${id}.cjs`), label: base.label, bins: base.bins };
  } catch (e) {
    if (e?.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`${id}.cjs`)) return ACP_CATALOG[id].runtimeQuirks ? null : base;
    throw e;
  }
}

/**
 * Every harness to list: the basic ones, and each spike harness an unpackaged build's MOPILOT_FLAGS turns on. A caller
 * that doesn't say it runs unpackaged lists none of them.
 */
function ids({ packaged = true, env = process.env } = {}) {
  const on = localOverride(packaged, env.MOPILOT_FLAGS);
  return [...IDS, ...SPIKE_IDS.filter((id) => on[`harness.acp.${id}.enabled`] === true)];
}

/** The quirks for a harness id, with defaults filled in; null when it has no quirks file. */
function quirks(id, loadFn = load) {
  if (!Object.hasOwn(ACP_CATALOG, id)) return null;
  const q = loadFn(id);
  return q ? { id, env: {}, ...q } : null;
}

/** What a quirks file gets wrong; empty when it can be admitted. Missing privacyDefaults or admission keeps it out. */
function validate(q) {
  const out = [];
  if (!q || typeof q !== 'object') return ['missing'];
  if (typeof q.label !== 'string' || !q.label) out.push('label');
  if (!Array.isArray(q.bins) || !q.bins.length) out.push('bins');
  if (!Array.isArray(q.args) && typeof q.launch !== 'function') out.push('args or launch');
  if (!Array.isArray(q.privacyDefaults)) out.push('privacyDefaults');
  // the user's own MCP servers: listed and turned off both, or not offered at all (acp/ownMcp.cjs)
  if (q.mcp != null && (typeof q.mcp?.servers !== 'function' || typeof q.mcp?.off !== 'function')) out.push('mcp');
  if (!q.admission || typeof q.admission !== 'object' || !(q.admission.handshakeTimeoutMs > 0)) out.push('admission');
  else if (q.admission.privacyGate != null && typeof q.admission.privacyGate !== 'function') out.push('admission.privacyGate');
  if (q.anchors != null && (typeof q.anchors !== 'object' || Object.values(q.anchors).some((a) => !ANCHORS.has(a)))) out.push('anchors');
  if (
    q.permissionModes != null &&
    (typeof q.permissionModes !== 'object' || Object.values(q.permissionModes).some((r) => !PERMISSION_ROWS.has(r)))
  )
    out.push('permissionModes');
  // a mode is the agent's own or a permission row, never both
  if (
    q.agentModes != null &&
    (!Array.isArray(q.agentModes) || q.agentModes.some((m) => typeof m !== 'string' || Object.hasOwn(q.permissionModes ?? {}, m)))
  )
    out.push('agentModes');
  if (q.plan != null && !(typeof q.plan?.mode === 'string' || typeof q.plan?.configOption === 'string')) out.push('plan');
  // plan only reads on every harness: MoPilot's computer and browser tools read the anchor, so plan must be one
  else if (q.plan != null && q.anchors?.[q.plan.mode ?? q.plan.value] !== 'readOnly') out.push('plan anchor');
  if (q.modalities != null && (typeof q.modalities !== 'object' || Object.values(q.modalities).some((m) => !Array.isArray(m))))
    out.push('modalities');
  if (q.resumeCommand != null && typeof q.resumeCommand !== 'function') out.push('resumeCommand');
  if (q.titleSessions != null && typeof q.titleSessions !== 'boolean') out.push('titleSessions');
  if (q.versions != null && typeof q.versions !== 'object') out.push('versions');
  if (
    q.isolation != null &&
    (typeof q.isolation?.env !== 'function' ||
      !(
        typeof q.isolation.mode?.mode === 'string' ||
        (typeof q.isolation.mode?.configOption === 'string' && q.isolation.mode.value != null)
      ))
  )
    out.push('isolation');
  if (
    q.setup != null &&
    (typeof q.setup?.reason !== 'string' ||
      !q.setup.reason ||
      // a global or sticky RegExp keeps its place between tests, so the same failure would read differently next time
      (q.setup.error != null && (!(q.setup.error instanceof RegExp) || q.setup.error.global || q.setup.error.sticky)) ||
      (q.setup.matchesError != null && typeof q.setup.matchesError !== 'function') ||
      (q.setup.ready != null && typeof q.setup.ready !== 'function'))
  )
    out.push('setup');
  return out;
}

/** Whether a harness's quirks confine it for MoMo's chats (its `isolation`): one that can't runs none of them. */
const isolates = (id, loadFn = load) => !!quirks(id, loadFn)?.isolation;

/**
 * Why a harness that isolates can't run MoMo now (its isolation's blocked), or null.
 * @param {string} id @param {Record<string, string | undefined>} env the login shell's environment
 */
const momoBlocked = (id, env, loadFn = load) => quirks(id, loadFn)?.isolation?.blocked?.({ env }) ?? null;

/** The anchor a mode stands for in the computer-use authorization table; unlisted modes are 'ask'. */
const anchorOf = (q, modeId) => q?.anchors?.[modeId] ?? 'ask';

/**
 * Where a harness's binary is: SAGE_ACP_BINS (a JSON map of id to path, for tests) when set, else
 * the first of its bins on the login shell's PATH.
 */
function findBin(id, which, env = process.env) {
  if (env.SAGE_ACP_BINS) {
    try {
      const p = JSON.parse(env.SAGE_ACP_BINS)[id];
      return typeof p === 'string' && p ? p : null;
    } catch {
      return null;
    }
  }
  const bins = quirks(id)?.bins ?? [];
  for (const b of bins) {
    const p = which(b);
    if (p) return p;
  }
  return null;
}

/** What the window needs to know about a harness's quirks (no functions). */
function describe(id, loadFn = load) {
  const q = quirks(id, loadFn);
  if (!q) return null;
  return {
    id,
    label: q.label,
    privacyDefaults: q.privacyDefaults ?? [],
    anchors: q.anchors ?? {},
    plan: q.plan ?? null,
    // the agent's own modes; main's permissions capability counts the others (#1875)
    agentModes: q.agentModes ?? [],
    modalities: q.modalities ?? null,
    hasResumeCommand: typeof q.resumeCommand === 'function',
    instructionsFiles: q.instructionsFiles ?? [],
  };
}

module.exports = { quirks, ids, validate, anchorOf, findBin, describe, isolates, momoBlocked, load, ANCHORS, SPIKE_IDS };
