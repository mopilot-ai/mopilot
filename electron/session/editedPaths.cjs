// The files each chat edited, as its harness reports them: Codex fileChange items, Claude Code's Edit, MultiEdit, Write
// and NotebookEdit tool calls, and ACP edit tool calls, each counted once it completed. Read from the controller's live
// events (ChatController.onLiveEvent), only for the chats `wanted` names, and taken when a turn ends.
const { contentBlocks } = require('../../shared/contentBlocks.mjs');

/** Paths kept per chat between takes. */
const MAX_PATHS = 500;
/** Edit calls per chat waiting for their result. */
const MAX_PENDING = 200;
/** Claude Code's tools that write a file named in their input. */
const CLAUDE_EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** ACP tool kinds that change files: an edit, a delete, a move (its locations name both ends). */
const ACP_WRITES = new Set(['edit', 'delete', 'move']);

/** @param {unknown} v @returns {v is string} */
const isPath = (v) => typeof v === 'string' && v.length > 0;

/** The files an ACP tool call names: its locations, its input's path and its diff blocks. */
function acpPaths(u, diffs) {
  const input = u.rawInput ?? {};
  return [
    ...(Array.isArray(u.locations) ? u.locations.map((l) => l?.path) : []),
    input.filePath,
    input.file_path,
    input.path,
    ...diffs.map((d) => d.path),
  ];
}

class EditedPaths {
  /**
   * @param {object} o
   * @param o.wanted (chatId) => boolean: the chat's edits are collected
   * @param o.chatOf (key) => chatId: a Claude Code or ACP session's chat (ChatController.chatOf)
   * @param o.requestChat (threadId) => chatId: a Codex thread's chat, a sub-agent's included (ChatController.requestChat)
   */
  constructor({ wanted, chatOf, requestChat }) {
    this.wanted = wanted;
    this.chatOf = chatOf;
    this.requestChat = requestChat;
    /** @type {Map<string, Set<string>>} chat -> edited paths since the last take */
    this.paths = new Map();
    /** @type {Map<string, Map<string, unknown[]>>} chat -> edit call id -> the paths it names, until it completes */
    this.pending = new Map();
  }

  /** One live event of a harness family, read by that family's reader below. */
  event(family, e) {
    const read = { codex: this.codex, claude: this.claude, acp: this.acp }[family];
    read?.call(this, e);
  }

  /** item/completed of a fileChange that applied: each change's path, and where a move put it. */
  codex(msg) {
    const p = msg?.params;
    if (msg?.method !== 'item/completed' || p?.item?.type !== 'fileChange' || p.item.status !== 'completed' || !p.threadId) return;
    const changes = Array.isArray(p.item.changes) ? p.item.changes : [];
    this.add(
      this.requestChat(p.threadId),
      changes.flatMap((c) => [c?.path, c?.kind?.move_path]),
    );
  }

  /** An edit tool_use waits for its tool_result, which counts it unless it is an error. A sub-agent's count too. */
  claude(e) {
    const m = e?.msg;
    if (e?.kind !== 'message' || !Array.isArray(m?.message?.content)) return;
    const chatId = this.chatOf(e.key);
    if (!this.wanted(chatId)) return;
    const calls = this.pendingOf(chatId);
    for (const b of m.message.content) {
      if (m.type === 'assistant' && b?.type === 'tool_use' && CLAUDE_EDITS.has(b.name) && isPath(b.id)) {
        const input = b.input ?? {};
        this.hold(calls, b.id, [input.file_path ?? input.path ?? input.notebook_path]);
      } else if (m.type === 'user' && b?.type === 'tool_result') {
        const paths = calls.get(b.tool_use_id);
        if (!paths) continue;
        calls.delete(b.tool_use_id);
        if (b.is_error !== true) this.add(chatId, paths);
      }
    }
  }

  /** A tool_call that changes files (an edit, a delete, a move, or one with a diff) and its updates; counted when one says it completed. */
  acp(e) {
    const u = e?.update;
    if (e?.kind !== 'update' || (u?.sessionUpdate !== 'tool_call' && u?.sessionUpdate !== 'tool_call_update') || !isPath(u.toolCallId))
      return;
    const chatId = this.chatOf(e.key);
    if (!this.wanted(chatId)) return;
    const calls = this.pendingOf(chatId);
    const known = calls.get(u.toolCallId);
    const diffs = contentBlocks(u.content).filter((c) => c?.type === 'diff');
    if (!known && !ACP_WRITES.has(u.kind) && !diffs.length) return;
    const paths = [...(known ?? []), ...acpPaths(u, diffs)];
    calls.delete(u.toolCallId);
    if (u.status === 'completed') this.add(chatId, paths);
    else if (u.status !== 'failed') this.hold(calls, u.toolCallId, paths);
  }

  /** @param {Map<string, unknown[]>} calls @param {string} id @param {unknown[]} paths */
  hold(calls, id, paths) {
    calls.set(id, paths);
    if (calls.size > MAX_PENDING) calls.delete(calls.keys().next().value);
  }

  /** @param {string} chatId */
  pendingOf(chatId) {
    let calls = this.pending.get(chatId);
    if (!calls) this.pending.set(chatId, (calls = new Map()));
    return calls;
  }

  /** @param {string} chatId @param {unknown[]} paths */
  add(chatId, paths) {
    if (!this.wanted(chatId)) return;
    const set = this.paths.get(chatId) ?? new Set();
    for (const p of paths) if (isPath(p) && set.size < MAX_PATHS) set.add(p);
    if (set.size) this.paths.set(chatId, set);
  }

  /**
   * The paths the chat edited since the last take, as its harness named them; the next take starts empty. A call still
   * waiting for its result counts in the take after it completes.
   * @param {string} chatId
   * @returns {string[]}
   */
  take(chatId) {
    const out = [...(this.paths.get(chatId) ?? [])];
    this.paths.delete(chatId);
    return out;
  }
}

module.exports = { EditedPaths, CLAUDE_EDITS, ACP_WRITES, MAX_PATHS, MAX_PENDING };
