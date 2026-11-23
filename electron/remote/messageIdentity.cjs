// Main derives native input identity only from the authenticated phone and schema-normalized idempotency fields; caller-supplied native ids are never trusted.
const { createHash } = require('node:crypto');
const { messageIdentity } = require('../../shared/remote/messageIdentity.mjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest();
function ownedMessageParams(client, method, params) {
  const id = method === 'chat.send' ? params.sendId : method === 'chat.start' ? params.startId : null;
  if (client.kind !== 'phone' || !id) return params;
  return { ...params, nativeMessageId: messageIdentity(hash, client.pairId, method, method === 'chat.send' ? params.chatId : null, id) };
}
module.exports = { ownedMessageParams };
