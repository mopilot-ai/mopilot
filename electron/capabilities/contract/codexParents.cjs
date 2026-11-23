// The one map of Codex sub-agent threads to the threads that spawned them, read from every signal the app-server sends; the tool injection, the plugin lifecycle and the chat controller all resolve a child's parent here.
const { isCodexAgentSpawn, canLinkCodexChild } = require('../../../shared/codexAgentRelations.mjs');

/**
 * The links a message makes, as [child, parent] pairs: `thread/started` naming a parent
 * (`parentThreadId`, or `source.subAgent.thread_spawn.parent_thread_id`), a spawnAgent collab call naming
 * the threads it started, and a subAgentActivity item naming the agent thread it reports on.
 * @param {any} msg
 * @returns {[string, string][]}
 */
function codexParentLinks(msg) {
  const p = msg?.params;
  if (!p || msg.id != null) return [];
  if (msg.method === 'thread/started') {
    const t = p.thread;
    const parent = t?.parentThreadId ?? t?.source?.subAgent?.thread_spawn?.parent_thread_id;
    return typeof t?.id === 'string' && typeof parent === 'string' ? [[t.id, parent]] : [];
  }
  if ((msg.method !== 'item/started' && msg.method !== 'item/completed') || typeof p.threadId !== 'string') return [];
  const item = p.item;
  if (isCodexAgentSpawn(item) && Array.isArray(item.receiverThreadIds))
    return item.receiverThreadIds.filter((id) => typeof id === 'string').map((id) => [id, p.threadId]);
  if (item?.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') return [[item.agentThreadId, p.threadId]];
  return [];
}

/**
 * Sub-agent thread -> the thread that spawned it. Links are first-writer and acyclic (canLinkCodexChild): a
 * later message can't move a child to another parent. Each consumer applies its own rules on top (a loaded
 * thread is never a sub-agent of another; a thread that is a chat of its own asks in its own chat).
 */
class CodexThreadParents {
  constructor() {
    /** @type {Map<string, string>} */
    this.parents = new Map();
  }

  /**
   * Records the links a message makes, and returns the ones of them that hold: new, or already recorded
   * (several consumers observe the same message on one shared map, in any order).
   * @returns {[string, string][]}
   */
  observe(msg) {
    if (msg?.method === 'thread/closed' && typeof msg.params?.threadId === 'string') {
      this.forget(msg.params.threadId);
      return [];
    }
    const held = [];
    for (const [child, parent] of codexParentLinks(msg)) {
      if (canLinkCodexChild(child, parent, this.parents)) this.parents.set(child, parent);
      if (this.parents.get(child) === parent) held.push([child, parent]);
    }
    return held;
  }

  /** The thread that spawned `id`, or null. */
  parentOf(id) {
    return this.parents.get(id) ?? null;
  }

  /** The top of `id`'s spawn chain (itself when nothing spawned it). */
  rootOf(id) {
    let key = id;
    while (this.parents.has(key)) key = /** @type {string} */ (this.parents.get(key));
    return key;
  }

  /**
   * A thread that went away is no one's child any more. Its own children keep their link: a background
   * agent may still ask after the thread that spawned it was unloaded, and it asks in that thread's chat.
   */
  forget(id) {
    this.parents.delete(id);
  }

  /** The app-server exited: every thread went with it. */
  clear() {
    this.parents.clear();
  }
}

module.exports = { CodexThreadParents, codexParentLinks };
