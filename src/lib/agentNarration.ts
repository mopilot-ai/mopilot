// Control narration entry point: normalize calls, register adapters and project turn-level state.
import { identityKey } from '../../shared/identityKey.mjs';
import { toolInvocation } from '../../shared/toolInvocation.mjs';
import { toolOutput } from './toolOutput';
import { vendorAppProblem } from '../../shared/skyComputerUse.mjs';
import { isVendorInstructions } from '../../shared/vendorInstructions.mjs';
import {
  q,
  controlTool,
  recordApp,
  type ControlAdapter,
  type ControlCall,
  type ControlStep,
  type ControlSurface,
  type ToolArgs,
  type NarrationContext,
} from './agentNarration/common';
import { browserStep, desktopStep, appStep, appOf } from './agentNarration/tools';
import { builtinHandoff } from './agentNarration/handoffs';
import { controlVerb, inSteps, shortToolName, type ControlVerb } from './agentNarration/verbs';
import { appLabel } from './appNames';
import type { Handoff, SeenTab } from './agentNarration/common';
import { learnBindings } from './agentNarration/program';
import {
  claudeBrowserNarration,
  claudeChromeAdapter,
  computerUseAdapter,
  mopilotComputerAdapter,
  mopilotBrowserAdapter,
  mopilotChromeAdapter,
  cuaAdapter,
  browserScriptAdapter,
} from './agentNarration/adapters';

export { skyProblemText, type SkyProblem, type SkyProblemAction } from '../../shared/skyComputerUse.mjs';
export { controlTool, hostOf, macKeys } from './agentNarration/common';
export type {
  ControlSurface,
  ToolArgs,
  ControlStep,
  ControlCall,
  ControlAdapter,
  BrowserWhere,
  HandoffReason,
  Handoff,
  SeenTab,
  NarrationContext,
} from './agentNarration/common';
export { usesInAppBrowser } from './agentNarration/handoffs';

/** A namespace compared without case or separators: "claude-in-chrome", "Claude in Chrome" and "claude_in_chrome" are one. */
const nsKey = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const adapters = new Map<string, ControlAdapter>();

/** Plug a vendor's control tools into the thread's narration under each of its namespaces. */
export function registerControlAdapter(namespaces: string[], adapter: ControlAdapter) {
  for (const n of namespaces) adapters.set(nsKey(n), adapter);
}

/** A tool call item (mcpToolCall, dynamicToolCall) as the narration reads it. */
type ToolCallItem =
  | {
      id?: unknown;
      tool?: unknown;
      server?: unknown;
      arguments?: unknown;
      status?: unknown;
      error?: unknown;
      result?: { isError?: boolean };
      /** main marks a cua_repl step whose approval it declined because the plugin's release failed (codexEvents.cjs) */
      mopilotDeclined?: unknown;
    }
  | null
  | undefined;

/** Main's `mopilotDeclined` reasons on a cua_repl step (electron/harness/codexEvents.cjs), as the problem each reads as. */
const HOST_DECLINED = new Map<unknown, 'cleanupBlocked' | 'requestStopped'>([
  ['cleanupBlocked', 'cleanupBlocked'],
  ['stopped', 'requestStopped'],
]);

const OWN_CHROME = nsKey('mopilot_chrome');

/** Names shared by every projection: own chrome_* tools use the same adapter as Claude's short mopilot_chrome names. */
function callName(call: unknown): Pick<ControlCall, 'namespace' | 'tool'> | null {
  const item = toolInvocation(call) as ToolCallItem;
  if (typeof item?.tool !== 'string' || !item.tool) return null;
  const m = /^mcp__(.+?)__(.+)$/.exec(item.tool);
  const tool = m ? m[2] : item.tool;
  const chrome = /^chrome_([a-z_]+)$/.exec(tool.split(/[./:]/).pop() || '');
  return {
    namespace: chrome ? OWN_CHROME : nsKey(m ? m[1] : item.server),
    tool: chrome ? chrome[1] : tool,
  };
}

/** A call's normalized name, arguments, result and outcome. */
function callOf(call: unknown): ControlCall | null {
  const item = toolInvocation(call) as NonNullable<ToolCallItem>;
  const name = callName(item);
  if (!name) return null;
  return {
    ...name,
    args: (item.arguments && typeof item.arguments === 'object' ? item.arguments : {}) as ToolArgs,
    // what the program did, without the instructions a vendor sends along (the Codex Browser plugin's guide)
    result: toolOutput(item, isVendorInstructions).text,
    failed: item.status === 'failed' || !!item.error || item.result?.isError === true,
    hostDeclined: HOST_DECLINED.get(item.mopilotDeclined) ?? null,
  };
}

/** Whether a tool item is a Codex cua_repl program, where the Browser plugin (and Codex Computer Use) run. */
export function cuaProgram(item: unknown): boolean {
  const c = callOf(item);
  return !!c && c.namespace === nsKey('cua_repl') && c.tool === 'js';
}

registerControlAdapter(['claude-in-chrome'], claudeChromeAdapter);
registerControlAdapter(['Claude_Browser'], claudeBrowserNarration);
registerControlAdapter(['computer-use'], computerUseAdapter);
registerControlAdapter(['mopilot_computer'], mopilotComputerAdapter);
registerControlAdapter(['cua_repl'], cuaAdapter);
registerControlAdapter(['mopilot_browser'], mopilotBrowserAdapter);
registerControlAdapter(['mopilot_chrome'], mopilotChromeAdapter);

/** MoPilot's own desktop tool a call used, by its desktop_* style short name (desktop_key and Claude Code's mopilot_computer key alike), or null. */
export function ownDesktopTool(item: unknown): { name: string } | null {
  item = toolInvocation(item);
  const t = controlTool((item as ToolCallItem)?.tool);
  if (t) return t.surface === 'desktop' ? { name: t.name } : null;
  const call = callOf(item);
  return call && call.namespace === nsKey('mopilot_computer') ? { name: call.tool } : null;
}

/** MoPilot's own in-app browser tool a call used, by its browser_* style short name (browser_navigate and Claude Code's mopilot_browser navigate alike), or null. */
export function ownBrowserTool(item: unknown): { name: string } | null {
  item = toolInvocation(item);
  const call = callName(item);
  // Chrome's short browser_batch is still Chrome, never a target for an in-app permission action.
  if (call?.namespace === OWN_CHROME) return null;
  const t = controlTool((item as ToolCallItem)?.tool);
  if (t) return t.surface === 'browser' ? { name: t.name } : null;
  return call && call.namespace === nsKey('mopilot_browser') ? { name: call.tool } : null;
}

/** MoPilot's own Chrome tool a call used (chrome_* under any harness, Claude Code's mopilot_chrome short names), and whether it failed, or null. */
export function ownChromeTool(item: unknown): { name: string; failed: boolean } | null {
  const call = callOf(item);
  return call && call.namespace === OWN_CHROME ? { name: call.tool, failed: call.failed } : null;
}

/** Whether a control call is MoPilot's own tool (desktop_* / browser_* by name, or mopilot_computer for Claude Code), not a vendor's. */
export function isMoPilotControl(item: unknown): boolean {
  item = toolInvocation(item);
  if (controlTool((item as ToolCallItem)?.tool)) return true;
  const namespace = callName(item)?.namespace;
  return namespace === nsKey('mopilot_computer') || namespace === OWN_CHROME;
}

/** What one item changes in the plugin kernel's bindings: a cua program adds its own, js_reset drops them all. */
function learnFrom(item: unknown, ctx: NarrationContext) {
  const c = callOf(item);
  if (!c || adapters.get(c.namespace) !== cuaAdapter) return;
  if (c.tool === 'js_reset') ctx.clear();
  else if (typeof c.args.code === 'string') learnBindings(c.args.code, ctx);
}

/**
 * Variables the cua programs among `items` left bound (after `prior`, what earlier items bound), so a
 * later program's `app.click(…)` names its app. The plugin's kernel keeps them across turns until a reset.
 */
export function narrationContext(items: unknown[], prior: NarrationContext = new Map()): NarrationContext {
  const ctx: NarrationContext = new Map(prior);
  for (const item of items) learnFrom(item, ctx);
  return ctx;
}

/**
 * The bindings each item runs with: those of the items before it (after `prior`), never a later
 * program's, so an earlier `app.click()` is not named after an app bound later under the same name.
 */
export function narrationContexts(items: unknown[], prior: NarrationContext = new Map()): NarrationContext[] {
  const ctx: NarrationContext = new Map(prior);
  return items.map((item) => {
    const before = new Map(ctx);
    learnFrom(item, ctx);
    return before;
  });
}

/**
 * The bindings each turn starts with, by turn id: what earlier turns' programs left in the kernel. A turn
 * that was stopped may have had its kernel reset (MoPilot resets a running program on Stop), so the
 * turn after it starts with none rather than naming an app the kernel no longer holds.
 */
export function turnNarrationPriors(turns: { id: string; status: string; items: unknown[] }[]): Map<string, NarrationContext> {
  const out = new Map<string, NarrationContext>();
  let ctx: NarrationContext = NO_BINDINGS;
  for (const t of turns) {
    out.set(t.id, ctx);
    // a turn's bindings are kept by turn object and the bindings it started with, so the priors every
    // later turn gets keep their identity while an earlier turn streams nothing new into them
    let step = narrationSteps.get(t);
    if (step?.before !== ctx)
      narrationSteps.set(t, (step = { before: ctx, after: t.status === 'interrupted' ? new Map() : narrationContext(t.items, ctx) }));
    ctx = step.after;
  }
  return out;
}

const NO_BINDINGS: NarrationContext = new Map();
const narrationSteps = new WeakMap<object, { before: NarrationContext; after: NarrationContext }>();

/** The adapter for a call: browser_script by its name under any namespace, otherwise by its namespace. */
const adapterOf = (call: ControlCall) => (controlTool(call.tool)?.name === 'script' ? browserScriptAdapter : adapters.get(call.namespace));

/* ------------------------------------------------------------------ */

/**
 * The narration for a tool call item (mcpToolCall or dynamicToolCall), or null when it is not browser or
 * desktop control. MoPilot's own browser_* and desktop_* tools are recognised by name under any
 * namespace; vendor tools through the adapter registered for their namespace. `ctx` carries what earlier
 * native programs bound (narrationContext).
 */
export function controlStep(value: unknown, ctx: NarrationContext = new Map()): ControlStep | null {
  const step = narratedStep(value, ctx);
  if (!step) return null;
  const verb = toolVerb(value, step.surface);
  if (verb.steps === undefined) return step;
  // a batch row reads as Claude Desktop's: "Clicked, waited, captured page in 3 steps" (in Notes)
  const where = step.app ? ` in ${appLabel(step.app)}` : '';
  return { ...step, done: `${verb.done} ${inSteps(verb.steps)}${where}`, doing: `${verb.doing} ${inSteps(verb.steps)}${where}` };
}

/** A control call's short words from the verb tables, by the tool's own name whatever namespace it came under. */
function toolVerb(value: unknown, surface: ControlSurface): ControlVerb {
  const item = toolInvocation(value) as ToolCallItem;
  const own = callName(item)?.namespace === OWN_CHROME ? null : controlTool(item?.tool);
  const args = (item?.arguments && typeof item.arguments === 'object' ? item.arguments : {}) as ToolArgs;
  return controlVerb(shortToolName(own ? own.name : callName(item)?.tool), args, surface);
}

/**
 * A control step's words in its group's summary ("Clicked", "Captured page"; a batch's "Clicked, waited"). An action
 * the verb tables don't know keeps the step's own words, and merges only with the same words.
 */
export function controlStepVerb(value: unknown, step: ControlStep): ControlVerb {
  const verb = toolVerb(value, step.surface);
  return verb.unknown ? { key: `${verb.key}:${step.done}`, done: step.done, doing: step.doing, unknown: true } : verb;
}

/** controlStep's narration before its verb: the tool's own words from its table or its vendor's adapter. */
function narratedStep(value: unknown, ctx: NarrationContext): ControlStep | null {
  const item = toolInvocation(value) as ToolCallItem;
  const t = callName(item)?.namespace === OWN_CHROME ? null : controlTool(item?.tool);
  if (t && t.name !== 'script') {
    const args = (item!.arguments && typeof item!.arguments === 'object' ? item!.arguments : {}) as ToolArgs;
    const result = toolOutput(item).text;
    const [done, doing] =
      t.surface === 'browser'
        ? browserStep(t.name, args, result)
        : t.name.startsWith('app_')
          ? appStep(t.name.slice(4), args, result)
          : desktopStep(t.name, args, result);
    if (t.surface === 'browser') return { surface: t.surface, done, doing };
    const app = t.name.startsWith('app_')
      ? appOf(args, result)
      : (recordApp(result) ?? (typeof args.app === 'string' && args.app ? q(args.app, 40) : null));
    return { surface: t.surface, done, doing, ...(app ? { app } : {}) };
  }
  const call = callOf(item);
  const narrated = (call && adapterOf(call)?.narrate(call, ctx)) || null;
  if (!call || !narrated || narrated.problem || call.namespace === OWN_CHROME) return narrated;
  // a vendor tool that sends the user to its own desktop app (ChatGPT, the Claude app): MoPilot's words and actions instead
  const problem = vendorAppProblem(call.result);
  return problem ? { ...narrated, problem } : narrated;
}

/** The program a control call ran (a cua_repl or browser_script program, a page script), to show as code rather than JSON. */
export function controlSource(item: unknown): { code: string; lang: string } | null {
  const call = callOf(item);
  return (call && adapterOf(call)?.source?.(call)) || null;
}

/**
 * The hand-off a control call made, or null: MoPilot's own browser_* tools by name under any namespace
 * (a page the in-app browser shows), vendor tools through their namespace's adapter. `earlier` is the thread's
 * items before it, oldest first.
 */
export function controlHandoff(value: unknown, earlier: unknown[] = []): Handoff | null {
  const item = toolInvocation(value) as ToolCallItem;
  const t = callName(item)?.namespace === OWN_CHROME ? null : controlTool(item?.tool);
  if (t)
    return t.surface === 'browser'
      ? builtinHandoff(
          t.name,
          (item!.arguments && typeof item!.arguments === 'object' ? item!.arguments : {}) as ToolArgs,
          toolOutput(item).text,
        )
      : null;
  const call = callOf(item);
  const before = () => earlier.map(callOf).filter((c): c is ControlCall => c !== null && c.namespace === call?.namespace);
  return (call && adapters.get(call.namespace)?.handoff?.(call, before())) || null;
}

/**
 * The hand-off a turn ends on: the last control call among `items` handed the browser to the user.
 * Any control step after it (the agent went on) or none at all is no hand-off. `earlier` is the thread's items from
 * turns before, oldest first: a vendor REPL keeps tabs that an earlier turn's program opened.
 */
export function latestHandoff(items: unknown[], earlier: unknown[] = []): { id: string; handoff: Handoff } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (!controlStep(items[i])) continue;
    const handoff = controlHandoff(items[i], [...earlier, ...items.slice(0, i)]);
    return handoff ? { id: String((items[i] as NonNullable<ToolCallItem>).id ?? i), handoff } : null;
  }
  return null;
}

/** The user's browser tabs the calls among `items` reported, newest first, each tab once. */
export function browserTabsSeen(items: unknown[]): SeenTab[] {
  const out = new Map<string, SeenTab>();
  for (let i = items.length - 1; i >= 0; i--) {
    const call = callOf(items[i]);
    for (const tab of (call && adapters.get(call.namespace)?.tabs?.(call)) || []) {
      const key = identityKey(tab.where, tab.browserId, tab.tabId, tab.url);
      if (!out.has(key)) out.set(key, tab);
    }
  }
  return [...out.values()];
}

/** How a step of a turn ended, as recoveredFailures reads it: null for a step that is not browser or desktop control. */
export type ControlOutcome = { surface: ControlSurface; failed: boolean; finished: boolean } | null;

/**
 * Which failed control steps the turn got past: a failure followed later in the turn by a finished,
 * successful step on the same surface (the agent retried another way). Only the others count as failed.
 */
export function recoveredFailures(steps: ControlOutcome[]): boolean[] {
  const later = new Set<ControlSurface>();
  const out = steps.map(() => false);
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (!s) continue;
    if (s.failed) out[i] = later.has(s.surface);
    else if (s.finished) later.add(s.surface);
  }
  return out;
}

/** The last screenshot a control call returned (a data: URL), for its thumbnail. */
export function controlThumbnail(item: unknown): string | null {
  return toolOutput(item).images.at(-1) ?? null;
}

/** Every screenshot a control call returned (data: URLs), in order: a lone call shows them below its row. */
export function controlImages(item: unknown): string[] {
  return [...new Set(toolOutput(item).images)];
}
