// What a Codex turn's items say as ACP updates (`{ sessionUpdate, ... }`): the app draws a Host Codex chat as an ACP chat, so a command, a file change, an MCP tool call, a search, the model's reasoning, its plan and its token usage reach it in the shapes its ACP renderer already draws (core/crates/translate).

/** Most characters of one command's output streamed while it runs. */
const LIVE_MAX = 64_000;

/** A tool call's status as ACP names it; a command Codex declined to run ended, unsuccessfully. */
const STATUS = Object.freeze({ inProgress: 'in_progress', completed: 'completed', failed: 'failed', declined: 'failed' });
/** A plan step's status as ACP names it. */
const PLAN_STATUS = Object.freeze({ pending: 'pending', inProgress: 'in_progress', completed: 'completed' });

/** The lines of a text a patch holds, without the line break that ends the last one. @param {unknown} text */
const linesOf = (text) => {
  const t = String(text ?? '');
  return t === '' ? [] : t.replace(/\n$/, '').split('\n');
};

/**
 * A unified patch of a file-change item's changes, with its file headers: what the ACP translator reads from a tool call's
 * `rawOutput.metadata.diff` to draw an edit with real line numbers (shared/acpItems/editChanges.mjs). A new file's diff
 * is its content, a deleted file's its old content; an update's is the hunks Codex gives.
 * @param {{ path?: string, kind?: { type?: string }, diff?: string }[] | undefined} changes
 */
export function patchOf(changes) {
  return (changes ?? [])
    .map((c) => {
      const path = String(c.path ?? '');
      const lines = linesOf(c.diff);
      if (c.kind?.type === 'add')
        return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@${lines.map((l) => `\n+${l}`).join('')}`;
      if (c.kind?.type === 'delete')
        return `--- a/${path}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@${lines.map((l) => `\n-${l}`).join('')}`;
      const at = String(c.diff ?? '').indexOf('@@');
      return at < 0 ? null : `--- a/${path}\n+++ b/${path}\n${String(c.diff).slice(at)}`;
    })
    .filter(Boolean)
    .join('\n');
}

/** A card's title for the files a change touches. @param {{ path?: string }[]} changes */
const filesTitle = (changes) => (changes.length === 1 ? `Edit ${changes[0].path}` : `Edit ${changes.length} files`);

/** Text as the content list of a tool call. @param {string} text */
const textContent = (text) => [{ type: 'content', content: { type: 'text', text } }];

/**
 * The tool call an item starts: its card while it runs. Null for an item that is not a tool call (messages, reasoning).
 * @param {any} item
 */
function toolCall(item) {
  const toolCallId = String(item.id);
  switch (item.type) {
    case 'commandExecution':
      return { toolCallId, title: String(item.command ?? 'Command'), kind: 'execute', rawInput: { command: item.command, cwd: item.cwd } };
    case 'fileChange': {
      const changes = item.changes ?? [];
      return {
        toolCallId,
        title: filesTitle(changes),
        kind: 'edit',
        locations: changes.filter((c) => c.path).map((/** @type {{ path: string }} */ c) => ({ path: c.path })),
        rawInput: { paths: changes.map((/** @type {{ path?: string }} */ c) => c.path) },
        rawOutput: { metadata: { diff: patchOf(changes) } },
      };
    }
    case 'mcpToolCall':
      return { toolCallId, title: `mcp__${item.server}__${item.tool}`, kind: 'other', rawInput: item.arguments ?? {} };
    case 'webSearch':
      return { toolCallId, title: String(item.query ?? 'Web search'), kind: 'fetch', rawInput: { query: item.query } };
    default:
      return null;
  }
}

/**
 * What a finished item adds to its card: the output a command printed, an MCP tool's result, the patch a file change made.
 * @param {any} item
 */
function outcome(item) {
  switch (item.type) {
    case 'commandExecution': {
      const output = String(item.aggregatedOutput ?? '');
      return { ...(output ? { content: textContent(output) } : {}), rawOutput: { exitCode: item.exitCode ?? null, output } };
    }
    case 'fileChange':
      return { rawOutput: { metadata: { diff: patchOf(item.changes) } } };
    case 'mcpToolCall': {
      const blocks = (item.result?.content ?? []).map((/** @type {unknown} */ content) => ({ type: 'content', content }));
      const message = item.error?.message;
      return { content: message ? textContent(String(message)) : blocks, rawOutput: item.result ?? item.error ?? null };
    }
    default:
      return {};
  }
}

/** A tool call, started or finished, as the update that says so. @param {any} item @param {boolean} started */
function toolUpdate(item, started) {
  const call = toolCall(item);
  if (!call) return null;
  const status = STATUS[/** @type {keyof typeof STATUS} */ (item.status)] ?? 'in_progress';
  if (status === 'in_progress') return { sessionUpdate: 'tool_call', ...call, status };
  // an item heard only at its end has no card yet: it arrives whole
  if (!started) return { sessionUpdate: 'tool_call', ...call, ...outcome(item), status };
  return { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, ...outcome(item), status };
}

/**
 * The mapper of one Host's Codex chats. It remembers the tool calls it has started and the items whose text it has streamed, so an
 * item heard only when it ends still reaches the chat once, whole; it forgets a turn's when the turn ends.
 */
export function createItemMapper() {
  /** The tool calls started and not yet ended, by turn. @type {Map<string, Set<string>>} */
  const started = new Map();
  /** The items whose text streamed, by turn: a finished item that streamed adds nothing. @type {Map<string, Set<string>>} */
  const streamed = new Map();
  /** The last error the app-server reported for a turn, for a failed turn that carries none. @type {Map<string, string>} */
  const errors = new Map();
  /** How much of each command's output was streamed live, by item: the live view stops at LIVE_MAX and the finished item has the rest. @type {Map<string, number>} */
  const liveSent = new Map();
  /** @param {Map<string, Set<string>>} map @param {string} turnId */
  const setOf = (map, turnId) => {
    let set = map.get(turnId);
    if (!set) map.set(turnId, (set = new Set()));
    return set;
  };

  return {
    /**
     * The updates a notification makes, each with the turn it belongs to; none for one that says nothing a chat draws.
     * @param {string} method @param {any} p the notification's params
     * @param {(chatId?: string) => string | undefined} [lastTurn] the turn open now, for a report that names none (token usage)
     * @returns {{ turnId: string, update: Record<string, unknown> }[]}
     */
    map(method, p, lastTurn = () => undefined) {
      const turnId = p.turnId ?? lastTurn();
      if (!turnId) return [];
      /** @param {Record<string, unknown>} update */
      const one = (update) => [{ turnId, update }];
      switch (method) {
        case 'item/agentMessage/delta':
        case 'item/reasoning/summaryTextDelta': {
          if (typeof p.delta !== 'string' || p.delta === '') return [];
          setOf(streamed, turnId).add(String(p.itemId));
          const sessionUpdate = method === 'item/agentMessage/delta' ? 'agent_message_chunk' : 'agent_thought_chunk';
          return one({ sessionUpdate, messageId: p.itemId, content: { text: p.delta } });
        }
        case 'item/commandExecution/outputDelta': {
          // what a running command prints, as it prints it: shown live on its card (the stream's ephemeral lane), replaced by the whole output when the command ends
          if (typeof p.delta !== 'string' || p.delta === '' || typeof p.itemId !== 'string') return [];
          const sent = liveSent.get(p.itemId) ?? 0;
          if (sent >= LIVE_MAX) return [];
          const text = p.delta.slice(0, LIVE_MAX - sent);
          liveSent.set(p.itemId, sent + text.length);
          return one({ sessionUpdate: 'tool_output_delta', toolCallId: p.itemId, content: { type: 'text', text } });
        }
        case 'item/started':
        case 'item/completed': {
          const item = p.item ?? {};
          // the context was compacted: told once, when it is done (the handoff of a lost Host lists it)
          if (item.type === 'contextCompaction') {
            return method === 'item/completed' && typeof item.id === 'string'
              ? one({ sessionUpdate: 'compaction', id: item.id, trigger: typeof item.trigger === 'string' ? item.trigger : null })
              : [];
          }
          const text =
            item.type === 'agentMessage' || item.type === 'plan'
              ? item.text
              : item.type === 'reasoning'
                ? (item.summary ?? []).join('\n\n')
                : null;
          if (text !== null) {
            // a message or reasoning heard only at its end arrives whole; one that streamed already did
            if (method === 'item/started' || streamed.get(turnId)?.has(String(item.id)) || !text) return [];
            const sessionUpdate = item.type === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk';
            return one({ sessionUpdate, messageId: item.id, content: { text } });
          }
          const calls = setOf(started, turnId);
          const update = toolUpdate(item, calls.has(String(item.id)));
          if (!update) return [];
          if (update.status === 'in_progress') calls.add(String(item.id));
          else {
            calls.delete(String(item.id));
            liveSent.delete(String(item.id));
          }
          return one(update);
        }
        case 'turn/plan/updated':
          return one({
            sessionUpdate: 'plan',
            entries: (p.plan ?? []).map((/** @type {{ step?: string, status?: string }} */ s) => ({
              content: String(s.step ?? ''),
              status: PLAN_STATUS[/** @type {keyof typeof PLAN_STATUS} */ (s.status)] ?? 'pending',
              priority: 'medium',
            })),
          });
        case 'thread/tokenUsage/updated': {
          const usage = p.tokenUsage ?? {};
          // the context in use is what the last request carried; the window is the model's
          const used = usage.last?.totalTokens ?? usage.total?.totalTokens;
          return typeof used === 'number'
            ? one({
                sessionUpdate: 'usage_update',
                used,
                size: typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : null,
              })
            : [];
        }
        case 'error':
          // what a failed turn says when it carries no reason of its own; Codex says it will try again for some
          if (p.willRetry !== true && p.error?.message) errors.set(turnId, String(p.error.message));
          return [];
        default:
          return [];
      }
    },
    /** The last error reported for a turn, if any. @param {string} turnId */
    errorOf: (turnId) => errors.get(turnId),
    /** A turn ended: what was remembered of it goes. @param {string} turnId */
    forget(turnId) {
      for (const id of started.get(turnId) ?? []) liveSent.delete(id);
      started.delete(turnId);
      streamed.delete(turnId);
      errors.delete(turnId);
    },
    /** The app-server went away: nothing of its turns is still running. */
    reset() {
      started.clear();
      liveSent.clear();
      streamed.clear();
      errors.clear();
    },
  };
}
