// ACP title sessions (#2150): a chat's title is written in a hidden session on the chat's own agent, then let go. Its
// updates and requests never reach a chat: its message text is collected, its permission asks are cancelled and no
// client method (files, terminals) is served to it. It runs only in a mode that reads or asks (the quirks' anchors).
const { titlePrompt } = require('../../../shared/title.mjs');
const { noteIgnored } = require('../../ignored.cjs');
const { RpcError } = require('./rpc.cjs');

class AcpTitleSessions {
  constructor() {
    /** agent instance -> native session id -> { text } */
    this.open = new Map();
    /** chat key -> its latest title record written in this run, read without a transcript read a rename could slip past */
    this.latest = new Map();
  }

  /** The collector of a title session, or null. */
  of(agent, sessionId) {
    return (typeof sessionId === 'string' && this.open.get(agent)?.get(sessionId)) || null;
  }

  /**
   * A title for `prompt`, written by `agent` in a session of its own (no MCP servers) in `cwd`; null when it answers
   * nothing or offers no mode that reads or asks. Rejects when the agent refuses the session, the mode or the prompt,
   * or takes longer than `timeoutMs` for one of them.
   * @param {any} agent an initialized AcpAgent
   * @param {string} cwd
   * @param {string} prompt the chat's first message
   * @param {number} timeoutMs
   * @param {Record<string, string>} [anchors] the quirks' mode id → readOnly | ask | auto | full (unlisted: ask)
   * @returns {Promise<string | null>}
   */
  async write(agent, cwd, prompt, timeoutMs, anchors = {}) {
    const res = await agent.request('session/new', { cwd, mcpServers: [] }, { timeoutMs });
    const sessionId = res?.sessionId;
    if (typeof sessionId !== 'string') return null;
    const mode = safeMode(res?.modes, anchors);
    if (mode === null) {
      // the agent would act on the request on its own (its user chose that mode): no title from it
      this.release(agent, sessionId, true);
      return null;
    }
    const out = { text: '' };
    let sessions = this.open.get(agent);
    if (!sessions) this.open.set(agent, (sessions = new Map()));
    sessions.set(sessionId, out);
    let answered = false;
    try {
      if (mode) await agent.request('session/set_mode', { sessionId, modeId: mode }, { timeoutMs });
      await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: titlePrompt(prompt) }] }, { timeoutMs });
      answered = true;
      return out.text.trim() || null;
    } finally {
      sessions.delete(sessionId);
      if (!sessions.size) this.open.delete(agent);
      this.release(agent, sessionId, answered);
    }
  }

  /** The agent stops a title session it still works on, and closes it when it can (session/close is optional). */
  release(agent, sessionId, answered) {
    try {
      if (!answered) agent.notify('session/cancel', { sessionId });
      if (agent.caps?.close)
        agent.request('session/close', { sessionId }).catch((error) => noteIgnored('close an ACP title session', error));
    } catch (error) {
      // the agent already exited
      noteIgnored('let go of an ACP title session', error);
    }
  }

  /** A notification from a title session: its message text is kept. True when it was one (no chat sees it). */
  take(agent, method, params) {
    const out = this.of(agent, params?.sessionId);
    if (!out) return false;
    const u = params?.update;
    if (method === 'session/update' && u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text')
      out.text += typeof u.content.text === 'string' ? u.content.text : '';
    return true;
  }

  /**
   * A request from a title session: a permission ask is cancelled and anything else refused. Undefined for a request
   * from any other session.
   */
  answer(agent, method, params) {
    if (!this.of(agent, params?.sessionId)) return undefined;
    if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
    throw new RpcError(-32601, `A title session can't use ${method}`);
  }
}

/**
 * The mode a title session switches to: its read-only one when it offers one (a mode id), none when it already reads
 * or asks before acting ('' : its permission asks are cancelled here), or null when it would act on its own.
 * @returns {string | null}
 */
function safeMode(modes, anchors) {
  const current = typeof modes?.currentModeId === 'string' ? modes.currentModeId : null;
  const anchor = (id) => anchors[id] ?? 'ask';
  if (current === null || anchor(current) === 'readOnly') return '';
  const ids = Array.isArray(modes?.availableModes) ? modes.availableModes.map((m) => m?.id).filter((id) => typeof id === 'string') : [];
  const reads = ids.find((id) => anchor(id) === 'readOnly');
  if (reads) return reads;
  return anchor(current) === 'ask' ? '' : null;
}

module.exports = { AcpTitleSessions, safeMode };
