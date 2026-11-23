// Grok's native ACP extension envelopes become ordinary updates; replay stays out of the live transcript.
const { acpModelCatalog } = require('../../../shared/acpModels.mjs');
const normalizeUpdate = (update, meta) => (meta?.isReplay === true ? null : update);
const envelope = (params) => ({ update: normalizeUpdate(params?.update, params?._meta) });

/** Grok can advertise the model catalog before it creates a session. Never guess model or effort ids. */
async function readModels(agent) {
  const initial = acpModelCatalog(agent.init?._meta?.modelState);
  if (initial) return initial;
  const reply = await agent.request('x.ai/models/list', {}, { timeoutMs: 10_000 });
  const models = acpModelCatalog(reply?.result);
  if (reply?.error != null || !models) throw new Error('Grok did not list its models');
  return models;
}

module.exports = {
  readModels,
  normalizeUpdate,
  extensions: Object.fromEntries(
    ['x.ai/session_notification', 'x.ai/session/update'].flatMap((method) => [
      [method, envelope],
      [`_${method}`, envelope],
    ]),
  ),
};
