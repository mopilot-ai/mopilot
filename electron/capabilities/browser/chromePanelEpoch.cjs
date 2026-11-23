// A panel card's opaque version follows SessionState's approval token, so a reused request id cannot accept a stale panel answer.
const { randomUUID } = require('node:crypto');
const versions = new WeakMap();
function versionOf(state, chatId, approval, owner) {
  const token = owner ?? state.approvalToken?.(chatId, approval.id) ?? approval;
  const shape = JSON.stringify([approval.method, approval.params]);
  let entry = versions.get(token);
  if (!entry || entry.shape !== shape) versions.set(token, (entry = { shape, version: randomUUID() }));
  return entry.version;
}
function currentApproval(state, chatId, approvalId, version) {
  const approval = state.get(chatId)?.approvals.find((a) => a.id === approvalId);
  return approval && versionOf(state, chatId, approval) === version ? approval : null;
}
module.exports = { versionOf, currentApproval };
