// Capture a returning host handoff's model durably before startup, so failed starts and restarts retain its choice.
const { saveMeta } = require('../../shared/metaSave.mjs');
const { createHash } = require('node:crypto');
const { configuredSwitchModel } = require('../../shared/switchModel.mjs');

function captureContinueModel(r, chatId, continuation, before) {
  const record = r.chats.record(chatId);
  const owner = createHash('sha256')
    .update(JSON.stringify([before.kind, before.id, continuation.harness, continuation.cwd, continuation.text]))
    .digest('hex');
  const saved = record.meta?.continueModel;
  if (saved?.owner === owner && (saved.model === null || (typeof saved.model === 'string' && saved.model.trim()))) return saved.model;
  const config = record.meta?.config;
  const own = before.kind === continuation.harness && config && Object.hasOwn(config, 'model');
  const model = configuredSwitchModel(continuation.harness, own ? config.model : null, own ? undefined : r.prefs());
  if (!saveMeta(r.chats, chatId, { continueModel: { owner, model } })) throw new Error('The chat could not save its continuation model.');
  return model;
}

module.exports = { captureContinueModel };
