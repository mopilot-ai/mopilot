// Native ACP tool permissions remain separate from form questions, including the existing own-tool allow-once policy; a
// chat kept apart from the coding side (MoMo's) has every native tool refused without a card (acp/isolation.cjs).
const crypto = require('node:crypto');
const { isSageToolCall, isForeignSageCall, allowOnce } = require('./clientMethods.cjs');
const { refusal } = require('./isolation.cjs');

function requestPermission(host, chat, params) {
  const options = Array.isArray(params.options) ? params.options : [];
  // another chat's MoPilot tools are never reachable from this one: refused without a card (#2311, #2302)
  if (isForeignSageCall(params.toolCall, chat.serverName)) return refusal(options);
  // MoPilot's own tools are authorized in their handlers, so the harness's card is skipped
  if (isSageToolCall(params.toolCall, chat.serverName)) {
    const o = allowOnce(options);
    if (o) return { outcome: { outcome: 'selected', optionId: o.optionId } };
  }
  // MoMo's chats use MoMo's tools only: the harness's own shell, file and web tools are refused, never asked about
  if (chat.isolated) return refusal(options);
  if (!chat.prompting) {
    host.unattended(chat, 'permission');
    return { outcome: { outcome: 'cancelled' } };
  }
  const requestId = `acpperm-${++host.permSeq}-${crypto.randomUUID().slice(0, 8)}`;
  void host.items.flush?.(chat.key); // the turn may wait here long: what it did so far goes to disk now
  return new Promise((resolve) => {
    host.perms.set(requestId, { key: chat.key, resolve });
    host.emitEvent({
      key: chat.key,
      kind: 'permission',
      requestId,
      turnId: chat.prompting.turnId,
      toolCall: params.toolCall ?? null,
      options,
    });
  });
}

module.exports = { requestPermission };
