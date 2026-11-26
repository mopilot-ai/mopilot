// What each harness says about every semantic (design commandLayer.table): one Binding per semantic,
// from what the harness negotiated. Anything not declared is none(harness), so an unknown capability
// is absent, never guessed. First tier is Codex (app-server) and Claude Code (Agent SDK); the rest
// run through ACP and only get what their command catalog and modes declare.
const { SEMANTICS } = require('../../shared/caps.mjs');
const { acpHasPermissionModes } = require('../../shared/acpMode.mjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { hostFamilyOfHarness } = require('../../shared/host/chatIds.mjs');
const { agentTraitsOf } = require('./family.cjs');

const rpc = (method) => ({ via: 'rpc', method });
const pass = (template) => ({ via: 'passthrough', template });
/**
 * @param {string} option
 * @param {unknown} [value]
 */
const config = (option, value = true) => ({ via: 'config', option, value });
const route = (to) => ({ via: 'route', to });
const none = (code = 'harness.undeclared') => ({ via: 'none', why: { layer: 'harness', code } });
/** Sage's own implementation, the same for every harness (computer use, browser, dictation). */
const sage = (engine) => ({ via: 'polyfill', engine });

/** @typedef {Record<import('../../shared/model/harness').Semantic, import('../../shared/model/harness').Binding>} Bindings */

/**
 * Fill every semantic: the ones given, the rest none(harness).
 * @returns {Bindings}
 */
function all(given) {
  const out = /** @type {Bindings} */ ({});
  for (const s of SEMANTICS) out[s] = given[s] ?? none();
  return out;
}

const SHARED = {
  computerUse: sage('computerUse'),
  browser: sage('browser'),
  dictation: sage('dictation'),
  // design systems kept as files in the project, read through MoPilot's design tools (electron/design)
  design: sage('design'),
};

function codexBindings(n) {
  return all({
    goal: rpc('thread/goal/set'),
    plan: config('collaborationMode', 'plan'),
    review: rpc('review/start'),
    // Ultra (several agents) is an effort tier, so only the models that list it get past the model layer
    multiAgent: config('effort', 'ultra'),
    deepReasoning: config('effort'),
    compact: rpc('thread/compact/start'),
    skills: rpc('skills/list'),
    memory: rpc('thread/memoryMode/set'),
    tasks: rpc('thread/backgroundTerminals/list'),
    shell: rpc('thread/shellCommand'),
    rename: rpc('thread/name/set'),
    fork: rpc('thread/fork'),
    rewind: rpc('thread/revert'),
    temporary: config('ephemeral'),
    archive: rpc('thread/archive'),
    search: rpc('thread/list'),
    clear: config('ui.newChat'),
    model: config('model'),
    effort: config('effort'),
    speed: config('serviceTier', 'priority'),
    permissions: config('approvalPolicy'),
    mcp: rpc('mcpServerStatus/list'),
    status: rpc('account/rateLimits/read'),
    feedback: rpc('feedback/upload'),
    logout: rpc('account/logout'),
    voiceChat: n?.ext?.realtimeVoice === false ? none() : rpc('thread/realtime/start'),
    // the ChatGPT login's own transcription (what the official app dictates with), electron/platform/voice.cjs
    nativeDictation: config('speechEngine', 'chatgpt'),
    cloud: pass('codex cloud'),
    textGen: rpc('thread/start'),
    // MoPilot's plugin store, installed into Codex and switched per thread (electron/plugins/codexMirror.cjs)
    plugins: config('plugins'),
    // shared memories go in the turn's own untrusted context, outside the user's message (electron/harness/codexParams.cjs)
    computerHistory: config('turnContext'),
    // a MoMo chat's memory goes in the same untrusted turn context, per turn (electron/momo/contract/context.cjs)
    momoContext: config('turnContext'),
    artifacts: none('harness.noArtifacts'),
    // Codex's remoteControl/* links the whole app-server to the user's devices, not one thread (harness/codexRemoteControl.cjs)
    remoteControl: rpc('remoteControl/enable'),
    // a message sent while a turn runs goes into it (electron/harness/codexTurns.cjs)
    steer: rpc('turn/steer'),
    ...SHARED,
  });
}

function claudeBindings() {
  return all({
    goal: pass('/goal {args}'),
    plan: config('permissionMode', 'plan'),
    review: pass('/code-review {args}'),
    multiAgent: config('ultracode'),
    deepReasoning: pass('ultrathink {args}'),
    compact: pass('/compact {args}'),
    init: pass('/init'),
    skills: pass('/{name} {args}'),
    memory: pass('/memory'),
    tasks: rpc('stopTask'),
    workflows: pass('/{name} {args}'),
    // no '!' in Claude Code: Sage runs it in its own terminal (polyfill shell)
    rename: rpc('renameSession'),
    fork: rpc('forkSession'),
    rewind: rpc('rewindFiles'),
    temporary: config('persistSession', false),
    clear: config('ui.newChat'),
    model: config('model'),
    effort: config('effortLevel'),
    speed: config('fastMode'),
    permissions: config('permissionMode'),
    mcp: rpc('mcpServerStatus'),
    status: rpc('getContextUsage'),
    feedback: none('harness.feedbackTerminalOnly'),
    voiceChat: none('harness.noVoiceConversation'),
    nativeDictation: none('harness.noNativeDictation'),
    cloud: route('codex'),
    textGen: rpc('query'),
    // MoPilot's plugin store, each plugin folder in the session's SDK options (electron/plugins/delivery.cjs)
    plugins: config('plugins'),
    // shared memories as a quoted context block ahead of the message (shared/computerHistory.mjs)
    computerHistory: sage('computerHistory'),
    // a MoMo chat's memory as a quoted block ahead of the turn's message (shared/momoContext.mjs)
    momoContext: sage('momoContext'),
    // Claude Code's Artifact tool, turned on for the session's CLI (electron/harness/claude/artifacts.cjs)
    artifacts: config('CLAUDE_CODE_ARTIFACT'),
    // the SDK query's enableRemoteControl, asked of the live session (electron/claudeRemoteControl.cjs)
    remoteControl: rpc('enableRemoteControl'),
    // a message sent while a turn runs goes into it with priority "now" (electron/harness/claude/adapter.cjs)
    steer: rpc('priority: now'),
    ...SHARED,
  });
}

const has = (list, ...names) => names.some((n) => list.some((c) => c === n || c === `/${n}`));

/**
 * A basic harness over ACP: what its modes, config options and command catalog declare.
 * @param {{ audio?: boolean, modes?: any, configOptions?: any[], commands?: any[] | null, plan?: { mode?: string, configOption?: string, value?: unknown } | null, agentModes?: string[] | null } | null | undefined} acp the session's SessionState.acp plus the quirks' plan marker and agent modes
 * @param {string} [kind] the chat's harness kind: Claude Code or Codex on a machine is `acp:host-claude` or `acp:host-codex`, whose goal the machine's agent runs (`chat.goal`)
 */
function acpBindings(acp, kind) {
  const cmds = (acp?.commands ?? []).map((c) => (typeof c === 'string' ? c : c.name));
  const opts = acp?.configOptions ?? [];
  const cat = (c) => opts.some((o) => o.category === c);
  return all({
    goal: hostFamilyOfHarness(parseKind(kind)?.basic ?? '') ? rpc('chat.goal') : has(cmds, 'goal') ? pass('/goal {args}') : none(),
    review: has(cmds, 'review') ? pass('/review {args}') : none(),
    compact: has(cmds, 'compact', 'compress') ? pass(`/${has(cmds, 'compact') ? 'compact' : 'compress'} {args}`) : none(),
    init: has(cmds, 'init') ? pass('/init') : none(),
    plan: acp?.plan ? (acp.plan.configOption ? config(acp.plan.configOption, acp.plan.value) : config('mode', acp.plan.mode)) : none(),
    // its modes, or a mode config option, other than the agent's own (#1875): the composer's permission menu
    permissions: acpHasPermissionModes(acp, acp?.agentModes) ? config('mode') : none(),
    model: cat('model') ? config('model') : none(),
    effort: cat('thought_level') ? config('thought_level') : none(),
    voiceChat: none('harness.noVoiceConversation'),
    nativeDictation: none('harness.noNativeDictation'),
    audioInput: acp?.audio === true ? rpc('session/prompt') : none('harness.noAudioInput'),
    // the plugins' MCP servers in session/new and their skills over plugin_skills: MoPilot's own
    plugins: sage('plugins'),
    // ACP has no context channel: shared memories go ahead of the prompt as a quoted block (degraded)
    computerHistory: sage('computerHistory'),
    // and so does a MoMo chat's memory (degraded: no channel kept apart from the message)
    momoContext: sage('momoContext'),
    // publishing to claude.ai is Claude Code's own tool; an ACP harness has none (a viewer link still opens anywhere)
    artifacts: none('harness.noArtifacts'),
    // the bridge is Claude Code's own: an ACP harness has no equivalent to turn on
    remoteControl: none('harness.noRemoteControl'),
    // ACP has no way into a running prompt (a chat on a machine steers by its Host's agent: machineBindings)
    steer: none('harness.noSteer'),
    ...SHARED,
  });
}

/**
 * A chat on another machine runs its Host's agent, so a message into its running turn is that agent's to take (`chat.send`
 * with followUp 'steer', electron/host/remotePicks.cjs `steersInto`); a chat of this Mac (`agent` undefined) keeps its own.
 * @param {Bindings} bindings @param {unknown} agent the one its Host last said (the chat's `hostAgent`), else the one its kind names
 * @returns {Bindings}
 */
function machineBindings(bindings, agent) {
  if (agent === undefined) return bindings;
  return all({ ...bindings, steer: agentTraitsOf(agent)?.steers ? rpc('chat.send followUp: steer') : none('harness.noSteer') });
}

/** Probes a semantic needs before it counts (Negotiated.probes). */
const PROBES_FOR = {
  claude: {
    multiAgent: ['claude.getSettings'],
    tasks: ['claude.perTaskStopAffordance'],
    deepReasoning: ['claude.origin'],
    // the session's CLI loaded the plugin folders (--plugin-dir); without it they come over plugin_skills only
    plugins: ['claude.pluginDirs'],
  },
  // the probes electron/harness/versions.cjs runs; one that didn't run blocks nothing
  codex: {
    goal: ['codex.goals'],
    plan: ['codex.collaborationModes'],
    tasks: ['codex.backgroundTerminals'],
    review: ['codex.review'],
    compact: ['codex.compact'],
    model: ['codex.threadProvider'],
    computerUse: ['codex.pluginsOff'],
    remoteControl: ['codex.remoteControl'],
  },
};

module.exports = { codexBindings, claudeBindings, acpBindings, machineBindings, PROBES_FOR };
