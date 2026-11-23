// A Host chat's tool calls as the steps a handoff lists (the thread items shared/handoff.mjs reads): the ACP tool updates a Host's stream records (`tool_call`, `tool_call_update`), merged by call and mapped to a command, a file change, a web search, an MCP tool or a sub-agent. A call's arguments and result stay out of the handoff by that builder's rule; only a command's last output lines are kept.

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Characters of a command's output a mirror keeps: the handoff uses its last lines only. */
export const OUTPUT_KEEP = 4000;

/**
 * Whether an update tells a tool call.
 * @param {any} update
 */
export const isToolUpdate = (update) =>
  isObject(update) &&
  (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
  typeof update.toolCallId === 'string';

/** An update cut down to what a step needs, so a mirror holds a line per call and not a transcript. @param {any} update */
export function slimToolUpdate(update) {
  const out = String(update.rawOutput?.output ?? '');
  return {
    sessionUpdate: update.sessionUpdate,
    toolCallId: update.toolCallId,
    ...(update.title === undefined ? {} : { title: String(update.title).slice(0, 300) }),
    ...(update.kind === undefined ? {} : { kind: update.kind }),
    ...(update.status === undefined ? {} : { status: update.status }),
    ...(update.locations === undefined ? {} : { locations: update.locations.slice(0, 20) }),
    ...(isObject(update.rawInput) && typeof update.rawInput.command === 'string'
      ? { rawInput: { command: update.rawInput.command.slice(0, 500) } }
      : {}),
    ...(isObject(update.rawOutput)
      ? {
          rawOutput: {
            ...(update.rawOutput.exitCode === undefined ? {} : { exitCode: update.rawOutput.exitCode }),
            output: out.slice(-OUTPUT_KEEP),
          },
        }
      : {}),
    ...(isObject(update._meta?.claudeCode) ? { _meta: { claudeCode: { toolName: update._meta.claudeCode.toolName } } } : {}),
  };
}

/** The merge of a call's updates: later fields replace earlier ones. @param {any} into @param {any} update */
export const mergeToolUpdate = (into, update) => ({ ...into, ...slimToolUpdate(update) });

/**
 * The handoff step a merged call is, or null for one the handoff does not list (a plan, a thought).
 * @param {any} call
 */
export function stepOf(call) {
  const status = call.status === 'failed' ? 'failed' : call.status === 'completed' ? 'completed' : 'inProgress';
  const title = String(call.title ?? '');
  const path = call.locations?.[0]?.path;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(String(call._meta?.claudeCode?.toolName ?? title));
  if (mcp) return { type: 'mcpToolCall', server: mcp[1], tool: mcp[2], status };
  switch (call.kind) {
    case 'execute':
      return {
        type: 'commandExecution',
        command: String(call.rawInput?.command ?? title),
        exitCode: call.rawOutput?.exitCode ?? null,
        aggregatedOutput: call.rawOutput?.output ?? '',
        status,
      };
    case 'read':
      return { type: 'commandExecution', command: title, commandActions: [{ type: 'read', path: path ?? title }], status };
    case 'search':
      return { type: 'commandExecution', command: title, commandActions: [{ type: 'search', query: title }], status };
    case 'edit':
      return { type: 'fileChange', changes: [{ path: path ?? title, kind: { type: 'update' } }], status };
    case 'fetch':
      return { type: 'webSearch', query: title };
    case 'think':
      return { type: 'collabAgentToolCall', prompt: title, tool: 'agent' };
    default:
      return null;
  }
}

/** Whether an update tells that the context was compacted (Codex's compaction item, Claude's compact boundary). @param {any} update */
export const isCompaction = (update) => isObject(update) && update.sessionUpdate === 'compaction';

/** The handoff step a compaction is: the record says the context was compacted, the summary itself is the harness's own. */
export const compactionStep = () => ({ type: 'contextCompaction' });
