// What of a plugin reaches each harness family: per component native (the harness loads it), mopilot (MoPilot provides it, e.g. skills over sage-mcp on the basic tier) or unavailable with a why. One table read by
// delivery (electron/plugins/delivery) and every badge in the Plugins page, so they never disagree.
import { agentNameTaken } from './agentSkill.mjs';

/**
 * How each family takes each kind. Codex installs Claude-format plugins itself (commands become skills); app
 * connectors are ChatGPT's and run only on Codex; the basic tier gets skills and commands from MoPilot and
 * MCP servers in session/new, and nothing runs its hooks. Agents are subagents only on Claude Code: Codex gets each
 * as a generated skill in its marketplace copy, the basic tier from MoPilot (shared/plugins/agentSkill.mjs).
 */
const TABLE = {
  claude: {
    skills: 'native',
    commands: 'native',
    agents: 'native',
    hooks: 'native',
    mcpServers: 'native',
    lspServers: 'native',
    apps: 'plugin.appsCodexOnly',
  },
  codex: {
    skills: 'native',
    commands: 'native',
    agents: 'native',
    hooks: 'native',
    mcpServers: 'native',
    lspServers: 'plugin.lspClaudeOnly',
    apps: 'native',
  },
  acp: {
    skills: 'mopilot',
    commands: 'mopilot',
    agents: 'mopilot',
    hooks: 'plugin.hooksNotOnBasic',
    mcpServers: 'session',
    lspServers: 'plugin.lspClaudeOnly',
    apps: 'plugin.appsCodexOnly',
  },
};

/** The families that take an agent as a skill, and those whose skills share one namespace per plugin (Codex's). */
const AGENT_AS_SKILL = { codex: true, acp: true };
const SKILL_NAMES_SHARED = { codex: true };

/** Why texts, keyed like caps whys, for the tooltips and failure rows. */
export const REACH_WHY = {
  'plugin.appsCodexOnly': 'App connectors run only on Codex (they sign in through ChatGPT).',
  'plugin.lspClaudeOnly': 'MoPilot passes plugin LSP configuration only to Claude Code.',
  'plugin.agentNameTaken': "A skill or command of the plugin already has this agent's skill name.",
  'plugin.hooksNotOnBasic': "This harness doesn't run plugin hooks.",
  'plugin.mcpStdioUnsupported': "This harness doesn't start local MCP servers.",
  'plugin.mcpHttpUnsupported': "This harness doesn't connect to remote MCP servers.",
  'plugin.mcpTransportUnknown': "MoPilot doesn't know how to pass this MCP server on.",
  'plugin.sourceWithheld': 'This family has a source configuration that cannot yet be accounted for.',
  'plugin.familyUnknown': "MoPilot can't deliver plugins to this harness.",
};

/** What is true of a component that arrives, shown next to it (the Plugins page lines). */
export const REACH_NOTE = { 'plugin.agentAsSkill': 'Agents run as skills, not subagents.' };

/** The components a spec carries, as `{kind, name, transport?}` (transport for MCP servers). */
export function componentsOf(spec) {
  const out = [];
  for (const kind of ['skills', 'commands', 'agents']) for (const c of spec[kind] ?? []) out.push({ kind, name: c.name });
  const plans = spec.execution ? Object.values(spec.execution.plans) : [spec];
  const hooks = plans.flatMap((plan) => (plan.hookEvents ? plan.hookEvents.map((event) => ({ event })) : (plan.hooks ?? [])));
  const servers = Object.fromEntries(plans.flatMap((plan) => Object.entries(plan.mcpServers ?? {})));
  const hookEvents = spec.execution ? [...new Set(hooks.map((hook) => hook.event))] : hooks.map((hook) => hook.event);
  for (const event of hookEvents) out.push({ kind: 'hooks', name: event });
  for (const [name, s] of Object.entries(servers)) out.push({ kind: 'mcpServers', name, transport: s.type });
  for (const name of Object.keys(spec.lspServers ?? {})) out.push({ kind: 'lspServers', name });
  for (const name of spec.apps ?? []) out.push({ kind: 'apps', name });
  return out;
}

/**
 * One component on one family. `mcp` is what a basic-tier session accepts ({stdio, http}); an ACP agent
 * advertises http in its MCP capabilities and takes stdio unless its quirks say otherwise.
 * @returns {{reach: 'native' | 'mopilot' | 'unavailable', why?: string, note?: string}}
 */
export function componentReach(component, family, mcp = { stdio: true, http: false }) {
  const rule = TABLE[family]?.[component.kind];
  if (!rule) return { reach: 'unavailable', why: 'plugin.familyUnknown' };
  if (rule === 'native' || rule === 'mopilot') {
    // where an agent arrives as a skill it runs in the chat, not as a separate subagent
    return component.kind === 'agents' && AGENT_AS_SKILL[family] ? { reach: rule, note: 'plugin.agentAsSkill' } : { reach: rule };
  }
  if (rule === 'session') {
    if (component.transport === 'stdio')
      return mcp.stdio ? { reach: 'native' } : { reach: 'unavailable', why: 'plugin.mcpStdioUnsupported' };
    if (component.transport === 'other') return { reach: 'unavailable', why: 'plugin.mcpTransportUnknown' };
    return mcp.http ? { reach: 'native' } : { reach: 'unavailable', why: 'plugin.mcpHttpUnsupported' };
  }
  return { reach: 'unavailable', why: rule };
}

/**
 * Every component of a spec on one family, and the summary a badge shows: 'full' when everything arrives,
 * 'partial' when some does, 'none' when nothing does (a plugin with no components is 'full': nothing is lost).
 */
export function pluginReach(spec, family, mcp) {
  const plan = spec.execution?.plans[family];
  const selected = plan
    ? { ...spec, execution: undefined, mcpServers: plan.mcpServers, hooks: plan.hookEvents.map((event) => ({ event })) }
    : spec;
  const components = componentsOf(selected).map((c) => ({
    ...c,
    ...(c.kind === 'agents' && SKILL_NAMES_SHARED[family] && agentNameTaken(spec, c.name)
      ? { reach: 'unavailable', why: 'plugin.agentNameTaken' }
      : componentReach(c, family, mcp)),
  }));
  if (plan?.state === 'withheld')
    return {
      summary: 'none',
      components: components.map((c) => ({ ...c, reach: 'unavailable', why: 'plugin.sourceWithheld' })),
      reasons: plan.reasons,
    };
  for (const c of plan?.unavailable ?? []) components.push({ ...c, reach: 'unavailable' });
  const lost = components.filter((c) => c.reach === 'unavailable').length;
  const summary = lost === 0 ? 'full' : lost === components.length ? 'none' : 'partial';
  return { summary, components, ...(plan ? { reasons: plan.ignored } : {}) };
}
