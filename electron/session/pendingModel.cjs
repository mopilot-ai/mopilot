// Apply a model or effort pending-switch edit at main's current state, preserving other windows' account and handoff choices.
const { configuredSwitchModel } = require('../../shared/switchModel.mjs');
const { modelLabel } = require('../../shared/modelLabels.mjs');

function pickPendingModel(state, chatId, harness, model, effort = null) {
  if (typeof chatId !== 'string' || !chatId || typeof harness !== 'string' || (model !== null && typeof model !== 'string')) return false;
  const pending = state.get(chatId).pendingSwitch;
  if (!pending || pending.harness !== harness) return false;
  const selected = configuredSwitchModel(harness, model);
  state.patch(chatId, {
    pendingSwitch: {
      ...pending,
      model: selected,
      modelLabel: selected ? modelLabel(selected) : '',
      effort: typeof effort === 'string' ? effort : null,
    },
  });
  return true;
}

module.exports = { pickPendingModel };
