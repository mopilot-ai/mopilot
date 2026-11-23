// Capability resolution, shared by main (electron/session/caps.cjs computes it per chat) and the
// window (src/harness/caps.ts re-exports it): what a chat can do =
// harness ∩ version ∩ provider ∩ account ∩ model ∩ flag ∩ session.
// The first layer that says no supplies the Why; present() turns a binding into one of five states.
// Types are in caps.d.mts.

import { ownTable } from './ownTable.mjs';
export const SEMANTICS = [
  'goal',
  'plan',
  'review',
  'multiAgent',
  'deepReasoning',
  'compact',
  'init',
  'skills',
  'memory',
  'tasks',
  'workflows',
  'shell',
  'rename',
  'fork',
  'rewind',
  'temporary',
  'archive',
  'search',
  'clear',
  'model',
  'effort',
  'speed',
  'permissions',
  'mcp',
  'status',
  'feedback',
  'logout',
  'voiceChat',
  'audioInput',
  'cloud',
  'textGen',
  'computerUse',
  'browser',
  'dictation',
  'nativeDictation',
  'plugins',
  'computerHistory',
  'design',
  'momoContext',
  'artifacts',
  'remoteControl',
];

/** Why Claude says Fast can't be used on this account (init.fast_mode_disabled_reason). */
export const FAST_BLOCKED_TEXT = ownTable({
  extra_usage_disabled: 'Fast mode is billed to extra usage, which is turned off for this account',
  free: 'Fast mode isn’t available on this plan',
  not_first_party: 'Fast mode needs an Anthropic login',
  disabled_by_env: 'Fast mode is disabled by your environment',
});

/** Polyfills Sage can run for a first-tier harness, by semantic. */
export const POLYFILLS = { init: 'init', shell: 'shell', archive: 'archive', search: 'search' };

export const versionGate = (n, probesFor = {}) => {
  const g = {};
  if (!n) return g;
  for (const [s, probes] of Object.entries(probesFor)) {
    const failed = probes.find((p) => n.probes[p] !== true);
    if (failed) g[s] = { layer: 'version', code: 'version.probeFailed', fix: 'upgrade' };
  }
  return g;
};

/** Gateway drops are listed by semantic name. MoPilot gets its own Fast copy. */
export const providerGate = (p) => {
  const g = {};
  if (!p) return g;
  for (const s of SEMANTICS) {
    if (!p.drops.includes(s)) continue;
    const code = s === 'speed' ? (p.id === 'mopilot' ? 'provider.noFast.mopilot' : 'provider.noFast') : 'provider.unsupported';
    g[s] = { layer: 'provider', code };
  }
  return g;
};

export const modelGate = (m) => {
  const g = {};
  if (!m) return g;
  const why = (code) => ({ layer: 'model', code, fix: 'switchModel' });
  if (!m.serviceTiers.length) g.speed = why('model.noFast');
  if (!m.ultra) g.multiAgent = why('model.noMultiAgent');
  if (!m.efforts.length) g.effort = g.deepReasoning = why('model.noEffort');
  return g;
};

export const accountGate = (a) => {
  const g = {};
  if (!a) return g;
  if (!a.fast) {
    const reason = a.fastBlocked && FAST_BLOCKED_TEXT[a.fastBlocked] ? a.fastBlocked : 'unavailable';
    g.speed = { layer: 'account', code: `account.noFast.${reason}` };
  }
  if (a.voiceChat === false) g.voiceChat = { layer: 'account', code: 'account.voiceChatRequiresChatGPT' };
  if (a.nativeDictation === false)
    g.nativeDictation = { layer: 'account', code: `account.dictationNeeds.${a.dictationAccount ?? 'login'}` };
  if (a.artifacts === false) g.artifacts = { layer: 'account', code: 'account.artifactsNeedClaudeAi' };
  if (a.remoteControlChatGPT === false) g.remoteControl = { layer: 'account', code: 'account.remoteControlNeedsChatGPT' };
  if (a.remoteControl === false) g.remoteControl = { layer: 'account', code: 'account.remoteControlNeedsClaudeAi' };
  return g;
};

/** A semantic switched off by a harness feature (features.goals) or a remote kill switch (sage.<semantic>). */
const FEATURE_OF = { goal: 'features.goals', memory: 'features.memories' };
/** What a killed harness (`sage.harness`) still leaves alone: nothing in it needs the harness running. */
const WITHOUT_HARNESS = new Set(['archive', 'search', 'rename', 'logout', 'status', 'dictation', 'nativeDictation']);
/** What a killed tool channel (`sage.channel`) takes away: the tools only reach the harness through it. */
const CHANNEL_TOOLS = ['computerUse', 'browser'];
export const flagGate = (flags) => {
  const g = {};
  if (!flags) return g;
  for (const s of SEMANTICS) {
    const feature = FEATURE_OF[s];
    if (flags['sage.harness'] === false && !WITHOUT_HARNESS.has(s)) g[s] = { layer: 'flag', code: 'flag.killed.harness' };
    else if (feature && flags[feature] === false) g[s] = { layer: 'flag', code: `flag.off.${s}`, fix: 'enableFeature' };
    else if (flags['sage.channel'] === false && CHANNEL_TOOLS.includes(s)) g[s] = { layer: 'flag', code: 'flag.killed.channel' };
    else if (flags[`sage.${s}`] === false) g[s] = { layer: 'flag', code: 'flag.killed' };
  }
  // the user's own Settings switch (Claude Code's Artifact tool), after any kill
  if (flags['user.artifacts'] === false && !g.artifacts)
    g.artifacts = { layer: 'flag', code: 'flag.artifactsUserOff', fix: 'enableFeature' };
  return g;
};

/** Still usable while another app runs a turn on this chat. */
const OUTSIDE_THE_CHAT = new Set(['status', 'mcp', 'plugins', 'search', 'archive', 'feedback', 'logout', 'cloud', 'dictation', 'clear']);
const NOT_WHILE_RUNNING = new Set(['rewind', 'voiceChat']);
export const sessionGate = (s, temporary = false) => {
  const g = {};
  if (temporary) g.goal = { layer: 'session', code: 'session.temporaryGoal', fix: 'newChat' };
  if (!s) return g;
  // the live process lists no Artifact tool: it started before the switch was turned on (a temporary chat is never
  // restarted, so a new chat is the fix that always holds), or
  // the user's own CLAUDE_CODE_ARTIFACT=0, settings.json or a CLI without it
  if (s.artifacts === false)
    g.artifacts = s.artifactsStale
      ? { layer: 'session', code: 'session.artifactsStarted', fix: 'newChat' }
      : { layer: 'session', code: 'session.artifactsOff' };
  if (s.runningElsewhere) {
    for (const k of SEMANTICS) if (!OUTSIDE_THE_CHAT.has(k)) g[k] = { layer: 'session', code: 'session.runningElsewhere', fix: 'wait' };
  } else if (s.turn === 'running' || s.turn === 'awaitingUser') {
    for (const k of NOT_WHILE_RUNNING) g[k] = { layer: 'session', code: 'session.turnRunning', fix: 'wait' };
  }
  return g;
};

/**
 * The harness layer comes from the adapter's bindings; a harness-layer none becomes a polyfill only on the
 * first tier and only when its preconditions hold. Every later layer can still turn the result into none.
 */
export function resolveCaps(i) {
  const gates = [
    versionGate(i.negotiated, i.probesFor),
    providerGate(i.provider),
    // an account that can't have Fast at all outranks a model without it: switching model wouldn't turn it on
    accountGate(i.account),
    modelGate(i.model),
    flagGate(i.flags),
    sessionGate(i.session, i.temporary),
  ];
  const out = {};
  for (const s of SEMANTICS) {
    let b = i.bindings[s] ?? { via: 'none', why: { layer: 'harness', code: 'harness.undeclared' } };
    if (b.via === 'none' && b.why.layer === 'harness' && i.tier === 'first') {
      const engine = POLYFILLS[s];
      if (engine && (i.polyfillReady?.(engine, s) ?? true)) b = { via: 'polyfill', engine };
    }
    if (b.via !== 'none') {
      const why = gates.map((g) => g[s]).find(Boolean);
      if (why) b = { via: 'none', why };
    }
    out[s] = b;
  }
  return out;
}

/** Only the binding and Why.layer decide; never where the entry sits beyond context vs global. */
export function present(b, entry) {
  switch (b.via) {
    case 'rpc':
    case 'passthrough':
    case 'config':
      return 'native';
    case 'polyfill':
      return 'sage';
    case 'route':
      return entry.scope === 'global' && entry.installed.includes(b.to) ? 'route' : 'absent';
    case 'none':
      if (b.why.layer !== 'harness') return 'disabled';
      if (entry.scope === 'context') return 'absent';
      return (entry.capableElsewhere ?? []).some((h) => entry.installed.includes(h)) ? 'route' : 'absent';
  }
}
