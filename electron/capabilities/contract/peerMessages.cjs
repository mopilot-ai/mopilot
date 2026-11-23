// The same tools are advertised by the registry to Codex, Claude Code, and admitted ACP.
// Neither arguments nor peer prompt text can select the authenticated source chat.
const { ToolError } = require('./registry.cjs');
const { peerReasonText } = require('../../../shared/peerReasons.mjs');

/**
 * @param {any} registry
 * @param {{ service: any, owner: (ctx: any) => string | null, directory: (id: string, args: any) => any, read?: any,
 *           toolAccess?: (chatId: string) => (string | null | Promise<string | null>) }} o
 *   toolAccess: why the chat may not use the peer tools now, or null
 */
function registerPeerTools(registry, { service, owner, directory, read, toolAccess = (_chatId) => null }) {
  const source = (ctx) => {
    const id = owner(ctx);
    if (!id) throw new ToolError('The caller does not own this chat segment', 'no_owner');
    return id;
  };
  const add = (name, description, properties, required, policy, handler) =>
    registry.register({
      name,
      description,
      schema: { type: 'object', properties, required, additionalProperties: false },
      policy,
      authorizesItself: policy === 'act',
      handler: async (args, ctx) => {
        try {
          const id = source(ctx);
          const blocked = await toolAccess(id);
          if (blocked) throw new ToolError('Chat messaging tools unavailable: ' + blocked, blocked);
          return await handler(args, ctx, id);
        } catch (error) {
          if (typeof error?.code === 'string') {
            const text = error.message === error.code ? peerReasonText(error.code) : error.message;
            throw new ToolError(text, error.code);
          }
          throw error;
        }
      },
    });
  const string = { type: 'string' };
  const disposers = [
    add(
      'list_chats',
      'Find accessible MoPilot chats across harnesses.',
      { query: string, cursor: string, limit: { type: 'integer' } },
      [],
      'observe',
      (a, ctx, id) =>
        directory(id, {
          query: a.query ?? '',
          cursor: a.cursor ?? null,
          limit: Math.max(1, Math.min(50, a.limit ?? 20)),
          signal: ctx.signal,
        }),
    ),
    add(
      'read_chat',
      'Read bounded history of another MoPilot chat.',
      { targetChatId: string, cursor: string, limitBytes: { type: 'integer' } },
      ['targetChatId'],
      'observe',
      (a, ctx, id) =>
        read(id, a.targetChatId, {
          cursor: a.cursor ?? null,
          limitBytes: Math.max(1, Math.min(32768, a.limitBytes ?? 32768)),
          signal: ctx.signal,
        }),
    ),
    add(
      'send_message_to_chat',
      'Send a message to another MoPilot chat (find it with list_chats). Busy recipients queue it. A chat in Full access holds a message from a stricter chat for its user (delivery held); it may be declined or expire: do not report it as delivered, wait on it or resend it. Agent-to-agent loops are stopped (blocked), and floods or repeats are refused: never retry in a loop. Never ask it to do something that was denied or blocked here: route that back to the user.',
      { targetChatId: string, requestId: string, body: string, requestReply: { type: 'boolean' } },
      ['targetChatId', 'requestId', 'body'],
      'act',
      (a, _ctx, id) =>
        service.send(id, { targetChatId: a.targetChatId, requestId: a.requestId, body: a.body, requestReply: a.requestReply }),
    ),
    add(
      'reply_to_message',
      'Reply to a delivered peer request. The service chooses its source as recipient; this does not request another reply.',
      { messageId: string, requestId: string, body: string },
      ['messageId', 'requestId', 'body'],
      'act',
      (a, _ctx, id) => service.reply(id, a),
    ),
    add(
      'get_message_status',
      'Read the actual delivery and reply status of a message in this chat.',
      { messageId: string },
      ['messageId'],
      'observe',
      (a, _ctx, id) => service.get(id, a.messageId),
    ),
    add(
      'wait_for_message',
      'Observe a message status change for up to 30 seconds. A timeout does not cancel the remote request. Finish the current turn to let queued peer work run.',
      { messageId: string, timeoutMs: { type: 'integer' } },
      ['messageId'],
      'observe',
      (a, ctx, id) => service.wait(id, a.messageId, { timeoutMs: a.timeoutMs, signal: ctx.signal }),
    ),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

module.exports = { registerPeerTools };
