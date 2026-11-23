// Phone upload capabilities belong to the exact paired client generation; only that client may use its opaque attachment ids in an explicitly chosen chat.
const { randomUUID } = require('node:crypto');
const { RemoteError } = require('./serviceErrors.cjs');
const streams = new WeakMap();
const files = new WeakMap();
function uploadOwner(client) {
  if (!streams.has(client)) streams.set(client, randomUUID());
  return streams.get(client);
}
function remembered(service, client) {
  if (!files.has(service)) files.set(service, new WeakMap());
  const owners = files.get(service);
  if (!owners.has(client)) owners.set(client, new Set());
  return owners.get(client);
}
function rememberAttachment(service, client, result) {
  service.assertPaired(client);
  if (client.kind === 'phone' && typeof result?.id === 'string') {
    const owned = remembered(service, client);
    owned.add(result.id);
    if (owned.size > 1000) owned.delete(owned.values().next().value);
  }
  return result;
}
function requireAttachments(service, client, ids) {
  if (client.kind !== 'phone' || !ids?.length) return;
  service.assertPaired(client);
  const owned = remembered(service, client);
  if (ids.some((id) => !owned.has(id))) throw new RemoteError('forbidden', 'Attach that file again from this device.');
}
module.exports = { uploadOwner, rememberAttachment, requireAttachments };
