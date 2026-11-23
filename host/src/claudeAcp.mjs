// A Claude Code turn's SDK messages as ACP session updates, the dialect the app already renders for claude-agent-acp (core/crates/translate): text and thought chunks, tool calls and their results, the todo list as a plan, and the context the turn used. Pure: a message in, the updates it makes out, so the Host's stream carries what a local Claude chat shows (tool cards, command output, file edits, plan, thinking, sub-agent calls linked to their parent through `_meta.claudeCode.parentToolUseId`).

/** The ACP kind of each tool (what draws its card). Anything else, MCP tools included, is `other`. */
const KINDS = {
  Read: 'read',
  NotebookRead: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Task: 'think',
  Agent: 'think',
  ExitPlanMode: 'switch_mode',
};
/** Longest text a tool result keeps in the stream; the rest is said to be cut. */
const TEXT_MAX = 64_000;
/** Longest string a tool call's input keeps (a file written whole can be megabytes); the rest is said to be cut. */
const INPUT_MAX = 256_000;
/** Largest image (base64 characters) a tool result carries; a bigger one is left out. */
const IMAGE_MAX = 1_500_000;
const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed']);

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v.trim() ? v : null);
const clip = (/** @type {string} */ text) =>
  text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n[${text.length - TEXT_MAX} more characters not shown]` : text;

/** A tool's input with its long strings cut, so one call cannot make a frame of megabytes. @param {Record<string, unknown>} input */
const boundedInput = (input) =>
  Object.fromEntries(
    Object.entries(input).map(([k, v]) => [
      k,
      typeof v === 'string' && v.length > INPUT_MAX ? `${v.slice(0, INPUT_MAX)}\n[${v.length - INPUT_MAX} more characters not shown]` : v,
    ]),
  );

/** The file a tool names in its input, if any. @param {any} input */
const pathOf = (input) => str(input?.file_path) ?? str(input?.notebook_path) ?? str(input?.path);

/** The line a tool call's title is: what it does, as the person would say it. @param {string} name @param {any} input */
function titleOf(name, input) {
  const path = pathOf(input);
  switch (name) {
    case 'Bash':
      return str(input?.command) ?? 'Run a command';
    case 'Read':
    case 'NotebookRead':
      return path ? `Read ${path}` : 'Read a file';
    case 'Write':
      return path ? `Write ${path}` : 'Write a file';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return path ? `Edit ${path}` : 'Edit a file';
    case 'Grep':
      return `grep ${str(input?.pattern) ?? ''}`.trim();
    case 'Glob':
      return `Find ${str(input?.pattern) ?? 'files'}`;
    case 'LS':
      return `List ${path ?? 'a folder'}`;
    case 'WebFetch':
      return `Fetch ${str(input?.url) ?? 'a page'}`;
    case 'WebSearch':
      return str(input?.query) ?? 'Search the web';
    case 'Task':
    case 'Agent':
      return str(input?.description) ?? 'Sub-agent';
    default:
      // an MCP tool keeps its full name (`mcp__server__tool`): the app reads the server out of it
      return name;
  }
}

/** The ACP content of a tool call as it starts: a MultiEdit's edits as diff blocks. @param {string} name @param {any} input */
function startContent(name, input) {
  const path = pathOf(input);
  if (name !== 'MultiEdit' || !path || !Array.isArray(input.edits)) return undefined;
  return input.edits
    .filter((e) => isObject(e) && typeof e.old_string === 'string')
    .map((e) => ({ type: 'diff', path, oldText: e.old_string, newText: String(e.new_string ?? '') }));
}

/**
 * A tool result's content as ACP content blocks: its text (cut at TEXT_MAX) and its images.
 * @param {unknown} content a string, or the blocks of a tool_result
 */
function resultContent(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  /** @type {object[]} */
  const out = [];
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text)
      out.push({ type: 'content', content: { type: 'text', text: clip(b.text) } });
    else if (b?.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string')
      out.push(
        b.source.data.length > IMAGE_MAX
          ? { type: 'content', content: { type: 'text', text: '[an image too large to show]' } }
          : { type: 'content', content: { type: 'image', data: b.source.data, mimeType: String(b.source.media_type ?? 'image/png') } },
      );
  }
  return out;
}

/** The text of ACP content blocks, for a tool's raw output. @param {any[]} content */
const textOf = (content) =>
  content
    .map((c) => (c.content?.type === 'text' ? c.content.text : ''))
    .filter(Boolean)
    .join('\n');

/** All the tokens a model's usage record counts. @param {any} u */
const tokensOf = (u) => (isObject(u) ? Number(u.inputTokens ?? 0) + Number(u.outputTokens ?? 0) : 0);

/** The token counts of an SDK usage record, in ACP's names. @param {any} usage */
/** The ACP kind of a Claude Code tool by its name (`other` for any not in the table): what a permission card's summary names. @param {string} name */
export const toolKindOf = (name) => /** @type {Record<string, string>} */ (KINDS)[name] ?? 'other';

export function acpUsage(usage) {
  if (!isObject(usage)) return undefined;
  const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const inputTokens = n(usage.input_tokens);
  const outputTokens = n(usage.output_tokens);
  const cachedReadTokens = n(usage.cache_read_input_tokens);
  const cachedWriteTokens = n(usage.cache_creation_input_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens,
    cachedReadTokens,
    cachedWriteTokens,
  };
}

/**
 * One turn's translator: feed it the turn's SDK messages in order.
 * `message(m)` returns the session updates the message makes; `usage()` the turn's usage and context figures once its result has been seen.
 */
export function createClaudeAcp() {
  /** The assistant message whose deltas are arriving, and the ones whose text and thoughts already went out. */
  let current = /** @type {string | null} */ (null);
  const streamedText = new Set();
  const streamedThought = new Set();
  /** Tool calls started (a result is only told for one of these). */
  const calls = new Set();
  /** The context the last top-level assistant message used, and what the turn's result said. */
  let context = /** @type {number | null} */ (null);
  let result = /** @type {any} */ (null);
  /** The last assistant message's own word for why it failed (`rate_limit`, `authentication_failed`, ...), if it gave one. */
  let signal = /** @type {string | null} */ (null);

  /** The message each sub-agent's deltas are arriving in, by the call that started it (the top level has its own, `current`). @type {Map<string, string>} */
  const currentOf = new Map();

  /** A sub-agent's own words carry the call they belong to, the way claude-agent-acp tells them: the app draws them inside that call, not as the chat's reply. @param {string | null} parent */
  const meta = (parent) => (parent ? { _meta: { claudeCode: { parentToolUseId: parent } } } : {});

  /** @param {string} sessionUpdate @param {string} text @param {string | null} messageId @param {string | null} [parent] */
  const chunk = (sessionUpdate, text, messageId, parent = null) =>
    text ? [{ sessionUpdate, ...(messageId ? { messageId } : {}), content: { type: 'text', text }, ...meta(parent) }] : [];

  /** The updates of one assistant message's blocks that were not streamed, and its tool calls. @param {any} m */
  function assistant(m) {
    const id = typeof m.message?.id === 'string' ? m.message.id : null;
    const parent = str(m.parent_tool_use_id);
    if (!parent) {
      const used = acpUsage(m.message?.usage);
      if (used) context = used.totalTokens;
    }
    /** @type {object[]} */
    const out = [];
    for (const block of Array.isArray(m.message?.content) ? m.message.content : []) {
      if (block?.type === 'text' && !(id && streamedText.has(id)))
        out.push(...chunk('agent_message_chunk', String(block.text ?? ''), id, parent));
      else if (block?.type === 'thinking' && !(id && streamedThought.has(id)))
        out.push(...chunk('agent_thought_chunk', String(block.thinking ?? ''), id, parent));
      else if (block?.type === 'tool_use' && typeof block.id === 'string') out.push(...toolUse(block, parent));
    }
    return out;
  }

  /** A tool_use block: the todo list is the plan, anything else a tool call. @param {any} block @param {string | null} parent */
  function toolUse(block, parent) {
    const input = isObject(block.input) ? block.input : {};
    if (block.name === 'TodoWrite' && !parent && Array.isArray(input.todos)) {
      const entries = input.todos
        .filter((t) => isObject(t) && typeof t.content === 'string')
        .map((t) => ({ content: t.content, priority: 'medium', status: PLAN_STATUS.has(t.status) ? t.status : 'pending' }));
      return [{ sessionUpdate: 'plan', entries }];
    }
    calls.add(block.id);
    const path = pathOf(input);
    const content = startContent(block.name, input);
    return [
      {
        sessionUpdate: 'tool_call',
        toolCallId: block.id,
        title: titleOf(String(block.name), input),
        kind: KINDS[/** @type {keyof typeof KINDS} */ (block.name)] ?? 'other',
        status: 'in_progress',
        rawInput: boundedInput(input),
        ...(path ? { locations: [{ path }] } : {}),
        ...(content ? { content } : {}),
        _meta: { claudeCode: { toolName: String(block.name), ...(parent ? { parentToolUseId: parent } : {}) } },
      },
    ];
  }

  /** The tool results of a user message, each as the update of the call it answers. @param {any} m */
  function results(m) {
    const parent = str(m.parent_tool_use_id);
    /** @type {object[]} */
    const out = [];
    for (const block of Array.isArray(m.message?.content) ? m.message.content : []) {
      if (block?.type !== 'tool_result' || !calls.has(block.tool_use_id)) continue;
      const content = resultContent(block.content);
      out.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: block.tool_use_id,
        status: block.is_error ? 'failed' : 'completed',
        ...(content.length ? { content } : {}),
        rawOutput: { output: textOf(content) },
        ...(parent ? { _meta: { claudeCode: { parentToolUseId: parent } } } : {}),
      });
      calls.delete(block.tool_use_id);
    }
    return out;
  }

  return {
    /** @param {any} m an SDK message @returns {object[]} the session updates it makes */
    message(m) {
      if (!isObject(m)) return [];
      if (m.type === 'stream_event') {
        const e = m.event;
        // a sub-agent's words are told with the call they belong to (its own message ids, so they never join the chat's reply)
        const parent = str(m.parent_tool_use_id);
        const now = () => (parent ? currentOf.get(parent) : current) ?? null;
        if (e?.type === 'message_start' && typeof e.message?.id === 'string') {
          if (parent) currentOf.set(parent, e.message.id);
          else current = e.message.id;
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          if (now()) streamedText.add(now());
          return chunk('agent_message_chunk', String(e.delta.text ?? ''), now(), parent);
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
          if (now()) streamedThought.add(now());
          return chunk('agent_thought_chunk', String(e.delta.thinking ?? ''), now(), parent);
        }
        return [];
      }
      // the CLI compacted the conversation: told once, at the boundary
      if (m.type === 'system' && m.subtype === 'compact_boundary')
        return [{ sessionUpdate: 'compaction', id: str(m.session_id), trigger: str(m.compact_metadata?.trigger) }];
      if (m.type === 'assistant') {
        signal = typeof m.error === 'string' ? m.error : null;
        return assistant(m);
      }
      if (m.type === 'user') return results(m);
      if (m.type === 'result') result = m;
      return [];
    },

    /**
     * How the turn ended, from its result message: the failure it reports (a message), the tokens it used and the context window.
     * @returns {{ failure: string | null, signal: string | null, usage: (ReturnType<typeof acpUsage> & { model?: string }) | undefined, context: { used: number, size: number } | null }}
     */
    summary() {
      const failed = result?.is_error === true || (typeof result?.subtype === 'string' && result.subtype !== 'success');
      const errors = Array.isArray(result?.errors) ? result.errors.filter((e) => typeof e === 'string').join('\n') : '';
      const failure = failed ? errors || str(result?.result) || String(result?.subtype ?? 'The turn failed.') : null;
      const windows = Object.values(isObject(result?.modelUsage) ? result.modelUsage : {})
        .map((u) => u?.contextWindow)
        .filter((w) => typeof w === 'number' && w > 0);
      const used = acpUsage(result?.usage);
      // the model that did most of the turn's work, so its tokens can be priced
      const models = Object.entries(isObject(result?.modelUsage) ? result.modelUsage : {});
      const busiest = models.sort(([, a], [, b]) => tokensOf(b) - tokensOf(a))[0]?.[0];
      return {
        failure,
        signal: failure ? signal : null,
        usage: used && busiest ? { ...used, model: busiest } : used,
        context: context !== null && windows.length ? { used: context, size: Math.max(...windows) } : null,
      };
    },
  };
}
