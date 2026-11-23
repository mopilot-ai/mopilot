// A chat keeps the model and effort it runs with: a new-chat default changed later (another chat's pick) never reaches it.
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

/**
 * Save the settings in `picked` the chat has none of yet into its meta.config; a key already there, even null, stays
 * (the chat's own pick, or one a window made meanwhile). Answers whether it wrote.
 * @param {{ records: Map<string, any>, patchMeta(id: string, patch: object): boolean }} chats
 * @param {string} chatId
 * @param {Record<string, unknown>} picked
 */
function keepSelection(chats, chatId, picked) {
  const record = chats.records.get(chatId);
  if (!record) return false;
  const config = isJsonRecord(record.meta?.config) ? record.meta.config : {};
  const missing = Object.entries(picked).filter(([k, v]) => v !== undefined && !(k in config));
  if (!missing.length) return false;
  return chats.patchMeta(chatId, { config: { ...config, ...Object.fromEntries(missing) } });
}

/** The settings a segment keeps for its harness when the chat moves on: its effort and tier, where the chat had them. */
function keptOf(config) {
  const c = isJsonRecord(config) ? config : {};
  return Object.fromEntries(['effort', 'serviceTier'].filter((k) => k in c).map((k) => [k, c[k]]));
}

/**
 * A chat's settings once it moves to another harness: the previous harness's model, effort and tier go (they mean
 * nothing there), the model the switch picked stays, and a harness the chat ran on before gets back what its segment
 * kept; the new harness's first turn keeps the rest.
 * @param {unknown} config
 * @param {string | null | undefined} model
 * @param {unknown} [kept] the target harness's earlier segment's keptOf
 * @param {string | null} [effort] the effort the switch picked: it wins over what the earlier segment kept
 */
function switchedConfig(config, model, kept, effort) {
  const { model: _model, effort: _effort, serviceTier: _tier, ...rest } = isJsonRecord(config) ? config : {};
  return { ...rest, ...(model || model === null ? { model } : {}), ...keptOf(kept), ...(effort ? { effort } : {}) };
}

module.exports = { keepSelection, keptOf, switchedConfig };
