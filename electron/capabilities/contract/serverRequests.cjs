// Requests the Codex app-server sends to its client. Every window sees every app-server message, so
// any request a window answered would be answered once per window; main answers them instead, once.
// Only the approval and user-input cards still go to the windows, where the user answers them.

const { noteIgnored } = require('../../ignored.cjs');
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');

/** Server requests the windows show as cards (src/components/thread/Approvals.tsx). */
const RENDERER_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'execCommandApproval',
  'applyPatchApproval',
]);

/** The legacy approval requests: they name their thread `conversationId` and take a ReviewDecision answer. */
const LEGACY_APPROVALS = new Set(['execCommandApproval', 'applyPatchApproval']);

/**
 * The thread a server request belongs to: `threadId`, or a legacy approval's `conversationId` (also a thread id).
 * @param {{ threadId?: string | null, conversationId?: string | null } | null | undefined} params
 * @returns {string | null}
 */
const requestThread = (params) => params?.threadId ?? params?.conversationId ?? null;

/**
 * Declining a request without asking the user: a legacy approval's ReviewDecision denial, or v2's `decline`.
 * @param {string} method
 */
const declineAnswer = (method) =>
  LEGACY_APPROVALS.has(method)
    ? { decision: { denied: { rejection: 'Declined: a background thread does not ask the user.' } } }
    : { decision: 'decline' };

/** Handlers that see each app-server message before the windows do; the first to return true consumes it. */
class InterceptChain {
  constructor() {
    this.handlers = [];
  }
  /** Adds a handler; returns a function that removes it. */
  add(fn) {
    this.handlers.push(fn);
    return () => {
      const i = this.handlers.indexOf(fn);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }
  handle(msg) {
    for (const fn of this.handlers) {
      try {
        if (fn(msg)) return true;
      } catch (error) {
        // a broken handler is a bug, but it must not stop the others: the request falls through to them
        noteIgnored('handle an app-server request in main (the next handler gets it)', error);
      }
    }
    return false;
  }
}

/** The server of the vendor's computer-use plugin (unified-computer-use@openai-bundled). */
const NATIVE_CUA_SERVER = 'cua_repl';

/**
 * On a native thread (the plugin on, capabilities/channels/codexConfig.cjs) a cua_repl elicitation
 * goes through to the windows' card, as Codex shows it. Elsewhere the plugin is switched off, so this
 * only fires if the switch stops working: the request is declined and the user told once per thread.
 * Goes ahead of the pass-through that would show the card.
 * @param {{ send: (msg: any) => void, notify: (threadId: string, text: string) => void,
 *           isNativeThread?: (threadId: string) => boolean }} o
 */
function rejectNativeCuaElicitation(o) {
  const told = new Set();
  return (msg) => {
    if (!msg || msg.method !== 'mcpServer/elicitation/request' || msg.id == null) return false;
    const p = msg.params || {};
    if (p.serverName !== NATIVE_CUA_SERVER) return false;
    if (o.isNativeThread?.(p.threadId)) return false;
    o.send({ id: msg.id, result: { action: 'decline', content: null, _meta: null } });
    if (!told.has(p.threadId)) {
      told.add(p.threadId);
      o.notify(
        p.threadId,
        "Declined a request from Codex's built-in computer use: it is off in this chat. MoPilot's computer use is used instead.",
      );
    }
    return true;
  };
}

/** A registry result as a Codex DynamicToolCallResponse. */
function toolCallResponse(res) {
  const contentItems = [];
  for (const c of contentBlocks(res.content)) {
    if (c.type === 'text') contentItems.push({ type: 'inputText', text: c.text });
    else if (c.type === 'image')
      contentItems.push({ type: 'inputImage', imageUrl: c.url || `data:${c.mimeType || 'image/png'};base64,${c.data}` });
  }
  if (!res.ok) contentItems.push({ type: 'inputText', text: res.error.message });
  return { contentItems, success: !!res.ok };
}

/**
 * The last link of the chain: answers every server request the windows don't handle. item/tool/call
 * for a registered tool runs through the registry; anything else gets one -32601.
 * @param {{ send: (msg: any) => void, registry: InstanceType<typeof import('./registry.cjs').Registry>,
 *           owner?: (threadId: string) => { chatId: string, segmentId: string } }} o
 */
function codexServerRequests(o) {
  // Until chats and segments live in main, a Codex thread is its own chat and segment.
  const owner = o.owner || ((threadId) => ({ chatId: threadId, segmentId: threadId }));
  return (msg) => {
    if (!msg || !msg.method || msg.id == null) return false;
    if (RENDERER_METHODS.has(msg.method)) return false;
    const p = msg.params || {};
    if (msg.method === 'item/tool/call' && o.registry.has(p.tool)) {
      const { chatId, segmentId } = owner(p.threadId);
      o.registry
        .invoke(chatId, segmentId, p.tool, p.arguments, { callId: p.callId })
        .then((res) => o.send({ id: msg.id, result: toolCallResponse(res) }));
      return true;
    }
    const what = msg.method === 'item/tool/call' ? o.registry.unknownMessage(p.tool) : 'Not supported by this client';
    o.send({ id: msg.id, error: { code: -32601, message: what } });
    return true;
  };
}

module.exports = {
  NATIVE_CUA_SERVER,
  rejectNativeCuaElicitation,
  RENDERER_METHODS,
  requestThread,
  declineAnswer,
  InterceptChain,
  codexServerRequests,
  toolCallResponse,
};
